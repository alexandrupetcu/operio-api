import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { getPresignedUrl } from "../../lib/s3.js";
import { subdomainError, subdomainFromHost } from "../../lib/tenant-subdomain.js";

/** Master adminul activează / schimbă / scoate subdomeniul unei firme. */
export async function setSubdomain(fastify: FastifyInstance, tenantId: string, value: string | null) {
  const subdomain = value?.trim().toLowerCase() || null;
  if (subdomain) {
    const err = subdomainError(subdomain);
    if (err) throw fastify.httpErrors.badRequest(err);
  }
  try {
    return await fastify.prisma.tenant.update({
      where: { id: tenantId },
      data: { subdomain },
      select: { id: true, name: true, subdomain: true },
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")
      throw fastify.httpErrors.conflict(`Subdomeniul „${subdomain}” e folosit de altă firmă`);
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") throw fastify.httpErrors.notFound("Firma nu a fost găsită");
    throw e;
  }
}

/** Ce vede pagina de autentificare de pe `<subdomain>.operio.ro`: doar numele și sigla. */
export async function brandingFor(fastify: FastifyInstance, subdomain: string) {
  const t = await fastify.prisma.tenant.findUnique({ where: { subdomain: subdomain.toLowerCase() }, select: { name: true, logoS3Key: true } });
  if (!t) return null;
  return { name: t.name, logoUrl: t.logoS3Key ? await getPresignedUrl(t.logoS3Key) : null };
}

/** Caddy (on-demand TLS) întreabă înainte să ceară un certificat: doar subdomeniile active. */
export async function tlsAllowed(fastify: FastifyInstance, domain: string, baseDomain: string | undefined) {
  const sub = subdomainFromHost(domain, baseDomain);
  if (!sub) return false;
  return (await fastify.prisma.tenant.count({ where: { subdomain: sub } })) > 0;
}
