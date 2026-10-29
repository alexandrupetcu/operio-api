import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { SIGNATURE_SIZE, STAMP_SIZE, renderSignaturePng, renderStampPng } from "./sample-images.js";

async function analyse(png: Buffer) {
  const meta = await sharp(png).metadata();
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const alphaAt = (x: number, y: number) => data[(y * info.width + x) * 4 + 3];
  let opaque = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 128) opaque++;
  const corners = [alphaAt(0, 0), alphaAt(info.width - 1, 0), alphaAt(0, info.height - 1), alphaAt(info.width - 1, info.height - 1)];
  return { format: meta.format, hasAlpha: meta.hasAlpha, w: info.width, h: info.height, opaque, corners };
}

describe("sample-images — semnătura de exemplu", () => {
  it("PNG transparent de 600×200, cu cerneală (dar nu plin)", async () => {
    const out = await analyse(await renderSignaturePng("Exemplu — Andrei Ionescu"));
    expect(out.format).toBe("png");
    expect(out.hasAlpha).toBe(true);
    expect([out.w, out.h]).toEqual([SIGNATURE_SIZE.width, SIGNATURE_SIZE.height]);
    expect(out.corners).toEqual([0, 0, 0, 0]);
    expect(out.opaque).toBeGreaterThan(1500);
    expect(out.opaque).toBeLessThan(out.w * out.h * 0.15);
  });

  it("e deterministă și diferă de la un nume la altul", async () => {
    const a1 = await renderSignaturePng("Exemplu — Maria Dobre");
    const a2 = await renderSignaturePng("Exemplu — Maria Dobre");
    const b = await renderSignaturePng("Exemplu — Radu Stan");
    expect(a1.equals(a2)).toBe(true);
    expect(a1.equals(b)).toBe(false);
  });
});

describe("sample-images — ștampila de exemplu", () => {
  it("PNG transparent pătrat, colțurile transparente, inelul și textul desenate", async () => {
    const png = await renderStampPng({
      firm: "Instal Gaz & Fiu S.R.L.", // „&” trebuie scăpat în SVG
      person: "Andrei Ionescu",
      lines: ["Instalator autorizat ANRE", "EGIU nr. EX-000101"],
      bottom: "ANRE · EGIU",
    });
    const out = await analyse(png);
    expect(out.format).toBe("png");
    expect([out.w, out.h]).toEqual([STAMP_SIZE, STAMP_SIZE]);
    expect(out.corners).toEqual([0, 0, 0, 0]);
    // Inelele singure (2π·226·7 + 2π·214·2,5 + 2π·150·3 ≈ 16 000 px) + text + „EXEMPLU”.
    expect(out.opaque).toBeGreaterThan(16_000);
    expect(out.opaque).toBeLessThan(STAMP_SIZE * STAMP_SIZE * 0.4);
  });

  it("cerneala e albastră", async () => {
    const png = await renderStampPng({ firm: "Firma", person: "X Y", lines: [], bottom: "ANRE" });
    const { data } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let r = 0, b = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 200) { r += data[i]; b += data[i + 2]; }
    expect(b).toBeGreaterThan(r * 2);
  });
});
