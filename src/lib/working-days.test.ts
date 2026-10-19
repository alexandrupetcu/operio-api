import { describe, expect, it } from "vitest";
import {
  OS_REGISTRATION_WORKING_DAYS,
  addWorkingDays,
  daysUntil,
  isWorkingDay,
  orthodoxEaster,
  osRegistrationDeadline,
  romanianPublicHolidays,
} from "./working-days.js";

/** Data locală (fără UTC), ca în modul: comparațiile se fac pe zi calendaristică. */
const d = (y: number, m: number, day: number, h = 12) => new Date(y, m - 1, day, h);
const iso = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;

describe("orthodoxEaster", () => {
  it("2025 → 20 aprilie", () => {
    expect(iso(orthodoxEaster(2025))).toBe("2025-04-20");
  });

  it("2026 → 12 aprilie", () => {
    expect(iso(orthodoxEaster(2026))).toBe("2026-04-12");
  });

  it("2024 → 5 mai, 2027 → 2 mai (Paște târziu, luna trece în mai)", () => {
    expect(iso(orthodoxEaster(2024))).toBe("2024-05-05");
    expect(iso(orthodoxEaster(2027))).toBe("2027-05-02");
  });

  it("cade mereu duminică", () => {
    for (let y = 2020; y <= 2035; y++) expect(orthodoxEaster(y).getDay()).toBe(0);
  });
});

describe("romanianPublicHolidays", () => {
  it("conține toate sărbătorile fixe (Codul muncii art. 139)", () => {
    const h = romanianPublicHolidays(2026);
    for (const key of ["1-1", "1-2", "1-6", "1-7", "1-24", "5-1", "6-1", "8-15", "11-30", "12-25", "12-26"]) {
      expect(h.has(key), `lipsește ${key}`).toBe(true);
    }
  });

  it("conține sărbătorile mobile: Vinerea Mare, Paște + a doua zi, Rusalii + a doua zi", () => {
    // Paște 2026 = 12 aprilie → Vinerea Mare 10.04, a doua zi de Paște 13.04,
    // Rusalii (+49) 31.05, a doua zi 01.06 (care e și Ziua Copilului).
    const h = romanianPublicHolidays(2026);
    expect(h.has("4-10")).toBe(true);
    expect(h.has("4-12")).toBe(true);
    expect(h.has("4-13")).toBe(true);
    expect(h.has("5-31")).toBe(true);
    expect(h.has("6-1")).toBe(true);
  });

  it("2025: Paște 20 aprilie → mobilele sunt 18/20/21 aprilie și 8/9 iunie", () => {
    const h = romanianPublicHolidays(2025);
    for (const key of ["4-18", "4-20", "4-21", "6-8", "6-9"]) {
      expect(h.has(key), `lipsește ${key}`).toBe(true);
    }
  });

  it("nu marchează zile oarecare", () => {
    const h = romanianPublicHolidays(2026);
    expect(h.has("3-15")).toBe(false);
    expect(h.has("10-16")).toBe(false);
  });
});

describe("isWorkingDay", () => {
  it("respinge sâmbăta și duminica", () => {
    expect(isWorkingDay(d(2026, 10, 17))).toBe(false); // sâmbătă
    expect(isWorkingDay(d(2026, 10, 18))).toBe(false); // duminică
  });

  it("acceptă o zi de lucru obișnuită", () => {
    expect(isWorkingDay(d(2026, 10, 16))).toBe(true); // vineri
    expect(isWorkingDay(d(2026, 10, 19))).toBe(true); // luni
  });

  it("respinge sărbătorile legale care cad în timpul săptămânii", () => {
    expect(isWorkingDay(d(2026, 12, 25))).toBe(false); // Crăciun, vineri
    expect(isWorkingDay(d(2026, 1, 1))).toBe(false); // joi
    expect(isWorkingDay(d(2026, 4, 10))).toBe(false); // Vinerea Mare
    expect(isWorkingDay(d(2026, 4, 13))).toBe(false); // a doua zi de Paște, luni
    expect(isWorkingDay(d(2026, 6, 1))).toBe(false); // a doua zi de Rusalii / Ziua Copilului
  });

  it("nu depinde de ora din zi", () => {
    expect(isWorkingDay(d(2026, 10, 16, 0))).toBe(true);
    expect(isWorkingDay(d(2026, 10, 16, 23))).toBe(true);
  });
});

