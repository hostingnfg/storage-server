import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const INTERVAL_MS = Number(process.env.SCHEDULER_INTERVAL_MS) || 60_000;
const root = dirname(fileURLToPath(import.meta.url));
const script = join(root, "move-files.js");

let running = false;

function runMoveFiles() {
  if (running) {
    console.log(`${new Date().toISOString()} move-files.js still running, skip`);
    return;
  }

  running = true;
  console.log(`${new Date().toISOString()} starting move-files.js`);

  const child = spawn(process.execPath, [script], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });

  child.on("error", (err) => {
    running = false;
    console.error(`${new Date().toISOString()} failed to start move-files.js: ${err.message}`);
  });

  child.on("exit", (code, signal) => {
    running = false;
    const reason = signal ? `signal ${signal}` : `code ${code}`;
    console.log(`${new Date().toISOString()} move-files.js finished (${reason})`);
  });
}

console.log(
  `Scheduler started, running move-files.js every ${INTERVAL_MS / 1000}s`,
);
runMoveFiles();
setInterval(runMoveFiles, INTERVAL_MS);
