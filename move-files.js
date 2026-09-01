import { spawn } from "node:child_process";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const MIN_FREE_PERCENT = 10;
const SSH_TIMEOUT_MS = 15_000;
const LIST_TIMEOUT_MS = 60_000;
const MD5_FILE_RE = /^[a-fA-F0-9]{32}\.[A-Za-z0-9]+$/;

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

function fail(message) {
  console.error(message);
  process.exit(1);
}

function shQuote(value) {
  return JSON.stringify(String(value));
}

function parseServer(value) {
  if (!value) return null;

  let user = "";
  let rest = value;
  const at = value.lastIndexOf("@");
  if (at !== -1) {
    user = value.slice(0, at);
    rest = value.slice(at + 1);
  }

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

  return { user, host, path: remotePath };
}

function normalizeRemotePath(remotePath) {
  const trimmed = String(remotePath || "").trim();
  if (!trimmed || trimmed === "/") return "/";
  return trimmed.replace(/\/+$/, "");
}

function isMd5Filename(name) {
  return MD5_FILE_RE.test(name);
}

function destRelativePath(filename) {
  const hash = filename.slice(0, 32).toLowerCase();
  return `${hash.slice(0, 2)}/${hash.slice(2, 4)}/${filename}`;
}

function parseBatchSize(raw) {
  const n = Number.parseInt(raw ?? "100", 10);
  if (!Number.isInteger(n) || n < 1) {
    fail("BATCH_SIZE must be a positive integer");
  }
  return n;
}

function parseConcurrency(raw) {
  const n = Number.parseInt(raw ?? "10", 10);
  if (!Number.isInteger(n) || n < 1) {
    fail("CONCURRENCY must be a positive integer");
  }
  return n;
}

async function mapPool(items, concurrency, worker) {
  if (items.length === 0) return;
  const limit = Math.min(concurrency, items.length);
  let next = 0;

  async function run() {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => run()));
}

function isMainServerHere(raw) {
  return String(raw ?? "").trim() === "1";
}

function resolveDataDir(root) {
  const raw = process.env.DATA_DIR?.trim();
  const dir = raw || join(root, "data");
  return dir.replace(/\/+$/, "") || "/";
}

function listEnvServers() {
  const found = [];
  for (const [key, value] of Object.entries(process.env)) {
    const match = key.match(/^SERVER_(\d+)$/);
    if (!match || !value?.trim()) continue;

    found.push({
      index: Number(match[1]),
      name: key,
      raw: value.trim(),
      password: process.env[`${key}_PASS`],
      keyFile: process.env[`${key}_KEY_FILE`]?.trim() || "",
      userOverride: process.env[`${key}_USER`]?.trim() || "",
    });
  }
  found.sort((a, b) => a.index - b.index);
  return found;
}

function buildDfCommand(remotePath) {
  const quoted = shQuote(remotePath);
  return [
    `p=${quoted}`,
    "p=${p%/}",
    '[ -n "$p" ] || p=/',
    "while true; do",
    '  if out=$(df -P "$p" 2>/dev/null); then',
    '    printf "%s\\n" "$out" | tail -n 1',
    "    exit 0",
    "  fi",
    '  [ "$p" = "/" ] && exit 1',
    "  p=${p%/*}",
    '  [ -n "$p" ] || p=/',
    "done",
  ].join("\n");
}

function localDfLine(targetPath) {
  return new Promise((resolve, reject) => {
    const child = spawn("df", ["-P", targetPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `df exited with code ${code}`));
        return;
      }
      const line = stdout.trim().split(/\r?\n/).pop();
      resolve(line || "");
    });
  });
}

function parseDfLine(line) {
  const match = String(line)
    .trim()
    .match(/(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+\S/);
  if (!match) return null;

  const size = Number(match[1]);
  const available = Number(match[3]);
  if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(available)) {
    return null;
  }

  return {
    size,
    available,
    freePercent: (available / size) * 100,
  };
}

function buildListCommand(remotePath, batchSize) {
  const quoted = shQuote(remotePath);
  return `d=${quoted}; { find "$d" -maxdepth 1 -type f; find "$d" -mindepth 3 -maxdepth 3 -type f; } 2>/dev/null | awk -F/ '$NF ~ /^[a-fA-F0-9]{32}\\.[A-Za-z0-9]+$/' | head -n ${Number(batchSize)}`;
}

