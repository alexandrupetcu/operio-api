/**
 * Numele documentelor din arhiva ZIP a unui grup (dosar de branșament, Dosar ISCIR):
 * numele de fișier al șablonului (`fileName` — la dosarele de branșament și conductă e
 * numele fișierului original al clientului, cu numerotarea după care tipărește, ex.
 * „5. PV Control calitate”, „1.) Catre Distrigaz (x2)”), altfel numele șablonului.
 */

interface MemberLike {
  name: string | null;
  fileName: string | null;
}

export function archiveEntryNames(members: MemberLike[]): string[] {
  const used = new Set<string>();
  return members.map((m) => {
    const base = (m.fileName?.trim() || m.name?.trim() || "document")
      .replace(/\.docx$/i, "")
      .replace(/[\\/:*?"<>|]/g, "-")
      .trim();
    let entry = `${base}.docx`;
    let n = 1;
    while (used.has(entry)) entry = `${base} (${++n}).docx`;
    used.add(entry);
    return entry;
  });
}

/**
 * Șabloanele de sistem încărcate din fișierele clientului primesc ca nume de fișier numele
 * fișierului original (numerotarea contează la tipar). Unul redenumit în aplicație rămâne.
 */
export function originalFileName(current: string | null | undefined, sourceFile: string): string {
  return current?.trim() || sourceFile.normalize("NFC");
}
