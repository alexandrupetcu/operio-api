import { Expo, type ExpoPushMessage, type ExpoPushTicket } from "expo-server-sdk";

const expo = new Expo();

export function isValidExpoToken(token: string): boolean {
  return Expo.isExpoPushToken(token);
}

export interface ExpoPushPayload {
  title: string;
  body: string;
  url?: string;
}

export interface ExpoSendResult {
  /** Expo push tokens that came back as DeviceNotRegistered → prune these. */
  invalidTokens: string[];
  ok: boolean;
  errors: string[];
}

/**
 * Send a payload to many Expo push tokens. Chunks the requests and reports
 * DeviceNotRegistered tokens so the caller can delete the dead PushDevice rows.
 */
export async function sendExpoPush(tokens: string[], payload: ExpoPushPayload): Promise<ExpoSendResult> {
  const valid = tokens.filter(isValidExpoToken);
  const invalidTokens: string[] = tokens.filter((t) => !isValidExpoToken(t));
  const errors: string[] = [];
  if (valid.length === 0) return { invalidTokens, ok: false, errors: ["no valid tokens"] };

  const messages: ExpoPushMessage[] = valid.map((to) => ({
    to,
    sound: "default",
    title: payload.title,
    body: payload.body,
    data: payload.url ? { url: payload.url } : {},
  }));

  const tickets: ExpoPushTicket[] = [];
  for (const chunk of expo.chunkPushNotifications(messages)) {
    try {
      const receipts = await expo.sendPushNotificationsAsync(chunk);
      tickets.push(...receipts);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  let ok = false;
  tickets.forEach((ticket, i) => {
    if (ticket.status === "ok") {
      ok = true;
    } else {
      errors.push(ticket.message ?? "unknown error");
      if (ticket.details?.error === "DeviceNotRegistered") {
        invalidTokens.push(valid[i]);
      }
    }
  });

  return { invalidTokens, ok, errors };
}
