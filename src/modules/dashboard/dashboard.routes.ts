import type { FastifyInstance } from "fastify";
import * as dashboardService from "./dashboard.service.js";
import { resolveApptScope } from "../appointments/scope.js";
import { snoozeActionSchema, dismissActionSchema, unsnoozeActionSchema } from "./dashboard.schema.js";

export default async function dashboardRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", fastify.authenticate);

  fastify.get("/overview", async (request) => {
    return dashboardService.getOverview(
      fastify,
      request.tenantId,
      request.user.sub,
      await resolveApptScope(fastify, request)
    );
  });

  fastify.get("/appointments-upcoming", async (request) => {
    return dashboardService.getAppointmentsUpcoming(
      fastify,
      request.tenantId,
      await resolveApptScope(fastify, request)
    );
  });

  fastify.get("/deadlines", async (request) => {
    return dashboardService.getDeadlines(fastify, request.tenantId);
  });

  fastify.get("/expiring-revisions", async (request) => {
    return dashboardService.getExpiringRevisions(fastify, request.tenantId);
  });

  fastify.get("/fleet-alerts", async (request) => {
    return dashboardService.getFleetAlerts(fastify, request.tenantId);
  });

  fastify.get("/my-tasks", async (request) => {
    return dashboardService.getMyTasks(
      fastify,
      request.tenantId,
      request.user.sub
    );
  });

  fastify.get("/action-feed", async (request) => {
    return dashboardService.getActionFeed(
      fastify,
      request.tenantId,
      request.user.sub,
      await resolveApptScope(fastify, request)
    );
  });

  fastify.post("/action-feed/snooze", async (request) => {
    const body = snoozeActionSchema.parse(request.body);
    return dashboardService.snoozeAction(fastify, request.tenantId, request.user.sub, body);
  });

  fastify.post("/action-feed/dismiss", async (request) => {
    const body = dismissActionSchema.parse(request.body);
    return dashboardService.dismissAction(fastify, request.tenantId, request.user.sub, body);
  });

  fastify.delete("/action-feed/snooze", async (request) => {
    const body = unsnoozeActionSchema.parse(request.body);
    return dashboardService.unsnoozeAction(fastify, request.tenantId, request.user.sub, {
      actionKey: body.actionKey,
      note: body.note,
    });
  });
}
