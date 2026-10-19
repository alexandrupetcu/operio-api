import type { PrismaClient } from "@prisma/client";
import { getFileBuffer } from "../../lib/s3.js";
import { STAMP_SLOTS } from "../../lib/stamps.js";
import { docxText, stampSlotsIn } from "./stamp-text.js";

/**
 * Unde apare fiecare ștampilă: șabloanele active ale firmei + cele de sistem care
 * conțin variabila slotului (`tenant_stamp` = 1, `tenant_stamp_2..4`), în HTML
 * (`{{tenant_stamp_2}}`) sau DOCX (`{%tenant_stamp_2}`). Răspunde în Setări la
 * „unde se folosește ștampila 2?” fără o listă scrisă de mână care să rămână în urmă.
 */

// Cheia S3 a unui DOCX se schimbă la fiecare înlocuire (conține un timestamp),
// deci rezultatul per cheie nu se învechește: îl ținem în memorie.
const docxSlotsCache = new Map<string, Set<number>>();

export interface StampUsageTemplate {
  id: string;
  name: string;
  /** Grupul DOCX din care face parte documentul (ex. „Dosar ISCIR”), dacă e membru. */
  groupName: string | null;
}

export async function getStampUsage(
  db: PrismaClient,
  tenantId: string,
  readFile: (key: string) => Promise<Buffer> = getFileBuffer,
): Promise<{ slot: number; templates: StampUsageTemplate[] }[]> {
  const templates = await db.documentTemplate.findMany({
    where: {
      OR: [{ tenantId }, { tenantId: null }],
      isActive: true,
      type: "single",
      // Membrul unui grup dezactivat nu se mai generează.
      AND: [{ OR: [{ parentGroupId: null }, { parentGroup: { isActive: true } }] }],
    },
    select: { id: true, name: true, content: true, s3Key: true, parentGroup: { select: { name: true } } },
    orderBy: [{ categoryCode: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
    take: 1000,
  });

  const bySlot = new Map<number, StampUsageTemplate[]>(STAMP_SLOTS.map((s) => [s, []]));
  for (const t of templates) {
    let slots: Set<number>;
    if (t.s3Key) {
      const cached = docxSlotsCache.get(t.s3Key);
      if (cached) slots = cached;
      else {
        try {
          slots = stampSlotsIn(docxText(await readFile(t.s3Key)));
          docxSlotsCache.set(t.s3Key, slots);
        } catch {
          continue; // fișier lipsă/corupt — nu blocăm pagina de setări
        }
      }
    } else {
      slots = stampSlotsIn(t.content ?? "");
    }
    for (const s of slots) bySlot.get(s)?.push({ id: t.id, name: t.name, groupName: t.parentGroup?.name ?? null });
  }
  return STAMP_SLOTS.map((slot) => ({ slot, templates: bySlot.get(slot) ?? [] }));
}