class SshTarget {
  constructor({ name, user, host, path, keyFile, password }) {
    this.name = name;
    this.user = user;
    this.host = host;
    this.path = normalizeRemotePath(path);
    this.keyFile = keyFile || "";
    this.password = password || "";
    this.controlPath = join(tmpdir(), `mf-${process.pid}-%C`);
    this.askpassPath = null;
    this.connected = false;
  }

  destination() {
    return `${this.user}@${this.host}`;
  }

  sshArgs(extra = [], { multiplex = true } = {}) {
    const args = [
      "-o",
      "ConnectTimeout=10",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "LogLevel=ERROR",
    ];

    if (multiplex) {
      args.push(
        "-o",
        `ControlPath=${this.controlPath}`,
        "-o",
        "ControlMaster=auto",
        "-o",
        "ControlPersist=60",
      );
    }

    if (this.keyFile) {
      args.push(
        "-i",
        this.keyFile,
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "BatchMode=yes",
      );
    } else if (this.password) {
      args.push(
        "-o",
        "NumberOfPasswordPrompts=1",
        "-o",
        "PreferredAuthentications=password,keyboard-interactive",
      );
    } else {
      args.push("-o", "BatchMode=yes");
    }

    args.push(...extra);
    return args;
  }

  sshEnv() {
    const env = { ...process.env };
    if (!this.keyFile && this.password) {
      if (!this.askpassPath) {
        this.askpassPath = join(tmpdir(), `askpass-${process.pid}-${this.host}.sh`);
        writeFileSync(
          this.askpassPath,
          `#!/bin/sh\nprintf '%s\\n' ${shQuote(this.password)}\n`,
        );
        chmodSync(this.askpassPath, 0o700);
      }
      env.DISPLAY = env.DISPLAY || ":0";
      env.SSH_ASKPASS = this.askpassPath;
      env.SSH_ASKPASS_REQUIRE = "force";
    }
    return env;
  }

  spawn(command, { stdin, multiplex = true } = {}) {
    if (this.keyFile && !existsSync(this.keyFile)) {
      throw new Error(`SSH key file not found: ${this.keyFile}`);
    }

    const args = this.sshArgs([], { multiplex });
    args.push(this.destination(), command);

    return spawn("ssh", args, {
      env: this.sshEnv(),
      stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"],
    });
  }

  exec(command, { timeout = SSH_TIMEOUT_MS, stdin = null } = {}) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = this.spawn(command, { stdin: Boolean(stdin) });
      } catch (err) {
        reject(err);
        return;
      }

      const stdoutChunks = [];
      const stderrChunks = [];
      child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
      child.stderr.on("data", (chunk) => stderrChunks.push(chunk));

      if (stdin) {
        if (typeof stdin.pipe === "function") {
          stdin.pipe(child.stdin);
        } else {
          child.stdin.end(stdin);
        }
      }

      let settled = false;
      const timer =
        timeout > 0
          ? setTimeout(() => {
              child.kill("SIGKILL");
            }, timeout)
          : null;

      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (err) reject(err);
        else resolve(value);
      };

      child.on("error", (err) => finish(err));
      child.on("close", (code, signal) => {
        const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
        const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
        if (signal === "SIGKILL") {
          finish(new Error(`SSH connection to ${this.host} timed out`));
          return;
        }
        if (code === 0) {
          this.connected = true;
          finish(null, stdout);
          return;
        }
        finish(new Error(stderr || `ssh exited with code ${code}`));
      });
    });
  }

  async connect() {
    await this.exec("echo ok");
  }

  async close() {
    if (this.connected) {
      await new Promise((resolve) => {
        const child = spawn(
          "ssh",
          this.sshArgs(["-O", "exit", this.destination()]),
          {
            env: this.sshEnv(),
            stdio: "ignore",
          },
        );
        child.on("close", () => resolve());
        child.on("error", () => resolve());
      });
      this.connected = false;
    }

    if (this.askpassPath) {
      try {
        unlinkSync(this.askpassPath);
      } catch {
        // ignore
      }
      this.askpassPath = null;
    }
  }
}

