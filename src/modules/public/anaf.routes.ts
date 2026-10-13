import type { FastifyInstance } from "fastify";
import { lookupCui } from "../anaf/anaf.service.js";

/**
 * CUI lookup for the registration form (no session yet). Returns only what the
 * form needs; rate-limited so it can't be used to scrape ANAF through us.
 */
export default async function publicAnafRoutes(fastify: FastifyInstance) {
  fastify.get<{ Params: { cui: string } }>(
    "/:cui",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const digits = request.params.cui.replace(/\D/g, "");
      if (digits.length < 2 || digits.length > 10) return reply.badRequest("CUI invalid");
      const data = await lookupCui(digits);
      if (!data) return reply.notFound("Nu am găsit nicio firmă cu acest CUI");
      return {
        cui: data.cui,
        name: data.denumire,
        regCom: data.nrRegCom,
        address: data.adresa,
        phone: data.telefon,
        vatPayer: data.scpTVA,
        inactive: data.statusInactivi,
      };
    },
  );
}
