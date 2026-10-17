import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole } from "../../lib/rbac.js";
import { buildAnexa6Workbook } from "./anre-reports.service.js";

const yearQuery = z.object({
  year: z.coerce.number().int().min(2015).max(2100).optional(),
});

export default async function anreReportsRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", fastify.authenticate);

  // Registrul anual Anexa 6 + centralizatorul formularelor de apreciere, ca .xlsx.
  fastify.get(
    "/anexa6",
    { onRequest: [requireRole("ADMIN", "MANAGER", "OPERATOR")] },
    async (request, reply) => {
      const { year = new Date().getFullYear() } = yearQuery.parse(request.query);
      const { buffer, filename } = await buildAnexa6Workbook(fastify, request.tenantId, year);
      return reply
        .header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        .header("Content-Disposition", `attachment; filename="${encodeURIComponent(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`)
        .send(buffer);
    }
  );
}
