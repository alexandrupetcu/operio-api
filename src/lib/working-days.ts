/**
 * Zile lucrătoare în sensul legislației române: fără sâmbătă/duminică și fără
 * sărbătorile legale (Codul muncii, art. 139). Folosit pentru termenul de 5 zile
 * lucrătoare în care Fișa de evidență trebuie înregistrată la operatorul de sistem
 * (Ord. ANRE 179/2015, art. 9 alin. 6) și pentru cele 2 zile în care clientul
 * primește exemplarul cu numărul de înregistrare (alin. 7).
 *
 * Datele se compară pe zi calendaristică, în ora locală a serverului (România în
 * producție), iar „ziua 0” e ziua finalizării — termenul cade în a 5-a zi lucrătoare
 * de după ea.
 */

/** Paștele ortodox (algoritmul Meeus, calendar iulian → gregorian). Întoarce duminica Paștelui. */
export function orthodoxEaster(year: number): Date {
  const a = year % 4;
  const b = year % 7;
  const c = year % 19;
  const d = (19 * c + 15) % 30;
  const e = (2 * a + 4 * b - d + 34) % 7;
  const month = Math.floor((d + e + 114) / 31); // 3 = martie, 4 = aprilie (iulian)
  const day = ((d + e + 114) % 31) + 1;
  // Diferența iulian → gregorian: 13 zile pentru 1900–2099.
  const julian = new Date(year, month - 1, day);
  julian.setDate(julian.getDate() + 13);
  return julian;
}

const key = (d: Date) => `${d.getMonth() + 1}-${d.getDate()}`;

/** Sărbătorile legale din anul dat, ca set „luna-zi”. */
export function romanianPublicHolidays(year: number): Set<string> {
  const fixed = ["1-1", "1-2", "1-6", "1-7", "1-24", "5-1", "6-1", "8-15", "11-30", "12-25", "12-26"];
  const set = new Set(fixed);
  const easter = orthodoxEaster(year);
  for (const offset of [-2, 0, 1, 49, 50]) { // Vinerea Mare, Paște, a doua zi, Rusalii + a doua zi
    const d = new Date(easter);
    d.setDate(d.getDate() + offset);
    set.add(key(d));
  }
  return set;
}

export function isWorkingDay(d: Date): boolean {
  const dow = d.getDay();
  if (dow === 0 || dow === 6) return false;
  return !romanianPublicHolidays(d.getFullYear()).has(key(d));
}

/** Ziua (la 23:59:59.999 local) la care expiră `n` zile lucrătoare numărate după `from`. */
export function addWorkingDays(from: Date, n: number): Date {
  const d = new Date(from);
  d.setHours(23, 59, 59, 999);
  let left = n;
  while (left > 0) {
    d.setDate(d.getDate() + 1);
    if (isWorkingDay(d)) left -= 1;
  }
  return d;
}

/**
 * Termenul legal de înregistrare a Fișei de evidență la OS: 5 zile lucrătoare de la
 * întocmire. Firma îl poate schimba (Setări → Alerte, `osRegistrationWorkingDays`).
 */
export const OS_REGISTRATION_WORKING_DAYS = 5;
export function osRegistrationDeadline(completedAt: Date, workingDays: number = OS_REGISTRATION_WORKING_DAYS): Date {
  return addWorkingDays(completedAt, workingDays);
}

/** Zile calendaristice rămase până la termen (negative = depășit), pe zile întregi. */
export function daysUntil(deadline: Date, now = new Date()): number {
  const a = new Date(deadline); a.setHours(0, 0, 0, 0);
  const b = new Date(now); b.setHours(0, 0, 0, 0);
  return Math.round((a.getTime() - b.getTime()) / 86_400_000);
}

/**
 * Zile lucrătoare rămase până la termen: zilele lucrătoare de după azi, până la ziua
 * termenului inclusiv (0 = termenul e azi sau a trecut azi). Negativ = zilele lucrătoare
 * cu care s-a depășit. Așa se citește termenul legal („5 zile lucrătoare”), nu în zile
 * calendaristice, unde un weekend îl face să pară mai lung.
 */
export function workingDaysUntil(deadline: Date, now = new Date()): number {
  const a = new Date(deadline); a.setHours(0, 0, 0, 0);
  const b = new Date(now); b.setHours(0, 0, 0, 0);
  let n = 0;
  if (a >= b) {
    const d = new Date(b);
    while (d < a) {
      d.setDate(d.getDate() + 1);
      if (isWorkingDay(d)) n += 1;
    }
    return n;
  }
  const d = new Date(a);
  while (d < b) {
    d.setDate(d.getDate() + 1);
    if (isWorkingDay(d)) n -= 1;
  }
  return n;
}
