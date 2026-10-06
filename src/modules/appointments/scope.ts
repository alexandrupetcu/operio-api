/**
 * Cine ce programări are voie să vadă.
 *
 * În modul „calendar comun" (implicit, comportamentul dintotdeauna) clauza de
 * vizibilitate e `{}` — interogările rămân identice cu cele de dinainte, deci
 * revenirea la modul comun e o editare de setări, nu un deploy.
 *
 * În modul „calendare separate" un tehnician vede programările atribuite lui plus
 * cele nerepartizate (ca să le poată prelua). Coordonatorii văd tot. Restricția se
 * aplică la interogare, nu în interfață: o listă filtrată doar în UI rămâne o
 * scurgere de date.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Prisma } from "@prisma/client";
import { getSchedulingSettings } from "../tenant/scheduling-settings.js";

export type ApptScope =
  | { kind: "all" }
  /** `employeeId` null = cont fără persoană legată → vede doar nerepartizatele. */
  | { kind: "own"; employeeId: string | null };

const SCOPE_KEY = "_apptScope";

/**
 * Rezolvă domeniul de vizibilitate al cererii curente, memoizat pe request —
 * un handler îl poate cere de mai multe ori.
 *
 * Legătura cont↔persoană se citește la fiecare cerere, nu din token: JWT-ul se
 * reînnoiește rar, iar un claim învechit ar însemna fie „nu văd nimic după ce am
 * fost legat", fie „încă văd programările colegului după ce am fost dezlegat".
 */
export async function resolveApptScope(
  fastify: FastifyInstance,
  request: FastifyRequest,
): Promise<ApptScope> {
  const cached = (request as unknown as Record<string, ApptScope>)[SCOPE_KEY];
  if (cached) return cached;

  const remember = (scope: ApptScope) => {
    (request as unknown as Record<string, ApptScope>)[SCOPE_KEY] = scope;
    return scope;
  };

  const role = request.user?.role;
  // MASTER_ADMIN are tenantId null, deci request.tenantId === "" — ramura asta
  // trebuie să rămână prima, înainte de orice interogare pe tenant.
  if (role === "MASTER_ADMIN" || role === "ADMIN" || role === "MANAGER") {
    return remember({ kind: "all" });
  }

  const [settings, employee] = await Promise.all([
    getSchedulingSettings(fastify.prisma, request.tenantId),
    fastify.prisma.employee.findFirst({
      where: { userId: request.user.sub, tenantId: request.tenantId },
      select: { id: true },
    }),
  ]);

  if (settings.mode === "shared") return remember({ kind: "all" });
  return remember({ kind: "own", employeeId: employee?.id ?? null });
}

/** Fragmentul de `where` care descrie ce poate vedea cererea curentă. */
export function apptVisibilityWhere(scope: ApptScope): Prisma.AppointmentWhereInput {
  if (scope.kind === "all") return {};
  return scope.employeeId
    ? { OR: [{ employeeId: scope.employeeId }, { employeeId: null }] }
    : // Cont fără persoană legată: deliberat doar nerepartizatele. O revenire
      // tăcută la vizibilitate totală ar anula tocmai funcționalitatea.
      { employeeId: null };
}

/**
 * Filtrul cerut de client (`?employeeId=`): `me`, `none`, un id sau o listă
 * separată prin virgulă. Se combină cu clauza de vizibilitate prin AND, deci un
 * filtru poate doar să restrângă — niciodată să lărgească.
 */
export function requestedEmployeeWhere(
  raw: string | undefined,
  scope: ApptScope,
): Prisma.AppointmentWhereInput {
  if (!raw) return {};
  const parts = raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) return {};

  const wantsUnassigned = parts.includes("none");
  const ids = parts
    .filter((p) => p !== "none")
    .map((p) => (p === "me" ? (scope.kind === "own" ? scope.employeeId : null) : p))
    .filter((id): id is string => !!id);

  const or: Prisma.AppointmentWhereInput[] = [];
  if (ids.length) or.push({ employeeId: { in: ids } });
  if (wantsUnassigned) or.push({ employeeId: null });
  // `?employeeId=me` pentru un cont nelegat: nu poate corespunde nimic.
  if (!or.length) return { id: "__none__" };
  return or.length === 1 ? or[0] : { OR: or };
}

/** True când cererea poate vedea o programare atribuită acestui angajat. */
export function canSeeEmployee(scope: ApptScope, employeeId: string | null): boolean {
  if (scope.kind === "all") return true;
  if (employeeId === null) return true;
  return scope.employeeId === employeeId;
}
