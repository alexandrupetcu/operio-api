import Fastify from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import { env } from "./config/env.js";
import prismaPlugin from "./plugins/prisma.js";
import authPlugin from "./plugins/auth.js";
import tenantPlugin from "./plugins/tenant.js";
import authRoutes from "./modules/auth/auth.routes.js";
import usersRoutes from "./modules/users/users.routes.js";
import clientsRoutes from "./modules/clients/clients.routes.js";
import projectsRoutes from "./modules/projects/projects.routes.js";
import projectTeamRoutes from "./modules/projects/project-team.routes.js";
import projectTypesRoutes from "./modules/project-types/project-types.routes.js";
import documentsRoutes from "./modules/documents/documents.routes.js";
import templatesRoutes from "./modules/templates/templates.routes.js";
import tenantRoutes from "./modules/tenant/tenant.routes.js";
import servicesRoutes from "./modules/services/services.routes.js";
import employeesRoutes from "./modules/employees/employees.routes.js";
import vehiclesRoutes from "./modules/vehicles/vehicles.routes.js";
import anafRoutes from "./modules/anaf/anaf.routes.js";
import workflowDefinitionsRoutes from "./modules/workflow-definitions/workflow-definitions.routes.js";
import workflowInstancesRoutes from "./modules/workflow-instances/workflow-instances.routes.js";
import tasksRoutes from "./modules/tasks/tasks.routes.js";
import notificationsRoutes from "./modules/notifications/notifications.routes.js";
import scheduledJobsRoutes from "./modules/scheduled-jobs/scheduled-jobs.routes.js";
import auditRoutes from "./modules/audit/audit.routes.js";
import geographyRoutes from "./modules/geography/geography.routes.js";
import internalEndpointsRoutes from "./modules/internal-endpoints/internal-endpoints.routes.js";
import drawingTemplatesRoutes from "./modules/drawing-templates/drawing-templates.routes.js";
import adminRoutes from "./modules/admin/admin.routes.js";
import equipmentRevisionsRoutes from "./modules/equipment-revisions/equipment-revisions.routes.js";
import signingRoutes from "./modules/signing/signing.routes.js";
import signingPublicRoutes from "./modules/signing/signing.public.routes.js";
import appointmentsRoutes from "./modules/appointments/appointments.routes.js";
import emailInboxesRoutes from "./modules/email-inboxes/email-inboxes.routes.js";
import dashboardRoutes from "./modules/dashboard/dashboard.routes.js";
import registryRoutes from "./modules/registry/registry.routes.js";
import { verifySmtp } from "./lib/email.js";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { FastifyAdapter } from "@bull-board/fastify";
import { Queue } from "bullmq";
import { redisConnection } from "./config/redis.js";

export async function buildServer() {
  const fastify = Fastify({
    logger: {
      level: env.NODE_ENV === "production" ? "info" : "debug",
      transport:
        env.NODE_ENV === "development"
          ? { target: "pino-pretty", options: { translateTime: "HH:MM:ss" } }
          : undefined,
    },
  });

  // Core plugins
  await fastify.register(cors, {
    origin: env.FRONTEND_URL,
    credentials: true,
  });
  await fastify.register(sensible);
  await fastify.register(rateLimit, {
    max: 100,
    timeWindow: "1 minute",
  });
  await fastify.register(multipart, {
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  });

  // App plugins
  await fastify.register(prismaPlugin);
  await fastify.register(authPlugin);
  await fastify.register(tenantPlugin);

  // Routes
  await fastify.register(authRoutes, { prefix: "/api/auth" });
  await fastify.register(usersRoutes, { prefix: "/api/users" });
  await fastify.register(clientsRoutes, { prefix: "/api/clients" });
  await fastify.register(projectsRoutes, { prefix: "/api/projects" });
  await fastify.register(projectTeamRoutes, { prefix: "/api/projects" });
  await fastify.register(projectTypesRoutes, { prefix: "/api/project-types" });
  await fastify.register(documentsRoutes, { prefix: "/api/documents" });
  await fastify.register(templatesRoutes, { prefix: "/api/templates" });
  await fastify.register(tenantRoutes, { prefix: "/api/tenant" });
  await fastify.register(servicesRoutes, { prefix: "/api/services" });
  await fastify.register(employeesRoutes, { prefix: "/api/employees" });
  await fastify.register(vehiclesRoutes, { prefix: "/api/vehicles" });
  await fastify.register(anafRoutes, { prefix: "/api/anaf" });
  await fastify.register(workflowDefinitionsRoutes, { prefix: "/api/workflow-definitions" });
  await fastify.register(workflowInstancesRoutes, { prefix: "/api/workflow-instances" });
  await fastify.register(tasksRoutes, { prefix: "/api/tasks" });
  await fastify.register(appointmentsRoutes, { prefix: "/api/appointments" });
  await fastify.register(emailInboxesRoutes, { prefix: "/api/email-inboxes" });
  await fastify.register(dashboardRoutes, { prefix: "/api/dashboard" });
  await fastify.register(registryRoutes, { prefix: "/api/registry" });
  await fastify.register(notificationsRoutes, { prefix: "/api/notifications" });
  await fastify.register(scheduledJobsRoutes, { prefix: "/api/scheduled-jobs" });
  await fastify.register(auditRoutes, { prefix: "/api/audit-logs" });
  await fastify.register(geographyRoutes, { prefix: "/api/geography" });
  await fastify.register(internalEndpointsRoutes, { prefix: "/api/internal-endpoints" });
  await fastify.register(drawingTemplatesRoutes, { prefix: "/api/drawing-templates" });
  await fastify.register(adminRoutes, { prefix: "/api/admin" });
  await fastify.register(equipmentRevisionsRoutes, { prefix: "/api/clients" });
  await fastify.register(signingRoutes, { prefix: "/api/signing" });
  await fastify.register(signingPublicRoutes, { prefix: "/api/public/sign" });

  // ── Bull Board (queue monitoring UI) ──
  const serverAdapter = new FastifyAdapter();
  serverAdapter.setBasePath("/admin/queues");

  const docQueue = new Queue("document-generation", { connection: redisConnection });
  const workflowQueue = new Queue("workflow-engine", { connection: redisConnection });
  const revisionQueue = new Queue("revision-processing", { connection: redisConnection });
  const signingQueue = new Queue("signing-complete", { connection: redisConnection });
  const emailIngestionQueue = new Queue("email-ingestion", { connection: redisConnection });

  createBullBoard({
    queues: [
      new BullMQAdapter(docQueue),
      new BullMQAdapter(workflowQueue),
      new BullMQAdapter(revisionQueue),
      new BullMQAdapter(signingQueue),
      new BullMQAdapter(emailIngestionQueue),
    ],
    serverAdapter,
  });

  // Bull Board UI — no auth in development, basic token in production
  await fastify.register(serverAdapter.registerPlugin() as any, {
    prefix: "/admin/queues",
  });

  // Verify SMTP on startup
  verifySmtp();

  // Health check
  fastify.get("/api/health", async () => ({ status: "ok" }));

  return fastify;
}
