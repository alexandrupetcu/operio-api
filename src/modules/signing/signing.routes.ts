import type { FastifyInstance } from "fastify";
import { z } from "zod";
import crypto from "crypto";
import { requireRole } from "../../lib/rbac.js";
import { getFileStream } from "../../lib/s3.js";
import { sendSigningInvitation } from "../../lib/email.js";
import { env } from "../../config/env.js";

const createSessionSchema = z.object({
  documentId: z.string().min(1),
  message: z.string().optional(),
  expiresInDays: z.number().int().min(1).max(90).default(7),
  signatories: z
    .array(
      z.object({
        name: z.string().min(1),
        email: z.string().email(),
        phone: z.string().optional(),
        role: z.string().min(1),
      })
    )
    .min(1),
});

async function streamToBuffer(stream: any): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function computeDocumentHash(s3Key: string): Promise<string> {
  const stream = await getFileStream(s3Key);
  if (!stream) throw new Error("Document file not found in S3");
  const buffer = await streamToBuffer(stream);
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export default async function signingRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", fastify.authenticate);

  // Create signing session
  fastify.post("/", {
    onRequest: [requireRole("ADMIN", "MANAGER")],
    handler: async (request, reply) => {
      const body = createSessionSchema.parse(request.body);

      const document = await fastify.prisma.document.findFirst({
        where: { id: body.documentId, tenantId: request.tenantId, status: "COMPLETED" },
      });
      if (!document) {
        throw fastify.httpErrors.notFound("Document not found or not in COMPLETED status");
      }
      if (!document.s3Key) {
        throw fastify.httpErrors.badRequest("Document has no generated file");
      }

      const documentHash = await computeDocumentHash(document.s3Key);
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + body.expiresInDays);

      const session = await fastify.prisma.signingSession.create({
        data: {
          tenantId: request.tenantId,
          documentId: body.documentId,
          createdById: request.user.sub,
          message: body.message,
          documentHash,
          expiresAt,
          signatories: {
            create: body.signatories.map((s, i) => ({
              name: s.name,
              email: s.email,
              phone: s.phone,
              role: s.role,
              signOrder: i + 1,
            })),
          },
        },
        include: { signatories: true },
      });

      // Log audit event
      await fastify.prisma.signingEvent.create({
        data: {
          signingSessionId: session.id,
          eventType: "SESSION_CREATED",
          documentHash,
          ipAddress: request.ip,
          userAgent: request.headers["user-agent"] || null,
          metadata: { createdBy: request.user.sub, signatoryCount: body.signatories.length },
        },
      });

      // Log operator signature if tenant has stamp/signature configured
      const tenant = await fastify.prisma.tenant.findUniqueOrThrow({
        where: { id: request.tenantId },
        select: { stampS3Key: true, signatureS3Key: true, name: true },
      });

      if (tenant.stampS3Key || tenant.signatureS3Key) {
        await fastify.prisma.signingEvent.create({
          data: {
            signingSessionId: session.id,
            eventType: "OPERATOR_SIGNATURE_APPLIED",
            documentHash,
            ipAddress: request.ip,
            userAgent: request.headers["user-agent"] || null,
            metadata: {
              method: "automatic",
              tenantName: tenant.name,
              hasStamp: !!tenant.stampS3Key,
              hasSignature: !!tenant.signatureS3Key,
              appliedAt: "document_generation",
            },
          },
        });
      }

      // Update document status
      await fastify.prisma.document.update({
        where: { id: body.documentId },
        data: { status: "SIGNING" },
      });

      return reply.status(201).send(session);
    },
  });

  // Get signing sessions for a document
  fastify.get<{ Params: { documentId: string } }>(
    "/document/:documentId",
    async (request) => {
      return fastify.prisma.signingSession.findMany({
        where: { documentId: request.params.documentId, tenantId: request.tenantId },
        include: {
          signatories: { orderBy: { signOrder: "asc" } },
          events: { orderBy: { createdAt: "asc" } },
        },
        orderBy: { createdAt: "desc" },
      });
    }
  );

  // Send/resend invitations
  fastify.post<{ Params: { sessionId: string } }>(
    "/:sessionId/send",
    {
      onRequest: [requireRole("ADMIN", "MANAGER")],
      handler: async (request) => {
        const session = await fastify.prisma.signingSession.findFirst({
          where: { id: request.params.sessionId, tenantId: request.tenantId },
          include: {
            signatories: { where: { status: "PENDING" } },
            document: { select: { name: true } },
          },
        });
        if (!session) throw fastify.httpErrors.notFound("Signing session not found");
        if (session.status === "CANCELLED" || session.status === "EXPIRED") {
          throw fastify.httpErrors.badRequest("Session is no longer active");
        }

        const tenant = await fastify.prisma.tenant.findUniqueOrThrow({
          where: { id: request.tenantId },
          select: { name: true },
        });

        for (const signatory of session.signatories) {
          const signingUrl = `${env.FRONTEND_URL}/sign/${signatory.token}`;
          await sendSigningInvitation({
            to: signatory.email,
            signatoryName: signatory.name,
            documentName: session.document.name,
            signingUrl,
            message: session.message,
            tenantName: tenant.name,
          });

          await fastify.prisma.signingEvent.create({
            data: {
              signingSessionId: session.id,
              signatoryId: signatory.id,
              eventType: "INVITATION_SENT",
              documentHash: session.documentHash,
              ipAddress: request.ip,
              userAgent: request.headers["user-agent"] || null,
              metadata: { email: signatory.email },
            },
          });
        }

        if (session.status === "DRAFT") {
          await fastify.prisma.signingSession.update({
            where: { id: session.id },
            data: { status: "IN_PROGRESS" },
          });
        }

        return { sent: session.signatories.length };
      },
    }
  );

  // Cancel signing session
  fastify.delete<{ Params: { sessionId: string } }>(
    "/:sessionId",
    {
      onRequest: [requireRole("ADMIN", "MANAGER")],
      handler: async (request) => {
        const session = await fastify.prisma.signingSession.findFirst({
          where: { id: request.params.sessionId, tenantId: request.tenantId },
        });
        if (!session) throw fastify.httpErrors.notFound("Signing session not found");

        await fastify.prisma.signingSession.update({
          where: { id: session.id },
          data: { status: "CANCELLED" },
        });

        await fastify.prisma.signingEvent.create({
          data: {
            signingSessionId: session.id,
            eventType: "SESSION_CANCELLED",
            documentHash: session.documentHash,
            ipAddress: request.ip,
            userAgent: request.headers["user-agent"] || null,
            metadata: { cancelledBy: request.user.sub },
          },
        });

        // Revert document status if no other active sessions
        const otherActive = await fastify.prisma.signingSession.count({
          where: {
            documentId: session.documentId,
            id: { not: session.id },
            status: { in: ["DRAFT", "IN_PROGRESS"] },
          },
        });
        if (otherActive === 0) {
          await fastify.prisma.document.update({
            where: { id: session.documentId },
            data: { status: "COMPLETED" },
          });
        }

        return { success: true };
      },
    }
  );
}
