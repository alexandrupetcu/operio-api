import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { isFeature, type Feature, type Limits } from "./features.js";
import { DEFAULT_PLAN, PLANS, isPlanId, type PlanId } from "./plans.js";

/** Ajustări per firmă: funcții în plus/minus față de plan și limite proprii. */
export const entitlementOverridesSchema = z
  .object({
    features: z.object({ add: z.array(z.string()).optional(), remove: z.array(z.string()).optional() }).optional(),
    limits: z.object({ technicianSeats: z.number().int().min(0).max(1000).optional() }).optional(),
  })
  .strict();
export type EntitlementOverrides = z.infer<typeof entitlementOverridesSchema>;

export interface Entitlements {
  plan: PlanId;
  planLabel: string;
  planUntil: string | null;
  /** Abonamentul a expirat (planUntil în trecut) — funcțiile rămân la citire, creările se blochează. */
  expired: boolean;
  features: Feature[];
  limits: Limits;
  has(feature: Feature): boolean;
}

export function resolveEntitlements(tenant: {
  plan: string;
  planUntil: Date | null;
  entitlementOverrides: unknown;
}): Entitlements {
  const plan: PlanId = isPlanId(tenant.plan) ? tenant.plan : DEFAULT_PLAN;
  const def = PLANS[plan];
  const parsed = entitlementOverridesSchema.safeParse(tenant.entitlementOverrides ?? {});
  const ov: EntitlementOverrides = parsed.success ? parsed.data : {};

  const set = new Set<Feature>(def.features);
  for (const f of ov.features?.add ?? []) if (isFeature(f)) set.add(f);
  for (const f of ov.features?.remove ?? []) if (isFeature(f)) set.delete(f);

  const limits: Limits = { ...def.limits, ...(ov.limits ?? {}) };
  const expired = !!tenant.planUntil && tenant.planUntil.getTime() < Date.now();
  const features = [...set];
  return {
    plan,
    planLabel: def.label,
    planUntil: tenant.planUntil?.toISOString() ?? null,
    expired,
    features,
    limits,
    has: (f) => set.has(f),
  };
}

// Cache scurt per tenant — gărzile rulează la fiecare cerere, planul se schimbă rar.
const TTL_MS = 60_000;
const cache = new Map<string, { value: Entitlements; exp: number }>();

export async function getTenantEntitlements(prisma: PrismaClient, tenantId: string): Promise<Entitlements> {
  const hit = cache.get(tenantId);
  if (hit && hit.exp > Date.now()) return hit.value;
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { plan: true, planUntil: true, entitlementOverrides: true },
  });
  const value = resolveEntitlements(tenant ?? { plan: DEFAULT_PLAN, planUntil: null, entitlementOverrides: null });
  cache.set(tenantId, { value, exp: Date.now() + TTL_MS });
  return value;
}

export function invalidateEntitlements(tenantId: string) {
  cache.delete(tenantId);
}

/** Forma trimisă clienților (fără funcția `has`). */
export function serializeEntitlements(e: Entitlements) {
  return { plan: e.plan, planLabel: e.planLabel, planUntil: e.planUntil, expired: e.expired, features: e.features, limits: e.limits };
}
