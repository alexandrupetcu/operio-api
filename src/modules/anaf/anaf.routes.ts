import type { FastifyInstance } from "fastify";
import { lookupCui } from "./anaf.service.js";

export default async function anafRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", fastify.authenticate);

  fastify.get<{ Params: { cui: string } }>(
    "/lookup/:cui",
    async (request) => {
      const { cui } = request.params;
      const data = await lookupCui(cui);
      if (!data) throw fastify.httpErrors.notFound("CUI not found in ANAF");
      return data;
    }
  );
}
