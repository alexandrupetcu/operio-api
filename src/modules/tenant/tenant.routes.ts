import type { FastifyInstance } from "fastify";
import { requireRole } from "../../lib/rbac.js";
import { uploadFile, getPresignedUrl, deleteFile } from "../../lib/s3.js";
import { z } from "zod";
import sharp from "sharp";

/** Remove the background from a stamp image by making near-white pixels transparent */
async function removeStampBackground(input: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(input)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const threshold = 200; // pixels with R,G,B all above this become transparent
  const pixels = new Uint8Array(data);

  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    if (r > threshold && g > threshold && b > threshold) {
      pixels[i + 3] = 0; // set alpha to 0 (transparent)
    }
  }

  return sharp(Buffer.from(pixels), {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .png()
    .toBuffer();
}

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

    return { ...tenant, stampUrl, signatureUrl };
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

  // Upload stamp image
  fastify.post("/stamp", {
    onRequest: [requireRole("ADMIN")],
    handler: async (request, reply) => {
      const file = await request.file();
      if (!file) throw fastify.httpErrors.badRequest("File is required");

      if (!file.mimetype.startsWith("image/")) {
        throw fastify.httpErrors.badRequest("Only image files are allowed");
      }

      const rawBuffer = await file.toBuffer();
      // Remove background (make white/light pixels transparent) and save as PNG
      const buffer = await removeStampBackground(rawBuffer);
      const s3Key = `${request.tenantId}/branding/stamp.png`;
      await uploadFile(s3Key, buffer, "image/png");

      const tenant = await fastify.prisma.tenant.findUniqueOrThrow({
        where: { id: request.tenantId },
        select: { stampS3Key: true },
      });
      if (tenant.stampS3Key && tenant.stampS3Key !== s3Key) {
        await deleteFile(tenant.stampS3Key).catch(() => {});
      }

      await fastify.prisma.tenant.update({
        where: { id: request.tenantId },
        data: { stampS3Key: s3Key },
      });

      const stampUrl = await getPresignedUrl(s3Key);
      return reply.send({ stampS3Key: s3Key, stampUrl });
    },
  });

  // Delete stamp
  fastify.delete("/stamp", {
    onRequest: [requireRole("ADMIN")],
    handler: async (request) => {
      const tenant = await fastify.prisma.tenant.findUniqueOrThrow({
        where: { id: request.tenantId },
        select: { stampS3Key: true },
      });
      if (tenant.stampS3Key) {
        await deleteFile(tenant.stampS3Key).catch(() => {});
      }
      await fastify.prisma.tenant.update({
        where: { id: request.tenantId },
        data: { stampS3Key: null },
      });
      return { success: true };
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
}
