import type { FastifyInstance } from "fastify";
import { requireRole } from "../../lib/rbac.js";
import { paginationSchema } from "../../lib/pagination.js";
import { createNotificationSchema, markReadSchema } from "./notifications.schema.js";
import * as notificationsService from "./notifications.service.js";
import * as prefs from "./notifications.preferences.js";
import * as tenantSettings from "./tenant-settings.js";
import { env } from "../../config/env.js";

export default async function notificationsRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", fastify.authenticate);

  // GET / - list notifications for the current user (in_app) or all (admin)
  fastify.get("/", async (request) => {
    const query = paginationSchema.parse(request.query);
    const { channel, status, userId, category } = request.query as Record<
      string,
      string
    >;
    return notificationsService.list(fastify, request.tenantId, {
      ...query,
      channel,
      status,
      userId,
      category,
    });
  });

  // GET /unread-count - get unread notification count for current user
  fastify.get("/unread-count", async (request) => {
    return notificationsService.getUnreadCount(
      fastify,
      request.tenantId,
      request.user.sub
    );
  });

  fastify.get<{ Params: { id: string } }>("/:id", async (request) => {
    return notificationsService.getById(
      fastify,
      request.tenantId,
      request.params.id
    );
  });

  // POST / - create notification (ADMIN/MANAGER only)
  fastify.post(
    "/",
    { onRequest: [requireRole("ADMIN", "MANAGER")] },
    async (request, reply) => {
      const body = createNotificationSchema.parse(request.body);
      const notification = await notificationsService.create(
        fastify,
        request.tenantId,
        body
      );
      return reply.status(201).send(notification);
    }
  );

  // POST /mark-read - mark specific notifications as read
  fastify.post("/mark-read", async (request) => {
    const { ids } = markReadSchema.parse(request.body);
    return notificationsService.markAsRead(
      fastify,
      request.tenantId,
      request.user.sub,
      ids
    );
  });

  // POST /mark-all-read - mark all in_app notifications as read for current user
  fastify.post("/mark-all-read", async (request) => {
    return notificationsService.markAllAsRead(
      fastify,
      request.tenantId,
      request.user.sub
    );
  });

  // POST /:id/cancel
  fastify.post<{ Params: { id: string } }>(
    "/:id/cancel",
    async (request) => {
      return notificationsService.cancel(
        fastify,
        request.tenantId,
        request.params.id
      );
    }
  );

  // ── Tenant-level event switches (which notification types the firm emits) ─
  fastify.get("/tenant-settings", async (request) => {
    return tenantSettings.getTenantNotifSettings(fastify.prisma, request.tenantId);
  });

  fastify.put("/tenant-settings", { onRequest: [requireRole("ADMIN")] }, async (request) => {
    const body = tenantSettings.tenantSettingsUpdateSchema.parse(request.body);
    return tenantSettings.setTenantNotifSettings(fastify.prisma, request.tenantId, body.events);
  });

  // ── Per-user channel preferences ──────────────────────────────────────────
  fastify.get("/preferences", async (request) => {
    return prefs.getPreferences(fastify, request.tenantId, request.user.sub);
  });

  fastify.put("/preferences", async (request) => {
    const body = prefs.preferencesUpdateSchema.parse(request.body);
    return prefs.setPreferences(fastify, request.tenantId, request.user.sub, body.prefs);
  });

  // ── Web Push subscription ─────────────────────────────────────────────────
  fastify.get("/push/vapid-public-key", async () => {
    return { key: env.VAPID_PUBLIC_KEY ?? null };
  });

  fastify.post("/push/subscribe", async (request, reply) => {
    const body = prefs.pushSubscribeSchema.parse(request.body);
    const userAgent = request.headers["user-agent"];
    await prefs.subscribePush(fastify, request.tenantId, request.user.sub, body, userAgent);
    return reply.status(201).send({ success: true });
  });

  fastify.post("/push/unsubscribe", async (request) => {
    const body = prefs.pushUnsubscribeSchema.parse(request.body);
    return prefs.unsubscribePush(fastify, request.tenantId, body.endpoint);
  });

  // ── Mobile (Expo) push device registration ────────────────────────────────
  fastify.post("/push/register-device", async (request, reply) => {
    const body = prefs.deviceRegisterSchema.parse(request.body);
    await prefs.registerDevice(fastify, request.tenantId, request.user.sub, body);
    return reply.status(201).send({ success: true });
  });

  fastify.post("/push/unregister-device", async (request) => {
    const body = prefs.deviceUnregisterSchema.parse(request.body);
    return prefs.unregisterDevice(fastify, request.tenantId, body.expoToken);
  });
}
