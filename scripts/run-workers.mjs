/**
 * Runs every BullMQ worker in one command, each in its own child process so a
 * crash in one doesn't take the others down. Output is prefixed per worker and
 * colorized. Ctrl+C (SIGINT/SIGTERM) shuts them all down cleanly.
 *
 *   npm run workers              — dev: TypeScript sources via tsx, env from .env
 *   WORKERS_FROM_DIST=1 ...      — prod (Docker): compiled dist/, env from the process
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(__dirname, "..");

const fromDist = process.env.WORKERS_FROM_DIST === "1" || process.env.NODE_ENV === "production";

/** name → worker module (relative to src/workers or dist/workers). */
const WORKER_FILES = {
  documents: "document-generation.worker",
  revisions: "revision-processing.worker",
  signing: "signing-complete.worker",
  "email-ingestion": "email-ingestion.worker",
  notifications: "notification-scanner.worker",
  workflow: "workflow-engine.worker",
};
const WORKERS = Object.fromEntries(
  Object.entries(WORKER_FILES).map(([name, file]) => [
    name,
    fromDist ? `dist/workers/${file}.js` : `src/workers/${file}.ts`,
  ]),
);

// Distinct ANSI colors so each worker's lines are easy to tell apart.
const COLORS = [36, 32, 33, 35, 34, 31, 92, 93];
const RESET = "\x1b[0m";
const names = Object.keys(WORKERS);
const pad = Math.max(...names.map((n) => n.length));

const children = [];
let shuttingDown = false;

function launch(name, entry, color) {
  const tag = `\x1b[${color}m[${name.padEnd(pad)}]${RESET}`;
  // Run node directly with the tsx loader (not the .bin/tsx shim, which forks a
  // second node process that SIGTERM wouldn't reach). This way the spawned
  // child IS the worker, so kill() terminates it cleanly — no orphans.
  const child = spawn(
    process.execPath,
    fromDist ? [entry] : ["--import", "tsx", "--env-file=.env", entry],
    { cwd: apiRoot, env: process.env },
  );

  const pipe = (stream, out) => {
    let buf = "";
    stream.on("data", (chunk) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) out.write(`${tag} ${line}\n`);
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);

  child.on("exit", (code, signal) => {
    process.stdout.write(`${tag} exited (code=${code ?? "-"}, signal=${signal ?? "-"})\n`);
    if (!shuttingDown) {
      // If one worker dies on its own, tear the rest down so the failure is
      // obvious rather than silently running a degraded set.
      shutdown(1);
    }
  });

  return child;
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write("\nStopping workers...\n");
  for (const c of children) {
    if (c.exitCode === null && c.signalCode === null) c.kill("SIGTERM");
  }
  // Give them a moment to flush, then force-exit.
  setTimeout(() => process.exit(exitCode), 3000).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

process.stdout.write(`Starting ${names.length} workers: ${names.join(", ")}\n`);
for (let i = 0; i < names.length; i++) {
  const name = names[i];
  children.push(launch(name, WORKERS[name], COLORS[i % COLORS.length]));
}
