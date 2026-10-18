import { Redis } from "ioredis";
import { redisConnection } from "../config/redis.js";
import { env } from "../config/env.js";

/**
 * Revoked-phone denylist. Access tokens live ≤15 min, so a plain DB check at
 * refresh time would already cut a revoked phone off quickly; this Redis key
 * makes it immediate (lost/stolen phone, technician leaving). Keyed per
 * user+device, kept for the refresh-token lifetime (after that no token can
 * exist anyway).
 */
let redis: Redis | null = null;
function client(): Redis {
  if (!redis) redis = new Redis({ ...redisConnection, lazyConnect: true, enableOfflineQueue: false });
  return redis;
}
const key = (userId: string, deviceId: string) => `mobile:revoked:${userId}:${deviceId}`;

function refreshLifetimeSeconds(): number {
  const m = env.JWT_REFRESH_EXPIRY.match(/^(\d+)([smhd])$/);
  if (!m) return 7 * 86400;
  return parseInt(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[m[2] as "s" | "m" | "h" | "d"]!;
}

export async function markMobileDeviceRevoked(userId: string, deviceId: string): Promise<void> {
  try {
    await client().set(key(userId, deviceId), "1", "EX", refreshLifetimeSeconds());
  } catch (err) {
    // Redis down → revocation still lands at the next token refresh (DB check).
    console.warn("[mobile-devices] could not write revocation to redis:", (err as Error).message);
  }
}

export async function clearMobileDeviceRevoked(userId: string, deviceId: string): Promise<void> {
  try {
    await client().del(key(userId, deviceId));
  } catch {
    /* best effort */
  }
}

export async function isMobileDeviceRevoked(userId: string, deviceId: string): Promise<boolean> {
  try {
    return (await client().exists(key(userId, deviceId))) === 1;
  } catch {
    return false; // fail open on the fast path; refresh enforces via DB
  }
}

/**
 * Whole-user revocation (account deactivated/removed): every session, web
 * included, is refused at once. Kept for the ACCESS-token lifetime — after that
 * no access token signed before the revocation can still be valid, and refresh
 * is already refused by the DB (`isActive: false`, refresh rows deleted).
 */
const userKey = (userId: string) => `user:revoked:${userId}`;

function accessLifetimeSeconds(): number {
  const m = env.JWT_ACCESS_EXPIRY.match(/^(\d+)([smhd])$/);
  if (!m) return 15 * 60;
  return parseInt(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[m[2] as "s" | "m" | "h" | "d"]!;
}

export async function markUserRevoked(userId: string): Promise<void> {
  try {
    // +60 s margin for clock skew between sign and verify.
    await client().set(userKey(userId), "1", "EX", accessLifetimeSeconds() + 60);
  } catch (err) {
    console.warn("[mobile-devices] could not write user revocation to redis:", (err as Error).message);
  }
}

export async function isUserRevoked(userId: string): Promise<boolean> {
  try {
    return (await client().exists(userKey(userId))) === 1;
  } catch {
    return false;
  }
}
