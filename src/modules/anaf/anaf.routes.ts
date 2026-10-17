import type { FastifyInstance } from "fastify";
import { lookupCui, AnafUnavailableError } from "./anaf.service.js";

export default async function anafRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", fastify.authenticate);

  fastify.get<{ Params: { cui: string } }>(
    "/lookup/:cui",
    async (request) => {
      const { cui } = request.params;
      let data: Awaited<ReturnType<typeof lookupCui>>;
      try {
        data = await lookupCui(cui);
      } catch (err) {
        if (err instanceof AnafUnavailableError) throw fastify.httpErrors.serviceUnavailable("ANAF nu răspunde momentan — completează datele manual și reîncearcă mai târziu");
        throw err;
      }
      if (!data) throw fastify.httpErrors.notFound("CUI not found in ANAF");
      return data;
    }
  );
}
