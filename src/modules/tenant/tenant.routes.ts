import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { requireRole } from "../../lib/rbac.js";
import { uploadFile, getPresignedUrl, deleteFile } from "../../lib/s3.js";
import { removeWhiteBackground, normalizeLogo } from "../../lib/image.js";
import { resolveStampSlots, upsertStampSlot, STAMP_SLOTS } from "../../lib/stamps.js";
import { readCompanySettings, setCompanySettings } from "./company-settings.js";
import { ALERT_WINDOWS, getAlertWindows, setAlertWindows } from "./alert-settings.js";
import {
  SCHEDULING_MODES,
  getSchedulingSettings,
  setSchedulingSettings,
  readSchedulingSettings,
} from "./scheduling-settings.js";
import { z } from "zod";

const updateSchedulingSchema = z
  .object({
    mode: z.enum(["shared", "per_technician"]).optional(),
    warnOnOverlap: z.boolean().optional(),
    defaultDurationMinutes: z.number().int().min(5).max(480).optional(),
  })
  .strict();

// Per-key int bounds from the registry — a PATCH may send any subset of keys.
const updateAlertWindowsSchema = z
  .object(
    Object.fromEntries(
      ALERT_WINDOWS.map((w) => [w.key, z.number().int().min(w.min).max(w.max).optional()]),
    ) as Record<string, z.ZodOptional<z.ZodNumber>>,
  )
  .strict();

const updateCompanySchema = z.object({
  anreNr: z.string().max(50).optional(),
  anreTip: z.string().max(30).optional(),
  anreData: z.string().max(20).optional(),
  anreExp: z.string().max(20).optional(),
  iban: z.string().max(40).optional(),
  bank: z.string().max(80).optional(),
  operatorSistem: z.string().max(80).optional(),
});

const slotParamSchema = z.object({
  slot: z.coerce.number().int().refine((n) => (STAMP_SLOTS as readonly number[]).includes(n), {
    message: "Slot must be 1-4",
  }),
});

const updateTenantSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  address: z.string().max(200).optional().nullable(),
  phone: z.string().max(30).optional().nullable(),
  email: z.string().email().max(100).optional().nullable(),
  cui: z.string().max(20).optional().nullable(),
  regCom: z.string().max(30).optional().nullable(),
  isVatPayer: z.boolean().optional(),
  adminName: z.string().max(100).optional().nullable(),
  iscirNumber: z.string().max(50).optional().nullable(),
  iscirDate: z.string().max(20).optional().nullable(),
  countryId: z.number().int().positive().optional().nullable(),
  stateId: z.number().int().positive().optional().nullable(),
  cityId: z.number().int().positive().optional().nullable(),
});

const tenantInclude = {
  country: { select: { id: true, name: true, emoji: true } },
  state: { select: { id: true, name: true } },
  city: { select: { id: true, name: true } },
} as const;

