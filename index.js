import express from "express";
import jwt from "jsonwebtoken";
import multer from "multer";
import { createHash } from "node:crypto";
import https from "node:https";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { copyFile, rename, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const MD5_FILE_RE = /^[a-fA-F0-9]{32}\.[A-Za-z0-9]+$/;
const TOKEN_MAX_AGE_SEC = 3600;
const PEER_CONNECT_TIMEOUT_MS = 8_000;
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const CONTENT_TYPES = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  mp4: "video/mp4",
  webm: "video/webm",
  mkv: "video/x-matroska",
  oga: "audio/ogg",
  ogg: "audio/ogg",
  mp3: "audio/mpeg",
};

function loadEnv(filePath) {
  if (!existsSync(filePath)) return;

  for (const rawLine of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function parseServer(value) {
  if (!value) return null;

  let rest = value;
  const at = value.lastIndexOf("@");
  if (at !== -1) rest = value.slice(at + 1);

  const colon = rest.indexOf(":");
  const slash = rest.indexOf("/");
  let host;
  let remotePath;

  if (colon !== -1 && (slash === -1 || colon < slash)) {
    host = rest.slice(0, colon);
    remotePath = rest.slice(colon + 1);
  } else if (slash !== -1) {
    host = rest.slice(0, slash);
    remotePath = rest.slice(slash);
  } else {
    host = rest;
    remotePath = "";
  }

  return { host, path: remotePath.replace(/\/+$/, "") || "" };
}

function isMd5Filename(name) {
  return MD5_FILE_RE.test(name);
}

function isMainServerHere() {
  return String(process.env.MAIN_SERVER_HERE ?? "").trim() === "1";
}

function resolveDataDir(root) {
  const raw = process.env.DATA_DIR?.trim();
  const dir = raw || join(root, "data");
  return dir.replace(/\/+$/, "") || "/";
}

function shardedPath(dir, filename) {
  const hash = filename.slice(0, 32).toLowerCase();
  return join(dir, hash.slice(0, 2), hash.slice(2, 4), filename);
}

function existingFile(filePath) {
  if (!filePath) return null;
  try {
    if (existsSync(filePath) && statSync(filePath).isFile()) return filePath;
  } catch {
    return null;
  }
  return null;
}

function localStorageRoots(appRoot) {
  const roots = [];
  const seen = new Set();
  const add = (dir) => {
    if (!dir || seen.has(dir)) return;
    seen.add(dir);
    roots.push(dir);
  };

  if (!isMainServerHere()) {
    const parsed = parseServer(process.env.MAIN_SERVER?.trim());
    add(parsed?.path);
  }
  add(resolveDataDir(appRoot));
  return roots;
}

function findOwnFile(appRoot, filename) {
  const roots = localStorageRoots(appRoot);
  for (const dir of roots) {
    const nested = existingFile(shardedPath(dir, filename));
    if (nested) return nested;
  }
  for (const dir of roots) {
    const flat = existingFile(join(dir, filename));
    if (flat) return flat;
  }
  return null;
}

function listPeerHosts() {
  const peers = [];
  const seen = new Set();

  const add = (name, raw) => {
    const parsed = parseServer(raw?.trim());
    if (!parsed?.host) return;
    if (seen.has(parsed.host)) return;
    seen.add(parsed.host);
    peers.push({ name, host: parsed.host });
  };

  add("MAIN", process.env.MAIN_SERVER);
  const numbered = [];
  for (const [key, value] of Object.entries(process.env)) {
    const match = key.match(/^SERVER_(\d+)$/);
    if (!match || !value?.trim()) continue;
    numbered.push({ index: Number(match[1]), key, value: value.trim() });
  }
  numbered.sort((a, b) => a.index - b.index);
  for (const item of numbered) add(item.key, item.value);

  return peers;
}

function isLoopbackHost(host) {
  const normalized = String(host || "").toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "0.0.0.0"
  );
}

function contentTypeFor(filename) {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  return CONTENT_TYPES[ext] || "application/octet-stream";
}

function readAccessToken(req) {
  const header = req.headers.authorization;
  if (!header) return null;
  const value = String(header).trim();
  if (value.toLowerCase().startsWith("bearer ")) {
    return value.slice(7).trim() || null;
  }
  return value || null;
}

function requireAuth(req, res, next) {
  const token = readAccessToken(req);
  if (!token) {
    res.status(401).json({ message: "Unauthorized" });
    return;
  }

  try {
    verifyAccessToken(token);
    next();
  } catch (err) {
    if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError" || err.status === 401) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }
    next(err);
  }
}

function fileExtension(originalName) {
  const base = String(originalName || "").split(/[\\/]/).pop() || "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  if (!/^[a-z0-9]+$/.test(ext)) return null;
  return ext;
}

async function hashFileMd5(filePath) {
  const hash = createHash("md5");
  await pipeline(createReadStream(filePath), hash);
  return hash.digest("hex");
}

async function moveUploadedFile(src, dest) {
  try {
    await rename(src, dest);
  } catch (err) {
    if (err.code !== "EXDEV") throw err;
    await copyFile(src, dest);
    await unlink(src);
  }
}

function verifyAccessToken(token) {
  const salt = process.env.JWT_SALT?.trim();
  if (!salt) {
    const err = new Error("JWT_SALT is not set");
    err.status = 500;
    throw err;
  }

  const payload = jwt.verify(token, salt, { algorithms: ["HS256"] });
  const now = Math.floor(Date.now() / 1000);
  const iat = Number(payload?.iat);

  if (Number.isFinite(iat) && now - iat > TOKEN_MAX_AGE_SEC) {
    const err = new Error("Token expired");
    err.status = 401;
    throw err;
  }

  if (!Number.isFinite(iat) && payload?.exp == null) {
    const err = new Error("Token has no lifetime");
    err.status = 401;
    throw err;
  }

  return payload;
}

function sendLocalFile(res, filePath, filename) {
  const { size } = statSync(filePath);
  res.status(200);
  res.setHeader("Content-Type", contentTypeFor(filename));
  res.setHeader("Content-Length", String(size));
  res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
  createReadStream(filePath).pipe(res);
}

let peerHttpsOptions = { rejectUnauthorized: true };

function requestPeerFile(host, port, filename, authorization) {
  return new Promise((resolve) => {
    const req = https.get(
      {
        hostname: host,
        port,
        path: `/files/${encodeURIComponent(filename)}?only_own=1`,
        headers: { authorization, accept: "*/*" },
        ...peerHttpsOptions,
      },
      (peerRes) => {
        req.setTimeout(0);
        if (peerRes.statusCode !== 200) {
          peerRes.resume();
          resolve(null);
          return;
        }
        resolve({ req, peerRes });
      },
    );

    req.setTimeout(PEER_CONNECT_TIMEOUT_MS, () => {
      req.destroy();
      resolve(null);
    });
    req.on("error", () => resolve(null));
  });
}

function pipePeerToClient(clientReq, clientRes, peer) {
  clientRes.status(200);
  const contentType = peer.peerRes.headers["content-type"];
  if (contentType) clientRes.setHeader("Content-Type", contentType);
  const contentLength = peer.peerRes.headers["content-length"];
  if (contentLength) clientRes.setHeader("Content-Length", contentLength);
  const disposition = peer.peerRes.headers["content-disposition"];
  if (disposition) clientRes.setHeader("Content-Disposition", disposition);

  const abort = () => {
    peer.req.destroy();
  };
  clientReq.on("close", abort);
  peer.peerRes.on("error", abort);
  peer.peerRes.pipe(clientRes);
}

function resolveSslPath(raw, fallback) {
  const value = String(raw || fallback).trim() || fallback;
  return value.startsWith("/") ? value : join(root, value);
}

const root = dirname(fileURLToPath(import.meta.url));
loadEnv(join(root, ".env"));

const sslKeyPath = resolveSslPath(process.env.SSL_KEY, "certs/server.key");
const sslCertPath = resolveSslPath(process.env.SSL_CERT, "certs/server.crt");
const sslCaPath = resolveSslPath(process.env.SSL_CA, "certs/ca.crt");

if (!existsSync(sslKeyPath) || !existsSync(sslCertPath)) {
  console.error("TLS certificate files are missing.");
  console.error(`Expected key:  ${sslKeyPath}`);
  console.error(`Expected cert: ${sslCertPath}`);
  console.error("Run ./generate-ssl.sh first.");
  process.exit(1);
}

const sslOptions = {
  key: readFileSync(sslKeyPath),
  cert: readFileSync(sslCertPath),
};

if (existsSync(sslCaPath)) {
  const ca = readFileSync(sslCaPath);
  sslOptions.ca = ca;
  peerHttpsOptions = { ca, rejectUnauthorized: true };
}

const app = express();
const PORT = Number(process.env.PORT) || 54111;
const uploadDir = join(tmpdir(), "storage-uploads");
mkdirSync(uploadDir, { recursive: true });
const upload = multer({
  dest: uploadDir,
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

function acceptUpload(req, res, next) {
  upload.any()(req, res, (err) => {
    if (!err) {
      next();
      return;
    }
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({ message: "File too large" });
        return;
      }
      res.status(400).json({ message: err.message });
      return;
    }
    next(err);
  });
}

app.post("/upload-file", requireAuth, acceptUpload, async (req, res, next) => {
  const uploaded = req.files?.[0];
  const tmpPath = uploaded?.path;
  try {
    if (!uploaded) {
      res.status(400).json({ message: "No file uploaded" });
      return;
    }

    const ext = fileExtension(uploaded.originalname);
    if (!ext) {
      res.status(400).json({ message: "File must have an alphanumeric extension" });
      return;
    }

    const md5 = await hashFileMd5(tmpPath);
    const filename = `${md5}.${ext}`;
    const destPath = shardedPath(resolveDataDir(root), filename);
    mkdirSync(dirname(destPath), { recursive: true });

    if (!existingFile(destPath)) {
      await moveUploadedFile(tmpPath, destPath);
    }

    res.status(200).json({ filename });
  } catch (err) {
    next(err);
  } finally {
    if (tmpPath && existsSync(tmpPath)) {
      try {
        unlinkSync(tmpPath);
      } catch {
        // ignore
      }
    }
  }
});

app.get("/files/:filename", requireAuth, async (req, res, next) => {
  try {
    const filename = req.params.filename;
    if (!isMd5Filename(filename)) {
      res.status(400).json({ message: "Invalid filename" });
      return;
    }

    const onlyOwn = String(req.query.only_own ?? "") === "1";
    const ownFile = findOwnFile(root, filename);
    if (ownFile) {
      sendLocalFile(res, ownFile, filename);
      return;
    }
    if (onlyOwn) {
      res.status(404).json({ message: "File not found" });
      return;
    }

    const authorization = req.headers.authorization;
    for (const peer of listPeerHosts()) {
      if (isLoopbackHost(peer.host)) continue;

      const remote = await requestPeerFile(peer.host, PORT, filename, authorization);
      if (!remote) continue;
      pipePeerToClient(req, res, remote);
      return;
    }

    res.status(404).json({ message: "File not found" });
  } catch (err) {
    next(err);
  }
});

https.createServer(sslOptions, app).listen(PORT, () => {
  console.log(`Storage server listening on https://localhost:${PORT}`);
});
