/**
 * Pragul în care se află o certificare cu `daysLeft` zile rămase: notificarea
 * pleacă o dată la intrarea în fiecare prag, nu zilnic. Pragurile, de la cel mai
 * îndepărtat: fereastra firmei, 30, 7 zile, ziua expirării, expirat.
 */
export function certificationBucket(daysLeft: number, windowDays: number): string {
  if (daysLeft < 0) return "expired";
  if (daysLeft === 0) return "d0";
  if (daysLeft <= 7) return "d7";
  if (daysLeft <= 30) return "d30";
  return `w${windowDays}`;
}
