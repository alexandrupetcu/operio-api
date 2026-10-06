import type { FastifyInstance } from "fastify";
import { PRESET_SCOPES, type PresetScope, type RecordPresetsInput } from "./field-presets.schema.js";

/** Câte valori întoarcem per vocabular — listele din teren sunt derulabile, nu infinite. */
const MAX_PER_SCOPE = 60;

/** Trim + spații interioare colapsate; forma afișată păstrează literele mari. */
export function normalizeValue(value: string): { value: string; normalized: string } {
  const trimmed = value.trim().replace(/\s+/g, " ");
  return { value: trimmed, normalized: trimmed.toLowerCase() };
}

/**
 * Catalogul firmei, grupat pe vocabular și ordonat după cât de des e folosită
 * fiecare valoare — ce scrie toată lumea urcă, ce s-a scris o dată din greșeală
 * rămâne la coadă și iese din listă când catalogul crește.
 */
export async function list(fastify: FastifyInstance, tenantId: string) {
  const rows = await fastify.prisma.fieldPreset.findMany({
    where: { tenantId },
    orderBy: [{ useCount: "desc" }, { lastUsedAt: "desc" }],
    select: { scope: true, value: true, useCount: true },
  });
  const out: Record<string, string[]> = {};
  for (const scope of PRESET_SCOPES) out[scope] = [];
  for (const row of rows) {
    const list = out[row.scope];
    if (list && list.length < MAX_PER_SCOPE) list.push(row.value);
  }
  return out;
}

/**
 * Înregistrează folosirea unei valori: o creează la prima apariție, altfel îi
 * incrementează contorul. Valorile care diferă doar prin majuscule sau spații
 * cad pe aceeași intrare (vezi `normalized`), deci lista nu se dublează.
 */
export async function record(
  fastify: FastifyInstance,
  tenantId: string,
  input: RecordPresetsInput
) {
  const items = "items" in input ? input.items : [input];
  const seen = new Set<string>();
  for (const item of items) {
    const { value, normalized } = normalizeValue(item.value);
    if (!normalized) continue;
    // Aceeași valoare trimisă de două ori în același lot nu contează de două ori.
    const key = `${item.scope}:${normalized}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await fastify.prisma.fieldPreset.upsert({
      where: { tenantId_scope_normalized: { tenantId, scope: item.scope, normalized } },
      update: { useCount: { increment: 1 }, lastUsedAt: new Date() },
      create: { tenantId, scope: item.scope as PresetScope, value, normalized },
    });
  }
  return list(fastify, tenantId);
}

/**
 * Redenumire — și, implicit, contopire: dacă noul nume există deja în același
 * vocabular („Valrom" peste „Valrom SRL"), cele două intrări devin una singură,
 * cu folosirile adunate. Fără asta, curățarea ar însemna ștergerea variantei
 * greșite și pierderea istoricului ei de folosire.
 */
export async function rename(
  fastify: FastifyInstance,
  tenantId: string,
  id: string,
  rawValue: string
) {
  const source = await fastify.prisma.fieldPreset.findFirst({ where: { id, tenantId } });
  if (!source) throw fastify.httpErrors.notFound("Preset not found");
  const { value, normalized } = normalizeValue(rawValue);
  if (!normalized) throw fastify.httpErrors.badRequest("Value required");

  const target =
    normalized === source.normalized
      ? null
      : await fastify.prisma.fieldPreset.findFirst({
          where: { tenantId, scope: source.scope, normalized },
        });

  if (target) {
    await fastify.prisma.$transaction([
      fastify.prisma.fieldPreset.update({
        where: { id: target.id },
        data: {
          value,
          useCount: target.useCount + source.useCount,
          lastUsedAt: target.lastUsedAt > source.lastUsedAt ? target.lastUsedAt : source.lastUsedAt,
        },
      }),
      fastify.prisma.fieldPreset.delete({ where: { id: source.id } }),
    ]);
    return { merged: true };
  }

  await fastify.prisma.fieldPreset.update({ where: { id: source.id }, data: { value, normalized } });
  return { merged: false };
}

/** Ștergerea unei valori intrate greșit. */
export async function remove(fastify: FastifyInstance, tenantId: string, id: string) {
  const existing = await fastify.prisma.fieldPreset.findFirst({ where: { id, tenantId } });
  if (!existing) throw fastify.httpErrors.notFound("Preset not found");
  await fastify.prisma.fieldPreset.delete({ where: { id } });
  return { ok: true };
}

/** Listă detaliată (cu id și contor) — pentru o eventuală pagină de administrare. */
export async function listDetailed(fastify: FastifyInstance, tenantId: string, scope?: string) {
  return fastify.prisma.fieldPreset.findMany({
    where: { tenantId, ...(scope && { scope }) },
    orderBy: [{ scope: "asc" }, { useCount: "desc" }],
  });
}
