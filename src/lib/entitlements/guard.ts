import type { FastifyReply, FastifyRequest } from "fastify";
import { FEATURES, type Feature } from "./features.js";
import { getTenantEntitlements } from "./resolve.js";

/** Planul care ar debloca funcția — pentru mesajul din interfață. */
const UPGRADE_TO = "execution";

export function paymentRequired(reply: FastifyReply, feature: Feature, message?: string) {
  return reply.code(402).send({
    statusCode: 402,
    error: "Payment Required",
    message: message ?? `„${FEATURES[feature]}” este disponibilă în planul Execuție`,
    feature,
    upgradeTo: UPGRADE_TO,
  });
}

/**
 * Gardă de abonament pentru un modul: se pune ca `preHandler` pe plugin-ul de rute.
 * Implicit lasă citirile (GET/HEAD) să treacă — o firmă care a renunțat la un modul
 * își vede în continuare datele, doar nu mai creează altele. MASTER_ADMIN trece mereu.
 */
export function requireFeature(feature: Feature, opts: { allowRead?: boolean } = {}) {
  const allowRead = opts.allowRead ?? true;
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) return reply.unauthorized("Authentication required");
    if (request.user.role === "MASTER_ADMIN") return;
    if (allowRead && (request.method === "GET" || request.method === "HEAD")) return;
    if (!request.tenantId) return;
    const ent = await getTenantEntitlements(request.server.prisma, request.tenantId);
    if (!ent.has(feature)) return paymentRequired(reply, feature);
    if (ent.expired) {
      return paymentRequired(reply, feature, "Abonamentul a expirat — datele rămân vizibile, dar nu se pot crea altele noi. Contactează-ne pentru reînnoire.");
    }
  };
}
