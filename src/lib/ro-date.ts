/**
 * Data dintr-un câmp text completat de mână (setările firmei: „08.12.2025”,
 * „8/12/2025”, „2025-12-08”). Întoarce miezul nopții UTC al zilei, sau `null`
 * când textul nu e o dată calendaristică validă (ex. „nelimitat”, „31.02.2025”).
 */
export function parseRoDate(text: string | null | undefined): Date | null {
  const t = (text ?? "").trim();
  let y: number, m: number, d: number;
  let match = t.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (match) {
    [d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else if ((match = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) {
    [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else {
    return null;
  }
  const date = new Date(Date.UTC(y, m - 1, d));
  // Respinge 31.02 etc. (Date le-ar rostogoli în luna următoare).
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date;
}
