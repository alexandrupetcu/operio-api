import type { FastifyInstance } from "fastify";
import { requireRole } from "../../lib/rbac.js";
import { paginationSchemaFor } from "../../lib/pagination.js";
import { z } from "zod";
import * as employeesService from "./employees.service.js";
import { EMPLOYEES_SORTABLE } from "./employees.service.js";
import { getSchedulingSettings } from "../tenant/scheduling-settings.js";
import { CERT_TYPES, SIGNATORY_ROLES } from "../../lib/certifications.js";
import { invalidateReadiness } from "../tenant/readiness.js";
import {
  certificationInputSchema,
  certificationUpdateSchema,
  listCertifications,
  createCertification,
  updateCertification,
  deleteCertification,
} from "./certifications.service.js";
import {
  stampInputSchema,
  stampUpdateSchema,
  listStamps,
  createStamp,
  updateStamp,
  deleteStamp,
  setStampImage,
  removeStampImage,
} from "./stamps.service.js";
import { logAudit } from "../../lib/audit.js";

const listQuerySchema = paginationSchemaFor(EMPLOYEES_SORTABLE);

const createSchema = z.object({
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  employeeType: z.enum(["intern", "colaborator"]).default("intern"),
  position: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().max(100).optional().nullable(),
  ),
  // Toate funcțiile (un om poate fi instalator și șef de șantier); prima devine `position`.
  positions: z.array(z.string().max(100)).max(20).optional(),
  phone: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().max(30).optional().nullable(),
  ),
  email: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().email().optional().nullable(),
  ),
  credentials: z.record(z.string()).optional(),
});

const updateSchema = createSchema.partial().extend({
  isActive: z.boolean().optional(),
});

export type CreateEmployeeInput = z.infer<typeof createSchema>;
export type UpdateEmployeeInput = z.infer<typeof updateSchema>;

