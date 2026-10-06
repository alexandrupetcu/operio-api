import webpush from "web-push";
import { env } from "../config/env.js";

let configured = false;

/** True when a VAPID keypair is present so browser push can actually be sent. */
export function isWebPushConfigured(): boolean {
  return !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
}

function ensureConfigured(): boolean {
  if (!isWebPushConfigured()) return false;
  if (!configured) {
    webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY!, env.VAPID_PRIVATE_KEY!);
    configured = true;
  }
  return true;
}

export interface PushSubscriptionRecord {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface WebPushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
}

export type WebPushResult =
  | { ok: true }
  | { ok: false; expired: boolean; error: string };

/**
 * Send a single web-push message. Returns `expired: true` on 404/410 so the
 * caller can prune the dead subscription.
 */
export async function sendWebPush(
  sub: PushSubscriptionRecord,
  payload: WebPushPayload,
): Promise<WebPushResult> {
  if (!ensureConfigured()) return { ok: false, expired: false, error: "web-push not configured" };
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
    );
    return { ok: true };
  } catch (err: unknown) {
    const statusCode = (err as { statusCode?: number })?.statusCode;
    const expired = statusCode === 404 || statusCode === 410;
    return { ok: false, expired, error: err instanceof Error ? err.message : String(err) };
  }
}
