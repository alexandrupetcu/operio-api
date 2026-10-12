import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sendContactRequest } from "../../lib/email.js";

/**
 * Demo requests from the marketing site (operio.ro). No auth; strict rate
 * limit; a honeypot field (`website`) that real browsers leave empty.
 */
const contactSchema = z.object({
  name: z.string().trim().min(2).max(120),
  company: z.string().trim().min(2).max(160),
  phone: z.string().trim().regex(/^[+()\d\s.-]{9,}$/),
  email: z.string().trim().email().max(200),
  message: z.string().trim().max(3000).optional().default(""),
  lang: z.enum(["ro", "en"]).optional().default("ro"),
  page: z.string().max(300).optional(),
  website: z.string().max(200).optional(), // honeypot
});

export default async function contactRoutes(fastify: FastifyInstance) {
  fastify.post(
    "/",
    { config: { rateLimit: { max: 5, timeWindow: "1 hour" } } },
    async (request, reply) => {
      const body = contactSchema.parse(request.body);
      // Bots fill every field; pretend success so they don't adapt.
      if (body.website) return reply.status(204).send();
      await sendContactRequest({ ...body, ip: request.ip, userAgent: request.headers["user-agent"] });
      return reply.status(204).send();
    },
  );
}
