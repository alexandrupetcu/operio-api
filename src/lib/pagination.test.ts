import { describe, expect, it } from "vitest";
import { paginationSchema } from "./pagination.js";

describe("paginationSchema", () => {
  it("o pagină mai mare decât maximul se reduce la 100, nu e respinsă", () => {
    // Abonament → „Tehnicieni cu acces mobil” și echipa din editorul de dosar cereau
    // limit=200: răspunsul era 400, iar numărătoarea arăta 0 / lista de oameni era goală.
    expect(paginationSchema.parse({ limit: "200" }).limit).toBe(100);
    expect(paginationSchema.parse({ limit: "50" }).limit).toBe(50);
    expect(paginationSchema.parse({}).limit).toBe(20);
    expect(() => paginationSchema.parse({ limit: "0" })).toThrow();
  });
});
