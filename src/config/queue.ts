import type { JobsOptions } from "bullmq";

/**
 * Opțiuni implicite pentru toate cozile: job-urile terminate se curăță (altfel
 * Redis — maxmemory 512 MB, noeviction — se umple și orice `add()` eșuează), iar
 * erorile trecătoare (S3, SMTP, DB) se reîncearcă cu backoff înainte de FAILED.
 */
export const defaultJobOptions: JobsOptions = {
  removeOnComplete: 500,
  removeOnFail: 1000,
  attempts: 3,
  backoff: { type: "exponential", delay: 5000 },
};
