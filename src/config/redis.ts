import { env } from "./env.js";

// Parse Redis URL into connection options for BullMQ
function parseRedisUrl(url: string) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parseInt(parsed.port) || 6379,
    password: parsed.password || undefined,
    maxRetriesPerRequest: null as null, // Required by BullMQ
  };
}

export const redisConnection = parseRedisUrl(env.REDIS_URL);
