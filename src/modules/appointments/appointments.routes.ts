import type { FastifyInstance } from "fastify";
import { requireRole } from "../../lib/rbac.js";
import { createAppointmentSchema, updateAppointmentSchema, finalizeAppointmentSchema } from "./appointments.schema.js";
import * as appointmentsService from "./appointments.service.js";

export default async function appointmentsRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", fastify.authenticate);

  // List appointments (optionally filtered by project)
  fastify.get<{ Querystring: { projectId?: string } }>(
    "/",
    async (request) => {
      const { projectId } = request.query as { projectId?: string };
      return appointmentsService.listByProject(
        fastify,
        request.tenantId,
        projectId
      );
    }
  );

  // Calendar view
  fastify.get<{ Querystring: { from: string; to: string } }>(
    "/calendar",
    async (request) => {
      const { from, to } = request.query as { from: string; to: string };
      if (!from || !to) {
        throw fastify.httpErrors.badRequest("from and to are required");
      }
      return appointmentsService.calendar(
        fastify,
        request.tenantId,
        new Date(from),
        new Date(to)
      );
    }
  );

  // Create appointment
  fastify.post(
    "/",
    { onRequest: [requireRole("ADMIN", "MANAGER", "OPERATOR")] },
    async (request, reply) => {
      const body = createAppointmentSchema.parse(request.body);
      const appointment = await appointmentsService.create(
        fastify,
        request.tenantId,
        body
      );
      return reply.status(201).send(appointment);
    }
  );

  // Update appointment
  fastify.patch<{ Params: { id: string } }>(
    "/:id",
    { onRequest: [requireRole("ADMIN", "MANAGER", "OPERATOR")] },
    async (request) => {
      const body = updateAppointmentSchema.parse(request.body);
      return appointmentsService.update(
        fastify,
        request.tenantId,
        request.params.id,
        body
      );
    }
  );

  // Finalize appointment (revizie-specific flow with outcome + report data)
  fastify.post<{ Params: { id: string } }>(
    "/:id/finalize",
    { onRequest: [requireRole("ADMIN", "MANAGER", "OPERATOR")] },
    async (request) => {
      const body = finalizeAppointmentSchema.parse(request.body);
      return appointmentsService.finalize(
        fastify,
        request.tenantId,
        request.params.id,
        body
      );
    }
  );

  // Delete (archive) appointment — soft delete
  fastify.delete<{ Params: { id: string } }>(
    "/:id",
    { onRequest: [requireRole("ADMIN", "MANAGER", "OPERATOR")] },
    async (request) => {
      return appointmentsService.remove(
        fastify,
        request.tenantId,
        request.params.id
      );
    }
  );

  // List archived appointments
  fastify.get<{ Querystring: { projectId?: string } }>(
    "/archived",
    { onRequest: [requireRole("ADMIN", "MANAGER")] },
    async (request) => {
      const { projectId } = request.query as { projectId?: string };
      return appointmentsService.listArchived(
        fastify,
        request.tenantId,
        projectId
      );
    }
  );

  // Restore archived appointment
  fastify.post<{ Params: { id: string } }>(
    "/:id/restore",
    { onRequest: [requireRole("ADMIN", "MANAGER")] },
    async (request) => {
      return appointmentsService.restore(
        fastify,
        request.tenantId,
        request.params.id
      );
    }
  );
}