function pipeSshToLocal(source, sourceCommand, destAbs) {
  return new Promise((resolve, reject) => {
    let src;
    try {
      src = source.spawn(sourceCommand, { multiplex: false });
    } catch (err) {
      reject(err);
      return;
    }

    const dst = createWriteStream(destAbs);
    src.stdout.pipe(dst);

    let srcErr = "";
    src.stderr.on("data", (chunk) => {
      srcErr += chunk.toString();
    });

    let srcCode;
    let dstDone = false;
    let settled = false;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };

    const maybeDone = () => {
      if (srcCode === undefined || !dstDone) return;
      if (srcCode === 0) {
        finish();
        return;
      }
      finish(new Error(srcErr.trim() || `copy failed (source exit ${srcCode})`));
    };

    src.on("error", finish);
    dst.on("error", finish);
    src.on("close", (code) => {
      srcCode = code;
      maybeDone();
    });
    dst.on("finish", () => {
      dstDone = true;
      maybeDone();
    });
  });
}

function pipeSsh(source, sourceCommand, dest, destCommand) {
  return new Promise((resolve, reject) => {
    let src;
    let dst;
    try {
      src = source.spawn(sourceCommand, { multiplex: false });
      dst = dest.spawn(destCommand, { stdin: true, multiplex: false });
    } catch (err) {
      reject(err);
      return;
    }

    src.stdout.pipe(dst.stdin);

    let srcErr = "";
    let dstErr = "";
    src.stderr.on("data", (chunk) => {
      srcErr += chunk.toString();
    });
    dst.stderr.on("data", (chunk) => {
      dstErr += chunk.toString();
    });

    let srcCode;
    let dstCode;
    let settled = false;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };

    const maybeDone = () => {
      if (srcCode === undefined || dstCode === undefined) return;
      if (srcCode === 0 && dstCode === 0) {
        finish();
        return;
      }
      finish(
        new Error(
          dstErr.trim() ||
            srcErr.trim() ||
            `copy failed (source exit ${srcCode}, dest exit ${dstCode})`,
        ),
      );
    };

    src.on("error", finish);
    dst.on("error", finish);
    src.on("close", (code) => {
      srcCode = code;
      maybeDone();
    });
    dst.on("close", (code) => {
      dstCode = code;
      maybeDone();
    });
  });
}

function listLocalMd5Files(dir, limit) {
  if (!existsSync(dir)) return [];

  const files = [];
  for (const name of readdirSync(dir)) {
    if (!isMd5Filename(name)) continue;
    const absPath = join(dir, name);
    try {
      if (!statSync(absPath).isFile()) continue;
    } catch {
      continue;
    }
    files.push({ absPath, filename: name });
    if (files.length >= limit) break;
  }
  return files;
}

async function listRemoteMd5Files(ssh, limit) {
  const output = await ssh.exec(buildListCommand(ssh.path, limit), {
    timeout: LIST_TIMEOUT_MS,
  });
  if (!output) return [];

  const files = [];
  for (const line of output.split(/\r?\n/)) {
    const absPath = line.trim();
    if (!absPath) continue;
    const filename = posix.basename(absPath);
    if (!isMd5Filename(filename)) continue;
    files.push({ absPath, filename });
    if (files.length >= limit) break;
  }
  return files;
}

async function remoteFileSize(ssh, absPath) {
  const output = await ssh.exec(`stat -c%s ${shQuote(absPath)} 2>/dev/null || echo -1`);
  const size = Number(output.trim());
  return Number.isFinite(size) ? size : -1;
}

async function deleteSource(source, file) {
  if (source.local) {
    unlinkSync(file.absPath);
    return;
  }

  await source.ssh.exec(`rm -f ${shQuote(file.absPath)}`);
  const parent = posix.dirname(file.absPath);
  const grand = posix.dirname(parent);
  if (parent !== source.ssh.path && parent.startsWith(`${source.ssh.path}/`)) {
    await source.ssh.exec(`rmdir ${shQuote(parent)} 2>/dev/null || true`);
    if (grand !== source.ssh.path && grand.startsWith(`${source.ssh.path}/`)) {
      await source.ssh.exec(`rmdir ${shQuote(grand)} 2>/dev/null || true`);
    }
  }
}

