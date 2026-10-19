import { describe, expect, it } from "vitest";
import { escapeHtml } from "./html-escape.js";

describe("escapeHtml", () => {
  it("scapă toate cele cinci caractere periculoase", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });

  it("scapă ampersandul înaintea restului (fără dublă codare inversă)", () => {
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });

  it("neutralizează un `<script>` interpolat în nod text", () => {
    expect(escapeHtml("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("neutralizează ieșirea dintr-un atribut cu ghilimele duble sau simple", () => {
    expect(escapeHtml('" onload="alert(1)')).toBe("&quot; onload=&quot;alert(1)");
    expect(escapeHtml("' onload='alert(1)")).toBe("&#39; onload=&#39;alert(1)");
  });

  it("null / undefined → șir gol (valoarea lipsă se randează ca până acum)", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });

  it("valorile care nu sunt text se convertesc întâi", () => {
    expect(escapeHtml(0)).toBe("0");
    expect(escapeHtml(false)).toBe("false");
    expect(escapeHtml(12.5)).toBe("12.5");
    expect(escapeHtml(new Date(0).getTime())).toBe("0");
  });

  it("textul curat rămâne neatins, inclusiv diacriticele", () => {
    expect(escapeHtml("Revizie instalație — Bucureşti")).toBe("Revizie instalație — Bucureşti");
    expect(escapeHtml("")).toBe("");
  });

  it("e idempotent în sensul că nu mai rămâne niciun caracter periculoas", () => {
    const once = escapeHtml(`<a href="x">&'</a>`);
    expect(once).not.toMatch(/[<>"']/);
  });
});
