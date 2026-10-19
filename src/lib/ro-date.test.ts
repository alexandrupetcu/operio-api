import { describe, expect, it } from "vitest";
import { parseRoDate } from "./ro-date.js";

const iso = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null;

describe("parseRoDate", () => {
  it("formatele scrise de mână în setări", () => {
    expect(iso(parseRoDate("08.12.2025"))).toBe("2025-12-08");
    expect(iso(parseRoDate(" 8/12/2025 "))).toBe("2025-12-08");
    expect(iso(parseRoDate("2025-12-08"))).toBe("2025-12-08");
    expect(iso(parseRoDate("08-12-2025"))).toBe("2025-12-08");
  });

  it("text care nu e o dată validă → null", () => {
    for (const t of ["", "nelimitat", "31.02.2025", "13.13.2025", "2025", null, undefined]) {
      expect(parseRoDate(t)).toBeNull();
    }
  });
});
