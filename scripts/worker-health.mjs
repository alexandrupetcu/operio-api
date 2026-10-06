/**
 * Docker healthcheck for the workers container: every BullMQ queue must have at
 * least one worker currently registered on Redis (BullMQ workers announce
 * themselves via CLIENT SETNAME). A worker that is alive but disconnected or
 * hung at startup shows up as missing → exit 1 → Docker marks the container
 * unhealthy and autoheal restarts it.
 *
 *   node scripts/worker-health.mjs          (uses REDIS_URL)
 */
import { Queue } from "bullmq";

const QUEUES = [
  "document-generation",
  "revision-processing",
  "signing-complete",
  "email-ingestion",
  "notification-scanner",
  "workflow-engine",
];

const url = new URL(process.env.REDIS_URL ?? "redis://localhost:6379");
const connection = {
  host: url.hostname,
  port: Number(url.port) || 6379,
  password: url.password || undefined,
  maxRetriesPerRequest: null,
  connectTimeout: 4000,
};

const timer = setTimeout(() => {
  console.error("worker-health: timed out");
  process.exit(1);
}, 8000);

const missing = [];
const queues = QUEUES.map((name) => new Queue(name, { connection }));
try {
  for (const q of queues) {
    const workers = await q.getWorkers();
    if (workers.length === 0) missing.push(q.name);
  }
} catch (err) {
  console.error("worker-health: redis error:", err instanceof Error ? err.message : err);
  process.exit(1);
} finally {
  await Promise.allSettled(queues.map((q) => q.close()));
  clearTimeout(timer);
}

if (missing.length) {
  console.error(`worker-health: no worker on ${missing.join(", ")}`);
  process.exit(1);
}
console.log("worker-health: ok");
process.exit(0);
