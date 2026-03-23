import type { FastifyInstance } from "fastify";
import { requireRole } from "../../lib/rbac.js";
import {
  initializePlanSchema,
  updateTaskSchema,
  createTaskSchema,
  reorderTasksSchema,
} from "./action-plans.schema.js";
import * as service from "./action-plans.service.js";

export default async function actionPlansRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", fastify.authenticate);

  // Get action plan for a project
  fastify.get<{ Params: { projectId: string } }>(
    "/project/:projectId",
    async (request) => {
      return service.getByProjectId(
        fastify,
        request.tenantId,
        request.params.projectId
      );
    }
  );

  // Initialize action plan from template
  fastify.post<{ Params: { projectId: string } }>(
    "/project/:projectId/initialize",
    { onRequest: [requireRole("ADMIN", "MANAGER")] },
    async (request, reply) => {
      const body = initializePlanSchema.parse(request.body);
      const plan = await service.initializeFromTemplate(
        fastify,
        request.tenantId,
        request.params.projectId,
        body
      );
      return reply.status(201).send(plan);
    }
  );

  // Add custom task to a project's action plan
  fastify.post<{ Params: { projectId: string } }>(
    "/project/:projectId/tasks",
    { onRequest: [requireRole("ADMIN", "MANAGER")] },
    async (request, reply) => {
      const body = createTaskSchema.parse(request.body);
      const task = await service.addTask(
        fastify,
        request.tenantId,
        request.params.projectId,
        body
      );
      return reply.status(201).send(task);
    }
  );

  // Reorder tasks
  fastify.patch<{ Params: { projectId: string } }>(
    "/project/:projectId/reorder",
    { onRequest: [requireRole("ADMIN", "MANAGER")] },
    async (request) => {
      const body = reorderTasksSchema.parse(request.body);
      return service.reorderTasks(
        fastify,
        request.tenantId,
        request.params.projectId,
        body
      );
    }
  );

  // Update a task
  fastify.patch<{ Params: { taskId: string } }>(
    "/tasks/:taskId",
    async (request) => {
      const body = updateTaskSchema.parse(request.body);
      return service.updateTask(
        fastify,
        request.tenantId,
        request.params.taskId,
        body
      );
    }
  );

  // Delete a task
  fastify.delete<{ Params: { taskId: string } }>(
    "/tasks/:taskId",
    { onRequest: [requireRole("ADMIN", "MANAGER")] },
    async (request) => {
      return service.removeTask(
        fastify,
        request.tenantId,
        request.params.taskId
      );
    }
  );

  // Get deadlines across all projects
  fastify.get("/deadlines", async (request) => {
    const { daysAhead, includeOverdue } = request.query as Record<
      string,
      string
    >;
    return service.getDeadlines(
      fastify,
      request.tenantId,
      daysAhead ? parseInt(daysAhead, 10) : undefined,
      includeOverdue !== "false"
    );
  });
}
