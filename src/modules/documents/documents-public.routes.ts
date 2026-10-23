import type { FastifyInstance } from "fastify";
import { resolveShareLink } from "./documents-share.service.js";

/**
 * Deschiderea unui link de document trimis clientului — fără autentificare (clientul nu
 * are cont): token valabil → redirecționare scurtă către fișier. Limită pe IP, ca
 * token-urile să nu poată fi ghicite prin forță brută (și așa au 256 de biți).
 */
export default async function documentsPublicRoutes(fastify: FastifyInstance) {
  fastify.get<{ Params: { token: string } }>(
    "/:token",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { url } = await resolveShareLink(fastify, request.params.token);
      return reply.redirect(url, 302);
    }
  );
}
