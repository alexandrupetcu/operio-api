import type { FastifyInstance } from "fastify";
import { requireRole } from "../../lib/rbac.js";
import {
  createAppointmentSchema,
  updateAppointmentSchema,
  finalizeAppointmentSchema,
  followupAppointmentSchema,
  calendarQuerySchema,
  overlapQuerySchema,
  osRegistrationSchema,
  osSubmissionSchema,
} from "./appointments.schema.js";
import { setOsRegistration, setOsSubmission } from "./os-registration.js";
import * as appointmentsService from "./appointments.service.js";
import { resolveApptScope, canSeeEmployee } from "./scope.js";
import { NO_OVERLAP } from "./overlap.js";
import { getSchedulingSettings } from "../tenant/scheduling-settings.js";
import { importAppointmentReport } from "./import-report.js";
import {
  reportFileKind,
  ACCEPTED_REPORT_FILES_MESSAGE,
  REPORT_FILE_CANONICAL_MIME,
} from "../../lib/report-sources/index.js";
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

  // Single appointment (mobile detail refresh / client history)
  fastify.get<{ Params: { id: string } }>("/:id", async (request) => {
    const scope = await resolveApptScope(fastify, request);
    return appointmentsService.getById(fastify, request.tenantId, request.params.id, scope);
  });

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

  // Urmare pe o programare deja finalizată: revenire (task) sau programare nouă,
  // fără a atinge starea programării. Idempotent pe `Idempotency-Key` (o cheie
  // deja folosită întoarce 200 cu programarea, fără alt task / altă programare).
  fastify.post<{ Params: { id: string } }>(
    "/:id/followup",
    { onRequest: [requireRole("ADMIN", "MANAGER", "OPERATOR")] },
    async (request) => {
      const body = followupAppointmentSchema.parse(request.body);
      const scope = await resolveApptScope(fastify, request);
      const rawKey = request.headers["idempotency-key"];
      const idempotencyKey = Array.isArray(rawKey) ? rawKey[0] : rawKey;
      return appointmentsService.followup(
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
  // Documentele generate pentru programare (RT/PV/FISA/ISCIR/GDPR) — detaliul din Calendar.
  fastify.get<{ Params: { id: string } }>(
    "/:id/documents",
    async (request) => {
      const scope = await resolveApptScope(fastify, request);
      return appointmentsService.listDocuments(fastify, request.tenantId, request.params.id, scope);
    }
  );

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
  // ale lui, ca la celelalte rute de programări. 60/oră: extragerea de text
  // (și, la unele surse, un apel AI) e scumpă.
  fastify.post<{ Params: { id: string } }>(
    "/:id/import-report",
    { config: { rateLimit: { max: 60, timeWindow: "1 hour" } } },
    async (request) => {
      const file = await request.file({ limits: { fileSize: IMPORT_REPORT_MAX_BYTES } });
      if (!file) throw fastify.httpErrors.badRequest("Fișierul lipsește");
      const fileKind = reportFileKind(file.filename, file.mimetype);
      if (!fileKind) throw fastify.httpErrors.badRequest(ACCEPTED_REPORT_FILES_MESSAGE);
      let buffer: Buffer;
      try {
        buffer = await file.toBuffer();
      } catch {
        throw fastify.httpErrors.payloadTooLarge("Fișierul depășește 20 MB");
      }
      if (file.file.truncated) throw fastify.httpErrors.payloadTooLarge("Fișierul depășește 20 MB");

      const scope = await resolveApptScope(fastify, request);
      // Mimetype-ul canonic al felului de fișier (după extensie) — antetul
      // clientului nu e de încredere și nu ajunge nici în S3, nici la extragere.
      const mimetype = REPORT_FILE_CANONICAL_MIME[fileKind];
      return importAppointmentReport(
        fastify,
        documentQueue,
        request.tenantId,
        request.params.id,
        scope,
        { buffer, filename: file.filename, mimetype }
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

  // Pasul intermediar: depus la OS, se așteaptă validarea și numărul.
  fastify.patch<{ Params: { id: string } }>(
    "/:id/os-submission",
    { onRequest: [requireRole("ADMIN", "MANAGER", "OPERATOR")] },
    async (request) => {
      const body = osSubmissionSchema.parse(request.body);
      return setOsSubmission(fastify, request.tenantId, request.params.id, body);
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
