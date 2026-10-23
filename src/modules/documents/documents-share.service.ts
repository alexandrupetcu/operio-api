import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { env } from "../../config/env.js";
import { getPresignedUrl } from "../../lib/s3.js";

/**
 * Linkuri publice, cu termen, către documentele generate — ca un PDF să poată fi trimis
 * clientului pe WhatsApp / e-mail (care nu primesc fișiere prin link). Token-ul e secretul
 * (32 de octeți aleatori); linkul duce la o redirecționare scurtă către fișier, nu la o
 * adresă S3 care ar trăi ore. Se refolosește linkul valabil al documentului, ca același
 * client să nu primească de fiecare dată altă adresă.
 */
export const SHARE_LINK_DAYS = 30;
/** Cât trăiește adresa S3 de după redirecționare — doar cât să înceapă descărcarea. */
const REDIRECT_URL_SECONDS = 300;

export function shareLinkUrl(token: string): string {
  return `${env.API_PUBLIC_URL.replace(/\/$/, "")}/api/documents/shared/${token}`;
}

export async function createShareLink(fastify: FastifyInstance, tenantId: string, userId: string, documentId: string) {
  const doc = await fastify.prisma.document.findFirst({
    where: { id: documentId, tenantId },
    select: { id: true, status: true, s3Key: true, name: true },
  });
  if (!doc) throw fastify.httpErrors.notFound("Document not found");
  if (doc.status !== "COMPLETED" || !doc.s3Key) throw fastify.httpErrors.conflict("Documentul nu e generat încă");

  const soon = new Date(Date.now() + 7 * 86_400_000);
  const existing = await fastify.prisma.documentShareLink.findFirst({
    where: { documentId: doc.id, revokedAt: null, expiresAt: { gt: soon } },
    orderBy: { createdAt: "desc" },
  });
  const link =
    existing ??
    (await fastify.prisma.documentShareLink.create({
      data: {
        tenantId,
        documentId: doc.id,
        token: randomBytes(32).toString("base64url"),
        expiresAt: new Date(Date.now() + SHARE_LINK_DAYS * 86_400_000),
        createdById: userId,
      },
    }));
  return { id: link.id, documentId: doc.id, name: doc.name, url: shareLinkUrl(link.token), expiresAt: link.expiresAt };
}

/** Deschiderea publică: linkul valabil + documentul încă există → adresa fișierului. */
export async function resolveShareLink(fastify: FastifyInstance, token: string) {
  const link = await fastify.prisma.documentShareLink.findUnique({
    where: { token },
    include: { document: { select: { id: true, name: true, status: true, s3Key: true } } },
  });
  if (!link || link.revokedAt) throw fastify.httpErrors.notFound("Linkul nu există sau a fost retras");
  if (link.expiresAt.getTime() < Date.now()) throw fastify.httpErrors.gone("Linkul a expirat");
  if (link.document.status !== "COMPLETED" || !link.document.s3Key) throw fastify.httpErrors.notFound("Documentul nu mai e disponibil");

  await fastify.prisma.documentShareLink.update({
    where: { id: link.id },
    data: { openedCount: { increment: 1 }, lastOpenedAt: new Date() },
  });
  const ext = link.document.s3Key.split(".").pop() || "pdf";
  const filename = `${link.document.name.replace(/[\\/:*?"<>|]+/g, "-")}.${ext}`;
  const url = await getPresignedUrl(link.document.s3Key, REDIRECT_URL_SECONDS, filename);
  return { url, name: link.document.name };
}

export async function revokeShareLink(fastify: FastifyInstance, tenantId: string, linkId: string) {
  const { count } = await fastify.prisma.documentShareLink.updateMany({
    where: { id: linkId, tenantId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (!count) throw fastify.httpErrors.notFound("Link not found");
  return { ok: true };
}