describe("osRegistrationDeadline", () => {
  it("termenul legal e de 5 zile lucrătoare", () => {
    expect(OS_REGISTRATION_WORKING_DAYS).toBe(5);
  });

  it("vineri 16.10.2026 → vineri 23.10.2026 (sare un weekend)", () => {
    const deadline = osRegistrationDeadline(d(2026, 10, 16, 9));
    expect(iso(deadline)).toBe("2026-10-23");
  });

  it("miercuri 23.12.2026 → joi 31.12.2026 (sare Crăciunul)", () => {
    // 24 = zi 1; 25 + 26 Crăciun; 27 duminică; 28,29,30 = zilele 2–4; 31 = ziua 5.
    const deadline = osRegistrationDeadline(d(2026, 12, 23, 15));
    expect(iso(deadline)).toBe("2026-12-31");
  });

  it("termenul expiră la sfârșitul zilei (23:59:59.999 local)", () => {
    const deadline = osRegistrationDeadline(d(2026, 10, 16, 9));
    expect([deadline.getHours(), deadline.getMinutes(), deadline.getSeconds(), deadline.getMilliseconds()]).toEqual([
      23, 59, 59, 999,
    ]);
  });

  it("nu modifică data primită", () => {
    const from = d(2026, 10, 16, 9);
    const snapshot = from.getTime();
    osRegistrationDeadline(from);
    expect(from.getTime()).toBe(snapshot);
  });
});

describe("addWorkingDays", () => {
  it("0 zile → aceeași zi, la sfârșitul ei", () => {
    expect(iso(addWorkingDays(d(2026, 10, 17), 0))).toBe("2026-10-17");
  });

  it("ziua 0 e ziua de plecare: prima zi lucrătoare e cea de după", () => {
    expect(iso(addWorkingDays(d(2026, 10, 16), 1))).toBe("2026-10-19"); // vineri → luni
  });

  it("pornind din weekend, numărătoarea începe luni", () => {
    expect(iso(addWorkingDays(d(2026, 10, 17), 2))).toBe("2026-10-20"); // sâmbătă → luni, marți
  });

  it("termenul de 2 zile pentru exemplarul clientului (ANRE 179/2015 art. 9 alin. 7)", () => {
    expect(iso(addWorkingDays(d(2026, 12, 24), 2))).toBe("2026-12-29");
  });
});

describe("daysUntil", () => {
  it("pozitiv înainte de termen, negativ după", () => {
    expect(daysUntil(d(2026, 10, 20), d(2026, 10, 16))).toBe(4);
    expect(daysUntil(d(2026, 10, 16), d(2026, 10, 20))).toBe(-4);
  });

  it("0 în aceeași zi, indiferent de oră", () => {
    expect(daysUntil(d(2026, 10, 16, 23), d(2026, 10, 16, 0))).toBe(0);
    expect(daysUntil(d(2026, 10, 16, 0), d(2026, 10, 16, 23))).toBe(0);
  });

  it("numără zile întregi, nu fracțiuni (termen la 23:59 vs. acum la 00:01)", () => {
    const deadline = osRegistrationDeadline(d(2026, 10, 16, 9)); // 23.10 la 23:59:59.999
    expect(daysUntil(deadline, new Date(2026, 9, 22, 0, 1))).toBe(1);
    expect(daysUntil(deadline, d(2026, 10, 23, 23))).toBe(0);
    expect(daysUntil(deadline, d(2026, 10, 24, 1))).toBe(-1);
  });

  it("trece corect peste schimbarea de oră (ultima duminică din octombrie)", () => {
    // 25.10.2026 e trecerea la ora de iarnă în RO: diferența brută e de 24h+1h.
    expect(daysUntil(d(2026, 10, 26), d(2026, 10, 24))).toBe(2);
    expect(daysUntil(d(2026, 10, 26), d(2026, 10, 25))).toBe(1);
  });
});
