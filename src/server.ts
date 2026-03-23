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
import documentsRoutes from "./modules/documents/documents.routes.js";
import templatesRoutes from "./modules/templates/templates.routes.js";
import tenantRoutes from "./modules/tenant/tenant.routes.js";
import servicesRoutes from "./modules/services/services.routes.js";
import employeesRoutes from "./modules/employees/employees.routes.js";
import vehiclesRoutes from "./modules/vehicles/vehicles.routes.js";
import anafRoutes from "./modules/anaf/anaf.routes.js";
import workflowTemplatesRoutes from "./modules/workflow-templates/workflow-templates.routes.js";
import actionPlansRoutes from "./modules/action-plans/action-plans.routes.js";
import geographyRoutes from "./modules/geography/geography.routes.js";

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
  await fastify.register(documentsRoutes, { prefix: "/api/documents" });
  await fastify.register(templatesRoutes, { prefix: "/api/templates" });
  await fastify.register(tenantRoutes, { prefix: "/api/tenant" });
  await fastify.register(servicesRoutes, { prefix: "/api/services" });
  await fastify.register(employeesRoutes, { prefix: "/api/employees" });
  await fastify.register(vehiclesRoutes, { prefix: "/api/vehicles" });
  await fastify.register(anafRoutes, { prefix: "/api/anaf" });
  await fastify.register(workflowTemplatesRoutes, { prefix: "/api/workflow-templates" });
  await fastify.register(actionPlansRoutes, { prefix: "/api/action-plans" });
  await fastify.register(geographyRoutes, { prefix: "/api/geography" });

  // Health check
  fastify.get("/api/health", async () => ({ status: "ok" }));

  return fastify;
}
