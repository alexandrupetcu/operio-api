import { vi } from "vitest";

/**
 * Rulează ÎNAINTE de modulele testate, deci e locul în care:
 *
 *  1. Punem variabilele de mediu minime cerute de `src/config/env.ts` (care face
 *     `process.exit(1)` pe o configurație invalidă, la import).
 *  2. Înlocuim `bullmq`. Multe module creează `new Queue(...)` la nivel de modul,
 *     iar constructorul BullMQ deschide imediat o conexiune ioredis — adică un
 *     import ar cere Redis și ar lăsa handle-uri deschise. Testele verifică ce
 *     scrie serviciul în baza de date, nu ce pune în coadă, așa că reținem doar
 *     joburile cerute (`enqueuedJobs`) pentru eventuale aserțiuni.
 */

process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ||= process.env.TEST_DATABASE_URL ?? "";
process.env.REDIS_URL ||= "redis://127.0.0.1:6380";
process.env.JWT_SECRET ||= "test-jwt-secret-value";
process.env.JWT_REFRESH_SECRET ||= "test-jwt-refresh-secret";
process.env.S3_ACCESS_KEY ||= "test-access-key";
process.env.S3_SECRET_KEY ||= "test-secret-key";
process.env.S3_BUCKET ||= "operio-test";
delete process.env.SMTP_HOST; // `verifySmtp()` nu trebuie să încerce o conexiune

export interface EnqueuedJob {
  queue: string;
  name: string;
  data: unknown;
}
/** Joburile pe care serviciile ar fi pus în coadă în timpul testului. */
export const enqueuedJobs: EnqueuedJob[] = [];

/**
 * 3. Înlocuim `ioredis`. Cache-ul panoului și denylist-ul de dispozitive mobile
 *    își deschid clientul la prima folosire (lazy, fail-open) — ar lăsa handle-uri
 *    deschise și ar adăuga timeout-uri de 250 ms la fiecare finalizare. Un store
 *    în memorie e suficient: ambele module tratează Redis ca pe un cache.
 */
vi.mock("ioredis", () => {
  const store = new Map<string, string>();
  class FakeRedis {
    async get(k: string) {
      return store.get(k) ?? null;
    }
    async set(k: string, v: string) {
      store.set(k, v);
      return "OK";
    }
    async setex(k: string, _ttl: number, v: string) {
      store.set(k, v);
      return "OK";
    }
    async del(...keys: string[]) {
      let n = 0;
      for (const k of keys) if (store.delete(k)) n++;
      return n;
    }
    async incr(k: string) {
      const v = Number(store.get(k) ?? "0") + 1;
      store.set(k, String(v));
      return v;
    }
    async exists(k: string) {
      return store.has(k) ? 1 : 0;
    }
    async expire() {
      return 1;
    }
    async quit() {
      return "OK";
    }
    disconnect() {}
    on() {
      return this;
    }
  }
  return { Redis: FakeRedis, default: FakeRedis };
});

vi.mock("bullmq", () => {
  class FakeQueue {
    constructor(public readonly name: string) {}
    async add(jobName: string, data: unknown) {
      enqueuedJobs.push({ queue: this.name, name: jobName, data });
      return { id: `fake-${enqueuedJobs.length}` };
    }
    async addBulk(jobs: { name: string; data: unknown }[]) {
      return jobs.map((j) => this.add(j.name, j.data));
    }
    async getJob() {
      return null;
    }
    async close() {}
    on() {
      return this;
    }
    off() {
      return this;
    }
  }
  class FakeWorker {
    async close() {}
    on() {
      return this;
    }
  }
  class FakeQueueEvents {
    async close() {}
    on() {
      return this;
    }
  }
  return { Queue: FakeQueue, Worker: FakeWorker, QueueEvents: FakeQueueEvents, FlowProducer: FakeQueue };
});