export default async function employeesRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", fastify.authenticate);

  fastify.get("/", async (request) => {
    const query = listQuerySchema.parse(request.query);
    const { isActive, employeeType } = request.query as Record<string, string>;
    // În modul cu calendare separate, un tehnician nu are de ce să vadă echipa:
    // pe telefon nu mai alege tehnicianul, iar ocuparea colegilor e informație
    // despre programul lor. Primește doar propria fișă.
    let onlyUserId: string | undefined;
    if (request.user?.role === "OPERATOR") {
      const scheduling = await getSchedulingSettings(fastify.prisma, request.tenantId);
      if (scheduling.mode === "per_technician") onlyUserId = request.user.sub;
    }
    return employeesService.list(fastify, request.tenantId, {
      ...query,
      isActive: isActive === undefined ? undefined : isActive === "true",
      employeeType: employeeType || undefined,
      onlyUserId,
    });
  });

  // Catalogul de certificări (ANRE / ISCIR / construcții) + rolurile de semnatar.
  fastify.get("/certification-types", async () => ({ types: CERT_TYPES, signatoryRoles: SIGNATORY_ROLES }));

  fastify.get("/stats", async (request) => {
    return employeesService.stats(fastify, request.tenantId);
  });

  fastify.get<{ Params: { id: string } }>("/:id", async (request) => {
    return employeesService.getById(fastify, request.tenantId, request.params.id);
  });

  fastify.get<{ Params: { id: string } }>("/:id/projects", async (request) => {
    return employeesService.listEmployeeProjects(fastify, request.tenantId, request.params.id);
  });

  fastify.get<{ Params: { id: string } }>("/:id/activity", async (request) => {
    return employeesService.listEmployeeActivity(fastify, request.tenantId, request.params.id);
  });

  fastify.post("/", {
    onRequest: [requireRole("ADMIN", "MANAGER")],
    handler: async (request, reply) => {
      const body = createSchema.parse(request.body);
      const employee = await employeesService.create(fastify, request.tenantId, body);
      await logAudit(fastify, request.tenantId, request.user.sub, "employee", employee.id, "employee.created");
      invalidateReadiness(request.tenantId);
      return reply.status(201).send(employee);
    },
  });

  fastify.patch<{ Params: { id: string } }>("/:id", {
    onRequest: [requireRole("ADMIN", "MANAGER")],
    handler: async (request) => {
      const body = updateSchema.parse(request.body);
      const updated = await employeesService.update(fastify, request.tenantId, request.params.id, body);
      await logAudit(fastify, request.tenantId, request.user.sub, "employee", request.params.id, "employee.updated", undefined, {
        fields: Object.keys(body),
      });
      invalidateReadiness(request.tenantId); // activ/inactiv schimbă avertismentele de semnatari
      return updated;
    },
  });

  fastify.delete<{ Params: { id: string } }>("/:id", {
    onRequest: [requireRole("ADMIN", "MANAGER")],
    handler: async (request) => {
      const removed = await employeesService.remove(fastify, request.tenantId, request.params.id);
      invalidateReadiness(request.tenantId);
      return removed;
    },
  });

  // ── Certificări (legitimații ANRE, atestate ISCIR, RTE…) ────────────────
  type CertParams = { id: string; certId: string };

  fastify.get<{ Params: { id: string } }>("/:id/certifications", async (request) => {
    return listCertifications(fastify, request.tenantId, request.params.id);
  });

  fastify.post<{ Params: { id: string } }>("/:id/certifications", {
    onRequest: [requireRole("ADMIN", "MANAGER")],
    handler: async (request, reply) => {
      const body = certificationInputSchema.parse(request.body);
      return reply
        .status(201)
        .send(await createCertification(fastify, request.tenantId, request.params.id, body, request.user.sub));
    },
  });

  fastify.patch<{ Params: CertParams }>("/:id/certifications/:certId", {
    onRequest: [requireRole("ADMIN", "MANAGER")],
    handler: async (request) => {
      const body = certificationUpdateSchema.parse(request.body);
      return updateCertification(fastify, request.tenantId, request.params.id, request.params.certId, body, request.user.sub);
    },
  });

  fastify.delete<{ Params: CertParams }>("/:id/certifications/:certId", {
    onRequest: [requireRole("ADMIN", "MANAGER")],
    handler: async (request) =>
      deleteCertification(fastify, request.tenantId, request.params.id, request.params.certId, request.user.sub),
  });

  // ── Ștampile (o ștampilă include 1..n certificări ale aceleiași autorități) ──
  type StampParams = { id: string; stampId: string };

  fastify.get<{ Params: { id: string } }>("/:id/stamps", async (request) => {
    return listStamps(fastify, request.tenantId, request.params.id);
  });

  fastify.post<{ Params: { id: string } }>("/:id/stamps", {
    onRequest: [requireRole("ADMIN", "MANAGER")],
    handler: async (request, reply) => {
      const body = stampInputSchema.parse(request.body);
      return reply.status(201).send(await createStamp(fastify, request.tenantId, request.params.id, body, request.user.sub));
    },
  });

  fastify.patch<{ Params: StampParams }>("/:id/stamps/:stampId", {
    onRequest: [requireRole("ADMIN", "MANAGER")],
    handler: async (request) => {
      const body = stampUpdateSchema.parse(request.body);
      return updateStamp(fastify, request.tenantId, request.params.id, request.params.stampId, body, request.user.sub);
    },
  });

  fastify.delete<{ Params: StampParams }>("/:id/stamps/:stampId", {
    onRequest: [requireRole("ADMIN", "MANAGER")],
    handler: async (request) => deleteStamp(fastify, request.tenantId, request.params.id, request.params.stampId, request.user.sub),
  });

  fastify.post<{ Params: StampParams }>("/:id/stamps/:stampId/image", {
    onRequest: [requireRole("ADMIN", "MANAGER")],
    handler: async (request) => {
      const file = await request.file();
      if (!file) throw fastify.httpErrors.badRequest("Alege o imagine cu ștampila");
      if (!file.mimetype.startsWith("image/")) throw fastify.httpErrors.badRequest("Ștampila trebuie să fie o imagine");
      return setStampImage(fastify, request.tenantId, request.params.id, request.params.stampId, await file.toBuffer(), request.user.sub);
    },
  });

  fastify.delete<{ Params: StampParams }>("/:id/stamps/:stampId/image", {
    onRequest: [requireRole("ADMIN", "MANAGER")],
    handler: async (request) => removeStampImage(fastify, request.tenantId, request.params.id, request.params.stampId, request.user.sub),
  });

  // Invitație în aplicația mobilă (text WhatsApp/SMS + e-mailul contului legat).
  // Nu trimite nimic — întoarce mesajul și linkul wa.me, operatorul alege canalul.
  fastify.post<{ Params: { id: string } }>("/:id/invite", {
    onRequest: [requireRole("ADMIN", "MANAGER")],
    handler: async (request) => {
      return employeesService.buildInvite(fastify, request.tenantId, request.params.id);
    },
  });

  // Save signature drawn on the canvas (PNG data URL) — placed on generated
  // documents as {role}_signature.
  fastify.post<{ Params: { id: string } }>("/:id/signature", {
    onRequest: [requireRole("ADMIN", "MANAGER")],
    handler: async (request, reply) => {
      const { dataUrl } = z.object({ dataUrl: z.string().min(1) }).parse(request.body);
      const result = await employeesService.setSignature(
        fastify,
        request.tenantId,
        request.params.id,
        dataUrl,
      );
      await logAudit(fastify, request.tenantId, request.user.sub, "employee", request.params.id, "signature.set");
      return reply.send(result);
    },
  });

  fastify.delete<{ Params: { id: string } }>("/:id/signature", {
    onRequest: [requireRole("ADMIN", "MANAGER")],
    handler: async (request) => {
      const removed = await employeesService.removeSignature(fastify, request.tenantId, request.params.id);
      await logAudit(fastify, request.tenantId, request.user.sub, "employee", request.params.id, "signature.removed");
      return removed;
    },
  });
}
