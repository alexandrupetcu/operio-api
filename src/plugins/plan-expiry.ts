import fp from "fastify-plugin";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getTenantEntitlements, paymentRequired } from "../lib/entitlements/index.js";

/** Prefixe scutite: autentificarea, consola platformei și rutele publice (semnare, site). */
const EXEMPT_PREFIXES = ["/api/auth", "/api/admin", "/api/public"];

const EXPIRED_MESSAGE =
  "Abonamentul a expirat — datele rămân vizibile, dar nu se pot crea altele noi. Contactează-ne pentru reînnoire.";

/**
 * Abonament expirat, aplicat global: orice cerere care scrie (non-GET/HEAD) a
 * unei firme cu `planUntil` în trecut primește 402, indiferent de modul.
 * Citirile trec (firma își vede datele), MASTER_ADMIN trece mereu, iar rutele
 * fără sesiune/tenant (login, refresh, public) nu sunt atinse. Se înregistrează
 * imediat după plugin-ul de tenant, ca `request.tenantId` să fie deja setat.
 */
export default fp(async (fastify: FastifyInstance) => {
  fastify.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") return;
    const path = request.routeOptions?.url ?? request.url;
    if (EXEMPT_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) return;
    if (!request.user || request.user.role === "MASTER_ADMIN") return;
    if (!request.tenantId) return;
    const ent = await getTenantEntitlements(request.server.prisma, request.tenantId);
    if (ent.expired) return paymentRequired(reply, "field.inspections", EXPIRED_MESSAGE);
  });
});