async function transferFile(dest, source, file) {
  const destRel = dest.local ? file.filename : destRelativePath(file.filename);
  const destAbs = dest.local
    ? join(dest.dir, file.filename)
    : `${dest.ssh.path}/${destRel}`;
  const sourceSize = source.local
    ? statSync(file.absPath).size
    : await remoteFileSize(source.ssh, file.absPath);

  if (sourceSize < 0) {
    throw new Error("could not read source file size");
  }

  if (dest.local) {
    mkdirSync(dest.dir, { recursive: true });
    let existingSize = -1;
    try {
      if (existsSync(destAbs) && statSync(destAbs).isFile()) {
        existingSize = statSync(destAbs).size;
      }
    } catch {
      existingSize = -1;
    }

    if (existingSize !== sourceSize) {
      try {
        await pipeSshToLocal(
          source.ssh,
          `cat -- ${shQuote(file.absPath)}`,
          destAbs,
        );
      } catch (err) {
        try {
          unlinkSync(destAbs);
        } catch {
          // ignore
        }
        throw err;
      }

      const destSize = statSync(destAbs).size;
      if (destSize !== sourceSize) {
        try {
          unlinkSync(destAbs);
        } catch {
          // ignore
        }
        throw new Error(`size mismatch (source ${sourceSize}, dest ${destSize})`);
      }
    }
  } else {
    const destDir = posix.dirname(destAbs);
    const existingSize = await remoteFileSize(dest.ssh, destAbs);
    if (existingSize !== sourceSize) {
      await dest.ssh.exec(`mkdir -p ${shQuote(destDir)}`);
      try {
        if (source.local) {
          await dest.ssh.exec(`cat > ${shQuote(destAbs)}`, {
            stdin: createReadStream(file.absPath),
            timeout: 0,
          });
        } else {
          await pipeSsh(
            source.ssh,
            `cat -- ${shQuote(file.absPath)}`,
            dest.ssh,
            `cat > ${shQuote(destAbs)}`,
          );
        }
      } catch (err) {
        await dest.ssh.exec(`rm -f ${shQuote(destAbs)}`).catch(() => {});
        throw err;
      }

      const destSize = await remoteFileSize(dest.ssh, destAbs);
      if (destSize !== sourceSize) {
        await dest.ssh.exec(`rm -f ${shQuote(destAbs)}`).catch(() => {});
        throw new Error(`size mismatch (source ${sourceSize}, dest ${destSize})`);
      }
    }
  }

  await deleteSource(source, file);
  return destRel;
}

async function moveFiles(dest, source, files, concurrency) {
  if (files.length === 0) {
    console.log(`${source.name}: no matching md5 files`);
    return;
  }

  console.log(
    `${source.name}: moving ${files.length} file(s) with concurrency ${concurrency}`,
  );
  let moved = 0;
  let failed = 0;

  await mapPool(files, concurrency, async (file) => {
    try {
      const destRel = await transferFile(dest, source, file);
      moved += 1;
      console.log(`  moved ${file.filename} -> ${destRel}`);
    } catch (err) {
      failed += 1;
      console.error(`  failed ${file.filename}: ${err.message}`);
    }
  });

  console.log(`${source.name}: moved ${moved}, failed ${failed}`);
}

async function processLocalData(dest, dataDir, batchSize, concurrency) {
  if (!existsSync(dataDir)) {
    console.log(`local data (${dataDir}): directory not found, skipping`);
    return;
  }

  const files = listLocalMd5Files(dataDir, batchSize);
  await moveFiles(
    dest,
    { name: `local data (${dataDir})`, local: true, path: dataDir },
    files,
    concurrency,
  );
}

