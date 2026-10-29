import type { FastifyInstance } from "fastify";
import { env } from "../../config/env.js";
import { brandingFor, tlsAllowed } from "../tenant/subdomain.service.js";

/**
 * Subdomeniile firmelor (`picinstall.operio.ro`), fără sesiune:
 *   - `GET /branding?subdomain=` — numele și sigla pentru pagina de autentificare;
 *   - `GET /tls-allowed?domain=` — întrebarea lui Caddy înainte de un certificat on-demand
 *     (200 = emite, 404 = nu), ca să nu ceară certificate pentru nume inventate.
 */
export default async function tenantHostRoutes(fastify: FastifyInstance) {
  fastify.get<{ Querystring: { subdomain?: string } }>(
    "/branding",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const branding = request.query.subdomain ? await brandingFor(fastify, request.query.subdomain) : null;
      if (!branding) return reply.notFound("Firma nu a fost găsită");
      return branding;
    },
  );

  fastify.get<{ Querystring: { domain?: string } }>("/tls-allowed", async (request, reply) => {
    const ok = await tlsAllowed(fastify, request.query.domain ?? "", env.TENANT_BASE_DOMAIN);
    return ok ? { ok: true } : reply.code(404).send({ ok: false });
  });
}
