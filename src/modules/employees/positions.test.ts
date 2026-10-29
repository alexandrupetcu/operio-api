import { describe, expect, it } from "vitest";
import { withPositions } from "./positions.js";

describe("withPositions — un angajat cu mai multe funcții", () => {
  it("lista de funcții: fără dubluri și goluri, prima e funcția principală (`position`)", () => {
    expect(withPositions({ positions: ["sef_santier", "instalator", "sef_santier", " "] })).toEqual({
      positions: ["sef_santier", "instalator"],
      position: "sef_santier",
    });
    expect(withPositions({ positions: [] })).toEqual({ positions: [], position: null });
  });

  it("clienții vechi trimit doar `position` → lista are acea funcție", () => {
    expect(withPositions({ position: "rte" })).toEqual({ position: "rte", positions: ["rte"] });
    expect(withPositions({ position: null })).toEqual({ position: null, positions: [] });
  });

  it("fără niciuna nu atinge funcțiile (editare parțială)", () => {
    expect(withPositions({ phone: "1" })).toEqual({ phone: "1" });
  });
});
