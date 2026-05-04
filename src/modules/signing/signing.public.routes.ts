import type { FastifyInstance } from "fastify";
import { z } from "zod";
import crypto from "crypto";
import { Queue } from "bullmq";
import { redisConnection } from "../../config/redis.js";
import { getFileStream, getPresignedUrl, uploadFile } from "../../lib/s3.js";

const signingCompleteQueue = new Queue("signing-complete", { connection: redisConnection });

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

export default async function signingPublicRoutes(fastify: FastifyInstance) {
  // NO authentication hook — these are public routes

  // Get signing page data
  fastify.get<{ Params: { token: string } }>("/:token", async (request) => {
    const signatory = await fastify.prisma.signatory.findUnique({
      where: { token: request.params.token },
      include: {
        signingSession: {
          include: {
            document: { select: { id: true, name: true, s3Key: true } },
            signatories: {
              select: { id: true, name: true, role: true, status: true, signOrder: true },
              orderBy: { signOrder: "asc" },
            },
          },
        },
      },
    });

    if (!signatory) {
      throw fastify.httpErrors.notFound("Invalid signing link");
    }

    const session = signatory.signingSession;

    // Log document viewed event
    await fastify.prisma.signingEvent.create({
      data: {
        signingSessionId: session.id,
        signatoryId: signatory.id,
        eventType: "DOCUMENT_VIEWED",
        documentHash: session.documentHash,
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"] || null,
      },
    });

    // Check session state
    const now = new Date();
    if (session.status === "CANCELLED") {
      return { status: "cancelled", documentName: session.document.name };
    }
    if (session.status === "EXPIRED" || session.expiresAt < now) {
      if (session.status !== "EXPIRED") {
        await fastify.prisma.signingSession.update({
          where: { id: session.id },
          data: { status: "EXPIRED" },
        });
      }
      return { status: "expired", documentName: session.document.name };
    }
    if (session.status === "COMPLETED") {
      return { status: "completed", documentName: session.document.name };
    }
    if (signatory.status === "SIGNED") {
      return {
        status: "already_signed",
        documentName: session.document.name,
        signedAt: signatory.signedAt,
      };
    }
    if (signatory.status === "DECLINED") {
      return { status: "declined", documentName: session.document.name };
    }

    return {
      status: "pending",
      documentName: session.document.name,
      signatory: {
        id: signatory.id,
        name: signatory.name,
        email: signatory.email,
        role: signatory.role,
      },
      signatories: session.signatories.map((s) => ({
        name: s.name,
        role: s.role,
        status: s.status,
        signOrder: s.signOrder,
      })),
      expiresAt: session.expiresAt,
    };
  });

  // Get document preview URL
  fastify.get<{ Params: { token: string } }>("/:token/document", async (request) => {
    const signatory = await fastify.prisma.signatory.findUnique({
      where: { token: request.params.token },
      include: {
        signingSession: {
          include: { document: { select: { s3Key: true } } },
        },
      },
    });

    if (!signatory) throw fastify.httpErrors.notFound("Invalid signing link");

    const s3Key = signatory.signingSession.document.s3Key;
    if (!s3Key) throw fastify.httpErrors.notFound("Document file not available");

    const url = await getPresignedUrl(s3Key, 1800); // 30 min
    return { url };
  });

  // Submit signature
  fastify.post<{ Params: { token: string } }>("/:token/sign", async (request) => {
    const body = z.object({ signatureDataUrl: z.string().min(1) }).parse(request.body);

    const signatory = await fastify.prisma.signatory.findUnique({
      where: { token: request.params.token },
      include: {
        signingSession: {
          include: {
            document: { select: { id: true, name: true, s3Key: true } },
            signatories: { select: { id: true, status: true } },
          },
        },
      },
    });

    if (!signatory) throw fastify.httpErrors.notFound("Invalid signing link");
    if (signatory.status !== "PENDING") {
      throw fastify.httpErrors.badRequest("Already signed or declined");
    }

    const session = signatory.signingSession;
    const now = new Date();

    if (session.status === "CANCELLED") {
      throw fastify.httpErrors.badRequest("Signing session has been cancelled");
    }
    if (session.status === "EXPIRED" || session.expiresAt < now) {
      throw fastify.httpErrors.badRequest("Signing session has expired");
    }

    // Verify document integrity
    if (session.document.s3Key) {
      const currentHash = await computeDocumentHash(session.document.s3Key);
      if (currentHash !== session.documentHash) {
        throw fastify.httpErrors.conflict("Document has been modified after signing session was created");
      }
    }

    // Save signature image to S3
    const matches = body.signatureDataUrl.match(/^data:image\/(png|jpeg|jpg);base64,(.+)$/);
    if (!matches) {
      throw fastify.httpErrors.badRequest("Invalid signature data URL");
    }
    const buffer = Buffer.from(matches[2], "base64");
    const s3Key = `${session.tenantId}/signing/${session.id}/${signatory.id}.png`;
    await uploadFile(s3Key, buffer, "image/png");

    // Update signatory
    await fastify.prisma.signatory.update({
      where: { id: signatory.id },
      data: {
        status: "SIGNED",
        signedAt: now,
        signatureS3Key: s3Key,
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"] || null,
      },
    });

    // Log audit event
    await fastify.prisma.signingEvent.create({
      data: {
        signingSessionId: session.id,
        signatoryId: signatory.id,
        eventType: "SIGNATURE_SUBMITTED",
        documentHash: session.documentHash,
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"] || null,
      },
    });

    // Check if all signatories have signed
    const pendingCount = session.signatories.filter(
      (s) => s.id !== signatory.id && s.status === "PENDING"
    ).length;

    if (pendingCount === 0) {
      // All signed — queue the signing-complete job
      await signingCompleteQueue.add("compose-signed-pdf", {
        signingSessionId: session.id,
        tenantId: session.tenantId,
      });
    }

    return {
      success: true,
      remainingSignatories: pendingCount,
      allSigned: pendingCount === 0,
    };
  });

  // Decline to sign
  fastify.post<{ Params: { token: string } }>("/:token/decline", async (request) => {
    const body = z.object({ reason: z.string().optional() }).parse(request.body);

    const signatory = await fastify.prisma.signatory.findUnique({
      where: { token: request.params.token },
      include: { signingSession: true },
    });

    if (!signatory) throw fastify.httpErrors.notFound("Invalid signing link");
    if (signatory.status !== "PENDING") {
      throw fastify.httpErrors.badRequest("Already signed or declined");
    }

    await fastify.prisma.signatory.update({
      where: { id: signatory.id },
      data: {
        status: "DECLINED",
        declinedAt: new Date(),
        declineReason: body.reason || null,
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"] || null,
      },
    });

    await fastify.prisma.signingEvent.create({
      data: {
        signingSessionId: signatory.signingSessionId,
        signatoryId: signatory.id,
        eventType: "SIGNATURE_DECLINED",
        documentHash: signatory.signingSession.documentHash,
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"] || null,
        metadata: body.reason ? { reason: body.reason } : undefined,
      },
    });

    return { success: true };
  });
}
