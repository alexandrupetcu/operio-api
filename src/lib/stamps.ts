/**
 * Ștampile firmă — 4 sloturi.
 *
 * Slotul 1 își păstrează imaginea în `Tenant.stampS3Key` (compatibilitate
 * înapoi: șabloanele existente folosesc variabila `{{tenant_stamp}}` care
 * citește tot din `stampS3Key`, iar în path-ul HTML slotul 1 se compune cu
 * semnătura). Sloturile 2-4 + toate etichetele trăiesc în
 * `Tenant.brandingJson.stamps`.
 */

export const STAMP_SLOTS = [1, 2, 3, 4] as const;
export type StampSlotNumber = (typeof STAMP_SLOTS)[number];

export const DEFAULT_STAMP_LABELS: Record<number, string> = {
  1: "Ștampilă firmă",
  2: "Ștampilă 2",
  3: "Ștampilă 3",
  4: "Ștampilă 4",
};

export interface StampSlot {
  slot: number; // 1..4
  label: string;
  s3Key: string | null;
}

interface BrandingStampEntry {
  slot?: number;
  label?: string;
  s3Key?: string | null;
}

interface BrandingJson {
  stamps?: BrandingStampEntry[];
  [k: string]: unknown;
}

export interface TenantStampSource {
  stampS3Key?: string | null;
  brandingJson?: unknown;
}

/** Template variable name for a given slot (slot 1 keeps the legacy `tenant_stamp`). */
export function stampVarName(slot: number): string {
  return slot === 1 ? "tenant_stamp" : `tenant_stamp_${slot}`;
}

function readBranding(tenant: TenantStampSource): BrandingJson {
  const b = tenant.brandingJson;
  return b && typeof b === "object" ? (b as BrandingJson) : {};
}

/** Resolve all 4 slots into a stable, ordered list (label + s3Key). */
export function resolveStampSlots(tenant: TenantStampSource): StampSlot[] {
  const branding = readBranding(tenant);
  const configured = Array.isArray(branding.stamps) ? branding.stamps : [];
  return STAMP_SLOTS.map((slot) => {
    const entry = configured.find((s) => s.slot === slot);
    // Slot 1's image lives in stampS3Key; slots 2-4 in brandingJson.
    const s3Key = slot === 1 ? tenant.stampS3Key ?? null : entry?.s3Key ?? null;
    return {
      slot,
      label: (entry?.label ?? "").trim() || DEFAULT_STAMP_LABELS[slot],
      s3Key,
    };
  });
}

/**
 * Merge a single slot's changes into a fresh `brandingJson` value.
 * For slot 1 only the label is stored here (the s3Key stays on `stampS3Key`);
 * for slots 2-4 both label and s3Key are stored. Pass `s3Key: undefined` to
 * leave the image untouched, `s3Key: null` to clear it.
 */
export function upsertStampSlot(
  brandingJson: unknown,
  slot: number,
  patch: { label?: string; s3Key?: string | null },
): BrandingJson {
  const branding = brandingJson && typeof brandingJson === "object" ? { ...(brandingJson as BrandingJson) } : {};
  const stamps = Array.isArray(branding.stamps) ? [...branding.stamps] : [];
  const idx = stamps.findIndex((s) => s.slot === slot);
  const existing: BrandingStampEntry = idx >= 0 ? { ...stamps[idx] } : { slot };
  if (patch.label !== undefined) existing.label = patch.label;
  if (patch.s3Key !== undefined && slot !== 1) existing.s3Key = patch.s3Key;
  if (idx >= 0) stamps[idx] = existing;
  else stamps.push(existing);
  branding.stamps = stamps.sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));
  return branding;
}