export default async function tenantRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", fastify.authenticate);

  fastify.get("/", async (request) => {
    const tenant = await fastify.prisma.tenant.findUniqueOrThrow({
      where: { id: request.tenantId },
      include: tenantInclude,
    });

    const stampUrl = tenant.stampS3Key
      ? await getPresignedUrl(tenant.stampS3Key)
      : null;
    const signatureUrl = tenant.signatureS3Key
      ? await getPresignedUrl(tenant.signatureS3Key)
      : null;
    const logoUrl = tenant.logoS3Key
      ? await getPresignedUrl(tenant.logoS3Key)
      : null;

    // All 4 stamp slots (label + presigned url). Slot 1 mirrors stampUrl.
    const stamps = await Promise.all(
      resolveStampSlots(tenant).map(async (s) => ({
        slot: s.slot,
        label: s.label,
        url: s.s3Key ? await getPresignedUrl(s.s3Key) : null,
      })),
    );

    const company = readCompanySettings(tenant.settingsJson);
    const scheduling = readSchedulingSettings(tenant.settingsJson);
    return { ...tenant, stampUrl, signatureUrl, logoUrl, stamps, company, scheduling };
  });

  fastify.patch("/", {
    onRequest: [requireRole("ADMIN")],
    handler: async (request) => {
      const body = updateTenantSchema.parse(request.body);
      return fastify.prisma.tenant.update({
        where: { id: request.tenantId },
        data: body,
        include: tenantInclude,
      });
    },
  });

  // Firm-constant fields for official gas-installation documents (RT/PV),
  // stored in settingsJson.company (shallow-merged, other settings preserved).
  fastify.patch("/company", {
    onRequest: [requireRole("ADMIN")],
    handler: async (request) => {
      const body = updateCompanySchema.parse(request.body);
      const company = await setCompanySettings(fastify.prisma, request.tenantId, body);
      return { company };
    },
  });

  // Tenant-configurable dashboard alert windows (registry + effective values).
  fastify.get("/alert-settings", async (request) => {
    const values = await getAlertWindows(fastify.prisma, request.tenantId);
    return {
      windows: ALERT_WINDOWS.map((w) => ({ ...w, value: values[w.key] })),
    };
  });

  fastify.patch("/alert-settings", {
    onRequest: [requireRole("ADMIN")],
    handler: async (request) => {
      const body = updateAlertWindowsSchema.parse(request.body);
      const values = await setAlertWindows(fastify.prisma, request.tenantId, body);
      return {
        windows: ALERT_WINDOWS.map((w) => ({ ...w, value: values[w.key] })),
      };
    },
  });

  // Scheduling mode (shared vs per-technician calendars). Readable by any
  // authenticated user — both the dashboard and the mobile app branch on `mode`.
  fastify.get("/scheduling-settings", async (request) => {
    const values = await getSchedulingSettings(fastify.prisma, request.tenantId);
    return { modes: SCHEDULING_MODES, ...values };
  });

  fastify.patch("/scheduling-settings", {
    onRequest: [requireRole("ADMIN")],
    handler: async (request) => {
      const body = updateSchedulingSchema.parse(request.body);
      const values = await setSchedulingSettings(fastify.prisma, request.tenantId, body);
      return { modes: SCHEDULING_MODES, ...values };
    },
  });

  // Upload a stamp image into slot 1-4. Slot 1 keeps its image on
  // `stampS3Key` (backward compat); slots 2-4 store it in brandingJson.
  fastify.post("/stamp/:slot", {
    onRequest: [requireRole("ADMIN")],
    handler: async (request, reply) => {
      const { slot } = slotParamSchema.parse(request.params);
      const file = await request.file();
      if (!file) throw fastify.httpErrors.badRequest("File is required");
      if (!file.mimetype.startsWith("image/")) {
        throw fastify.httpErrors.badRequest("Only image files are allowed");
      }

      const rawBuffer = await file.toBuffer();
      // Remove background (make white/light pixels transparent) and save as PNG
      const buffer = await removeWhiteBackground(rawBuffer);
      const s3Key =
        slot === 1
          ? `${request.tenantId}/branding/stamp.png`
          : `${request.tenantId}/branding/stamp-${slot}.png`;
      await uploadFile(s3Key, buffer, "image/png");

      const tenant = await fastify.prisma.tenant.findUniqueOrThrow({
        where: { id: request.tenantId },
        select: { stampS3Key: true, brandingJson: true },
      });

      if (slot === 1) {
        if (tenant.stampS3Key && tenant.stampS3Key !== s3Key) {
          await deleteFile(tenant.stampS3Key).catch(() => {});
        }
        await fastify.prisma.tenant.update({
          where: { id: request.tenantId },
          data: { stampS3Key: s3Key },
        });
      } else {
        const prev = resolveStampSlots(tenant).find((x) => x.slot === slot)?.s3Key;
        if (prev && prev !== s3Key) await deleteFile(prev).catch(() => {});
        await fastify.prisma.tenant.update({
          where: { id: request.tenantId },
          data: {
            brandingJson: upsertStampSlot(tenant.brandingJson, slot, { s3Key }) as Prisma.InputJsonValue,
          },
        });
      }

      const url = await getPresignedUrl(s3Key);
      return reply.send({ slot, s3Key, url });
    },
  });

  // Delete a stamp image from slot 1-4 (keeps the label).
  fastify.delete("/stamp/:slot", {
    onRequest: [requireRole("ADMIN")],
    handler: async (request) => {
      const { slot } = slotParamSchema.parse(request.params);
      const tenant = await fastify.prisma.tenant.findUniqueOrThrow({
        where: { id: request.tenantId },
        select: { stampS3Key: true, brandingJson: true },
      });
      const current = resolveStampSlots(tenant).find((x) => x.slot === slot)?.s3Key;
      if (current) await deleteFile(current).catch(() => {});

      if (slot === 1) {
        await fastify.prisma.tenant.update({
          where: { id: request.tenantId },
          data: { stampS3Key: null },
        });
      } else {
        await fastify.prisma.tenant.update({
          where: { id: request.tenantId },
          data: {
            brandingJson: upsertStampSlot(tenant.brandingJson, slot, { s3Key: null }) as Prisma.InputJsonValue,
          },
        });
      }
      return { success: true };
    },
  });

  // Rename a stamp slot (label stored in brandingJson for all 4 slots).
  fastify.patch("/stamp/:slot", {
    onRequest: [requireRole("ADMIN")],
    handler: async (request) => {
      const { slot } = slotParamSchema.parse(request.params);
      const { label } = z.object({ label: z.string().min(1).max(60) }).parse(request.body);
      const tenant = await fastify.prisma.tenant.findUniqueOrThrow({
        where: { id: request.tenantId },
        select: { brandingJson: true },
      });
      await fastify.prisma.tenant.update({
        where: { id: request.tenantId },
        data: {
          brandingJson: upsertStampSlot(tenant.brandingJson, slot, { label }) as Prisma.InputJsonValue,
        },
      });
      return { success: true, slot, label };
    },
  });

  // Save signature (receives PNG data URL from canvas)
  fastify.post("/signature", {
    onRequest: [requireRole("ADMIN")],
    handler: async (request, reply) => {
      const body = z.object({ dataUrl: z.string().min(1) }).parse(request.body);

      const matches = body.dataUrl.match(/^data:image\/(png|jpeg|jpg);base64,(.+)$/);
      if (!matches) {
        throw fastify.httpErrors.badRequest("Invalid image data URL");
      }

      const buffer = Buffer.from(matches[2], "base64");
      const ext = matches[1];
      const s3Key = `${request.tenantId}/branding/signature.${ext}`;
      await uploadFile(s3Key, buffer, `image/${ext}`);

      const tenant = await fastify.prisma.tenant.findUniqueOrThrow({
        where: { id: request.tenantId },
        select: { signatureS3Key: true },
      });
      if (tenant.signatureS3Key && tenant.signatureS3Key !== s3Key) {
        await deleteFile(tenant.signatureS3Key).catch(() => {});
      }

      await fastify.prisma.tenant.update({
        where: { id: request.tenantId },
        data: { signatureS3Key: s3Key },
      });

      const signatureUrl = await getPresignedUrl(s3Key);
      return reply.send({ signatureS3Key: s3Key, signatureUrl });
    },
  });

  // Delete signature
  fastify.delete("/signature", {
    onRequest: [requireRole("ADMIN")],
    handler: async (request) => {
      const tenant = await fastify.prisma.tenant.findUniqueOrThrow({
        where: { id: request.tenantId },
        select: { signatureS3Key: true },
      });
      if (tenant.signatureS3Key) {
        await deleteFile(tenant.signatureS3Key).catch(() => {});
      }
      await fastify.prisma.tenant.update({
        where: { id: request.tenantId },
        data: { signatureS3Key: null },
      });
      return { success: true };
    },
  });

  // Upload logo. Stored as PNG (normalizeLogo) so the docx image module can
  // embed it with a single mimetype; unlike stamp/signature, no background
  // removal — a brand logo's white container is intentional.
  fastify.post("/logo", {
    onRequest: [requireRole("ADMIN")],
    handler: async (request, reply) => {
      const file = await request.file();
      if (!file) throw fastify.httpErrors.badRequest("File is required");
      if (!file.mimetype.startsWith("image/")) {
        throw fastify.httpErrors.badRequest("Only image files are allowed");
      }

      const buffer = await normalizeLogo(await file.toBuffer());
      const s3Key = `${request.tenantId}/branding/logo.png`;
      await uploadFile(s3Key, buffer, "image/png");

      await fastify.prisma.tenant.update({
        where: { id: request.tenantId },
        data: { logoS3Key: s3Key },
      });

      const logoUrl = await getPresignedUrl(s3Key);
      return reply.send({ logoS3Key: s3Key, logoUrl });
    },
  });

  fastify.delete("/logo", {
    onRequest: [requireRole("ADMIN")],
    handler: async (request) => {
      const tenant = await fastify.prisma.tenant.findUniqueOrThrow({
        where: { id: request.tenantId },
        select: { logoS3Key: true },
      });
      if (tenant.logoS3Key) {
        await deleteFile(tenant.logoS3Key).catch(() => {});
      }
      await fastify.prisma.tenant.update({
        where: { id: request.tenantId },
        data: { logoS3Key: null },
      });
      return { success: true };
    },
  });
}