async function processRemoteServer(dest, spec, batchSize, concurrency) {
  const parsed = parseServer(spec.raw);
  if (!parsed?.host || !parsed.path) {
    console.error(`Skipping ${spec.name}: invalid address, expected user@host:/path`);
    return;
  }

  const user = parsed.user || spec.userOverride;
  if (!user) {
    console.error(`Skipping ${spec.name}: missing username`);
    return;
  }

  const ssh = new SshTarget({
    name: spec.name,
    user,
    host: parsed.host,
    path: parsed.path,
    keyFile: spec.keyFile,
    password: spec.password,
  });

  try {
    await ssh.connect();
  } catch (err) {
    console.error(`Skipping ${spec.name} (${parsed.host}): no access (${err.message})`);
    await ssh.close().catch(() => {});
    return;
  }

  try {
    const files = await listRemoteMd5Files(ssh, batchSize);
    await moveFiles(dest, { name: spec.name, local: false, ssh }, files, concurrency);
  } finally {
    await ssh.close();
  }
}

function assertFreeSpace(disk, label) {
  if (!disk) {
    throw new Error(`Could not determine free disk space on ${label}`);
  }
  if (disk.freePercent < MIN_FREE_PERCENT) {
    throw new Error(
      `Not enough free disk space on ${label}: ${disk.freePercent.toFixed(1)}% free (minimum ${MIN_FREE_PERCENT}% required)`,
    );
  }
}

async function connectMainServer() {
  const raw = process.env.MAIN_SERVER?.trim();
  if (!raw) {
    fail("MAIN_SERVER is not set");
  }

  const parsed = parseServer(raw);
  if (!parsed?.host || !parsed.path) {
    fail("MAIN_SERVER must be in the form user@host:/path");
  }

  const user = parsed.user || process.env.MAIN_SERVER_USER?.trim();
  if (!user) {
    fail("MAIN_SERVER is missing a username (use user@host:/path or MAIN_SERVER_USER)");
  }

  const mainSsh = new SshTarget({
    name: "MAIN",
    user,
    host: parsed.host,
    path: parsed.path,
    keyFile: process.env.MAIN_USER_KEY_FILE?.trim() || "",
    password: process.env.MAIN_USER_PASS || "",
  });

  let dfLine;
  try {
    dfLine = await mainSsh.exec(buildDfCommand(mainSsh.path));
  } catch (err) {
    await mainSsh.close().catch(() => {});
    fail(`MAIN server is unavailable: ${err.message}`);
  }

  try {
    assertFreeSpace(parseDfLine(dfLine), `MAIN server path ${mainSsh.path}`);
  } catch (err) {
    await mainSsh.close().catch(() => {});
    fail(err.message);
  }

  return mainSsh;
}

async function processServers(dest, batchSize, concurrency) {
  const servers = listEnvServers();
  if (servers.length === 0) {
    console.log("No SERVER_N entries found in env");
    return;
  }

  for (const spec of servers) {
    await processRemoteServer(dest, spec, batchSize, concurrency);
  }
}

async function main() {
  const root = dirname(fileURLToPath(import.meta.url));
  loadEnv(join(root, ".env"));

  const dataDir = resolveDataDir(root);
  const batchSize = parseBatchSize(process.env.BATCH_SIZE);
  const concurrency = parseConcurrency(process.env.CONCURRENCY);
  const mainHere = isMainServerHere(process.env.MAIN_SERVER_HERE);

  if (mainHere) {
    mkdirSync(dataDir, { recursive: true });

    let dfLine;
    try {
      dfLine = await localDfLine(dataDir);
    } catch (err) {
      fail(`Local DATA_DIR is unavailable: ${err.message}`);
    }
    assertFreeSpace(parseDfLine(dfLine), `local DATA_DIR ${dataDir}`);

    console.log(
      `MAIN_SERVER_HERE=1, ignoring MAIN_SERVER, pulling into ${dataDir} (batch size ${batchSize}, concurrency ${concurrency})`,
    );
    await processServers({ local: true, dir: dataDir }, batchSize, concurrency);
    return;
  }

  const mainSsh = await connectMainServer();
  console.log(
    `MAIN server is available, pushing into ${mainSsh.path} (batch size ${batchSize}, concurrency ${concurrency})`,
  );

  try {
    await processLocalData({ local: false, ssh: mainSsh }, dataDir, batchSize, concurrency);
    await processServers({ local: false, ssh: mainSsh }, batchSize, concurrency);
  } finally {
    await mainSsh.close().catch(() => {});
  }
}

main().catch((err) => fail(err.message || String(err)));
