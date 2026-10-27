import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole } from "../../lib/rbac.js";
import { resolveApptScope, requesterEmployeeId } from "../appointments/scope.js";
import { previewReportFile } from "../appointments/import-report.js";
import { reportFileKind, ACCEPTED_REPORT_FILES_MESSAGE, REPORT_FILE_CANONICAL_MIME } from "../../lib/report-sources/index.js";
import * as revisionsService from "./revisions.service.js";
import { createDirectRevisionSchema, listRevisionsQuerySchema, REVISION_TYPES } from "./revisions.schema.js";

const PARSE_REPORT_MAX_BYTES = 20 * 1024 * 1024;

/** Secțiunea „Revizii”: lista tuturor reviziilor firmei + revizie fără programare. */
export default async function revisionsRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", fastify.authenticate);

  fastify.get("/", async (request) => {
    const scope = await resolveApptScope(fastify, request);
    return revisionsService.list(fastify, request.tenantId, listRevisionsQuerySchema.parse(request.query), scope);
  });

  // Precompletarea din web: citește raportul analizorului înainte ca vizita să existe
  // (nu salvează nimic; fișierul se leagă de revizie la finalizare, prin `upload-pdf`).
  // Aceeași limită ca la import: extragerea de text (și, la unele surse, un apel AI) e scumpă.
  fastify.post(
    "/parse-report",
    { config: { rateLimit: { max: 60, timeWindow: "1 hour" } } },
    async (request) => {
      const { type } = z.object({ type: z.enum(REVISION_TYPES).default("revizie") }).parse(request.query);
      const file = await request.file({ limits: { fileSize: PARSE_REPORT_MAX_BYTES } });
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
      return previewReportFile(fastify, request.tenantId, type, { buffer, filename: file.filename, mimetype: REPORT_FILE_CANONICAL_MIME[fileKind] });
    },
  );

  fastify.post("/", { onRequest: [requireRole("ADMIN", "MANAGER", "OPERATOR")] }, async (request, reply) => {
    const body = createDirectRevisionSchema.parse(request.body);
    const rawKey = request.headers["idempotency-key"];
    const idempotencyKey = Array.isArray(rawKey) ? rawKey[0] : rawKey;
    const appt = await revisionsService.createDirect(
      fastify,
      request.tenantId,
      body,
      idempotencyKey?.trim() || null,
      { defaultEmployeeId: body.employeeId == null ? await requesterEmployeeId(fastify, request) : undefined },
      request.user.sub,
    );
    return reply.status(201).send(appt);
  });
}
