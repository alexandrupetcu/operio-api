import PizZip from "pizzip";

/** Sloturile referite într-un text (HTML sau XML-ul DOCX fără tag-uri). */
export function stampSlotsIn(text: string): Set<number> {
  const out = new Set<number>();
  // `(?!\w)`: „tenant_stamp_5” sau „tenant_stampila” nu sunt slotul 1.
  for (const m of text.matchAll(/tenant_stamp(?:_([2-4]))?(?!\w)/g)) out.add(m[1] ? Number(m[1]) : 1);
  return out;
}

/** Textul unui DOCX (corp, antete, subsoluri), cu tag-urile scoase — Word sparge variabilele în run-uri. */
export function docxText(buffer: Buffer): string {
  const zip = new PizZip(buffer);
  return Object.keys(zip.files)
    .filter((k) => /^word\/(document|header\d*|footer\d*)\.xml$/.test(k))
    .map((k) => zip.file(k)!.asText().replace(/<[^>]+>/g, ""))
    .join(" ");
}
