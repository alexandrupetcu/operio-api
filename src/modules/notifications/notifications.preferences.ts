import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DISPATCH_CHANNELS } from "./dispatch.js";

export const NOTIF_CATEGORIES = ["projects", "fleet", "tasks", "system"] as const;

export const preferencesUpdateSchema = z.object({
  prefs: z
    .array(
      z.object({
        category: z.enum(NOTIF_CATEGORIES),
        channel: z.enum(DISPATCH_CHANNELS),
        enabled: z.boolean(),
      }),
    )
    .max(NOTIF_CATEGORIES.length * DISPATCH_CHANNELS.length),
});

export const pushSubscribeSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
});

export const pushUnsubscribeSchema = z.object({ endpoint: z.string().url() });

export const deviceRegisterSchema = z.object({
  expoToken: z.string().min(1),
  platform: z.enum(["ios", "android"]).optional(),
  deviceName: z.string().max(120).optional(),
});

export const deviceUnregisterSchema = z.object({ expoToken: z.string().min(1) });

/**
 * Full category×channel matrix with each cell's effective `enabled` value
 * (default-on, overlaid with the user's stored opt-outs). The UI renders this
 * directly as a grid of toggles.
 */
export async function getPreferences(fastify: FastifyInstance, tenantId: string, userId: string) {
  const rows = await fastify.prisma.notificationPreference.findMany({
    where: { tenantId, userId },
    select: { category: true, channel: true, enabled: true },
  });
  const map = new Map(rows.map((r) => [`${r.category}:${r.channel}`, r.enabled]));

  const matrix = NOTIF_CATEGORIES.flatMap((category) =>
    DISPATCH_CHANNELS.map((channel) => ({
      category,
      channel,
      enabled: map.get(`${category}:${channel}`) ?? true,
    })),
  );
  return { categories: NOTIF_CATEGORIES, channels: DISPATCH_CHANNELS, prefs: matrix };
}

export async function setPreferences(
  fastify: FastifyInstance,
  tenantId: string,
  userId: string,
  prefs: Array<{ category: string; channel: string; enabled: boolean }>,
) {
  await fastify.prisma.$transaction(
    prefs.map((p) =>
      fastify.prisma.notificationPreference.upsert({
        where: {
          tenantId_userId_category_channel: {
            tenantId,
            userId,
            category: p.category,
            channel: p.channel,
          },
        },
        create: { tenantId, userId, category: p.category, channel: p.channel, enabled: p.enabled },
        update: { enabled: p.enabled },
      }),
    ),
  );
  return getPreferences(fastify, tenantId, userId);
}

export async function subscribePush(
  fastify: FastifyInstance,
  tenantId: string,
  userId: string,
  sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  userAgent?: string,
) {
  return fastify.prisma.webPushSubscription.upsert({
    where: { endpoint: sub.endpoint },
    create: {
      tenantId,
      userId,
      endpoint: sub.endpoint,
      p256dh: sub.keys.p256dh,
      auth: sub.keys.auth,
      userAgent,
    },
    update: { tenantId, userId, p256dh: sub.keys.p256dh, auth: sub.keys.auth, userAgent, lastSeenAt: new Date() },
  });
}

export async function unsubscribePush(fastify: FastifyInstance, tenantId: string, endpoint: string) {
  await fastify.prisma.webPushSubscription.deleteMany({ where: { tenantId, endpoint } });
  return { success: true };
}

export async function registerDevice(
  fastify: FastifyInstance,
  tenantId: string,
  userId: string,
  input: { expoToken: string; platform?: string; deviceName?: string },
) {
  return fastify.prisma.pushDevice.upsert({
    where: { expoToken: input.expoToken },
    create: { tenantId, userId, expoToken: input.expoToken, platform: input.platform, deviceName: input.deviceName },
    update: { tenantId, userId, platform: input.platform, deviceName: input.deviceName, lastSeenAt: new Date() },
  });
}

export async function unregisterDevice(fastify: FastifyInstance, tenantId: string, expoToken: string) {
  await fastify.prisma.pushDevice.deleteMany({ where: { tenantId, expoToken } });
  return { success: true };
}
