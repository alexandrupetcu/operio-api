import type { FastifyInstance } from "fastify";
import * as dashboardService from "./dashboard.service.js";

export default async function dashboardRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", fastify.authenticate);

  fastify.get("/overview", async (request) => {
    return dashboardService.getOverview(
      fastify,
      request.tenantId,
      request.user.sub
    );
  });

  fastify.get("/appointments-upcoming", async (request) => {
    return dashboardService.getAppointmentsUpcoming(fastify, request.tenantId);
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
}
