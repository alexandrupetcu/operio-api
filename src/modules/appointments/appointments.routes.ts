import type { FastifyInstance } from "fastify";
import { requireRole } from "../../lib/rbac.js";
import {
  createAppointmentSchema,
  updateAppointmentSchema,
  finalizeAppointmentSchema,
  calendarQuerySchema,
  overlapQuerySchema,
  osRegistrationSchema,
} from "./appointments.schema.js";
import { setOsRegistration } from "./os-registration.js";
import * as appointmentsService from "./appointments.service.js";
import { resolveApptScope, canSeeEmployee } from "./scope.js";
import { NO_OVERLAP } from "./overlap.js";
import { getSchedulingSettings } from "../tenant/scheduling-settings.js";
import { importAppointmentReport } from "./import-report.js";
import { Queue } from "bullmq";
import { redisConnection } from "../../config/redis.js";
import { defaultJobOptions } from "../../config/queue.js";

const documentQueue = new Queue("document-generation", { connection: redisConnection, defaultJobOptions });

const IMPORT_REPORT_MAX_BYTES = 20 * 1024 * 1024;

export default async function appointmentsRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", fastify.authenticate);

  // List appointments (optionally filtered by project)
  fastify.get<{ Querystring: { projectId?: string } }>(
    "/",
    async (request) => {
      const { projectId } = request.query as { projectId?: string };
      const scope = await resolveApptScope(fastify, request);
      return appointmentsService.listByProject(
        fastify,
        request.tenantId,
        projectId,
        scope
      );
    }
  );

  // Calendar view
  fastify.get<{ Querystring: { from: string; to: string; employeeId?: string } }>(
    "/calendar",
    async (request) => {
      const { from, to, employeeId } = calendarQuerySchema.parse(request.query);
      const scope = await resolveApptScope(fastify, request);
      return appointmentsService.calendar(
        fastify,
        request.tenantId,
        new Date(from),
        new Date(to),
        scope,
        employeeId
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
      const scope = await resolveApptScope(fastify, request);
      return appointmentsService.update(
        fastify,
        request.tenantId,
        request.params.id,
        body,
        scope
      );
    }
  );

  // Finalize appointment (revizie-specific flow with outcome + report data)
  fastify.post<{ Params: { id: string } }>(
    "/:id/finalize",
    { onRequest: [requireRole("ADMIN", "MANAGER", "OPERATOR")] },
    async (request) => {
      const body = finalizeAppointmentSchema.parse(request.body);
      const scope = await resolveApptScope(fastify, request);
      // Retrimiterea aceleiași cereri (cu același Idempotency-Key) întoarce 200 cu
      // programarea deja finalizată; altfel o a doua finalizare dă 409.
      const rawKey = request.headers["idempotency-key"];
      const idempotencyKey = Array.isArray(rawKey) ? rawKey[0] : rawKey;
      return appointmentsService.finalize(
        fastify,
        request.tenantId,
        request.params.id,
        body,
        scope,
        idempotencyKey?.trim() || null
      );
    }
  );

  // Verificare de suprapunere înainte de salvare. Doar informativ — nimic din
  // ce întoarce nu blochează crearea.
  fastify.get<{ Querystring: Record<string, string> }>(
    "/overlaps",
    async (request) => {
      const q = overlapQuerySchema.parse(request.query);
      const scope = await resolveApptScope(fastify, request);
      // Un tehnician poate întreba doar despre propriul program: ocuparea unui
      // coleg e informație despre ziua lui.
      if (!canSeeEmployee(scope, q.employeeId)) {
        throw fastify.httpErrors.forbidden("Nu poți verifica programul altui tehnician");
      }
      const settings = await getSchedulingSettings(fastify.prisma, request.tenantId);
      if (!settings.warnOnOverlap) return NO_OVERLAP;
      return appointmentsService.checkOverlaps(fastify, request.tenantId, {
        employeeId: q.employeeId,
        start: new Date(q.date),
        duration: q.duration ?? null,
        excludeId: q.excludeId,
      });
    }
  );

  // Field shortcut — what the technician can carry over from the installation
  // and from the last report at this address (see instalatiePrefill).
  fastify.get<{ Params: { id: string } }>(
    "/:id/instalatie-prefill",
    async (request) => {
      const scope = await resolveApptScope(fastify, request);
      return appointmentsService.instalatiePrefill(
        fastify,
        request.tenantId,
        request.params.id,
        scope
      );
    }
  );

  // Import din teren: PDF-ul analizorului încărcat direct pe programare (vezi
  // import-report.ts). Orice rol care vede programarea — un tehnician doar pe
  // ale lui, ca la celelalte rute de programări.
  fastify.post<{ Params: { id: string } }>(
    "/:id/import-report",
    async (request) => {
      const file = await request.file({ limits: { fileSize: IMPORT_REPORT_MAX_BYTES } });
      if (!file) throw fastify.httpErrors.badRequest("Fișierul lipsește");
      if (file.mimetype !== "application/pdf" && !file.filename.toLowerCase().endsWith(".pdf")) {
        throw fastify.httpErrors.badRequest("Doar fișiere PDF sunt acceptate");
      }
      let buffer: Buffer;
      try {
        buffer = await file.toBuffer();
      } catch {
        throw fastify.httpErrors.payloadTooLarge("Fișierul depășește 20 MB");
      }
      if (file.file.truncated) throw fastify.httpErrors.payloadTooLarge("Fișierul depășește 20 MB");

      const scope = await resolveApptScope(fastify, request);
      return importAppointmentReport(
        fastify,
        documentQueue,
        request.tenantId,
        request.params.id,
        scope,
        { buffer, filename: file.filename, mimetype: "application/pdf" }
      );
    }
  );

  // Regenerate the instalație document set for an already-finalized appointment
  fastify.post<{ Params: { id: string } }>(
    "/:id/regenerate-documents",
    { onRequest: [requireRole("ADMIN", "MANAGER")] },
    async (request, reply) => {
      const result = await appointmentsService.regenerateInstalatieDocuments(
        fastify,
        request.tenantId,
        request.params.id
      );
      return reply.status(202).send(result);
    }
  );

  // Numărul de înregistrare al Fișei de evidență la OS (Ord. ANRE 179/2015, art. 9).
  // Trimite automat clientului exemplarul cu numărul, dacă are e-mail.
  fastify.patch<{ Params: { id: string } }>(
    "/:id/os-registration",
    { onRequest: [requireRole("ADMIN", "MANAGER", "OPERATOR")] },
    async (request) => {
      const body = osRegistrationSchema.parse(request.body);
      return setOsRegistration(fastify, request.tenantId, request.params.id, body);
    }
  );

  // Delete (archive) appointment — soft delete
  fastify.delete<{ Params: { id: string } }>(
    "/:id",
    { onRequest: [requireRole("ADMIN", "MANAGER", "OPERATOR")] },
    async (request) => {
      const scope = await resolveApptScope(fastify, request);
      return appointmentsService.remove(
        fastify,
        request.tenantId,
        request.params.id,
        scope
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
