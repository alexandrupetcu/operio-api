import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { cleanStampImage } from "./stamp-image.js";

/**
 * „Poze de telefon” sintetice: hârtie gri-gălbuie cu lumină neuniformă (umbră pe o parte),
 * o ștampilă albastră și câteva puncte de murdărie departe de ea.
 */
async function photo(stampSvg: string, w = 1200, h = 900) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="0.3">
      <stop offset="0" stop-color="#e9e3cf"/><stop offset="1" stop-color="#a8a291"/></linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    ${stampSvg}
    <circle cx="60" cy="60" r="3" fill="#333"/><circle cx="${w - 50}" cy="${h - 70}" r="2.5" fill="#444"/>
    <circle cx="${w - 80}" cy="80" r="3" fill="#2a3a8a"/>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
}

async function analyse(png: Buffer) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let opaque = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 128) opaque++;
  const corner = data[3]; // colțul din stânga sus: trebuie să fie transparent
  return { w: info.width, h: info.height, opaque, corner };
}

const ROUND = `<g fill="none" stroke="#2b3f9e" stroke-width="10">
  <circle cx="600" cy="450" r="170"/><circle cx="600" cy="450" r="120"/></g>
  <text x="600" y="465" font-size="44" text-anchor="middle" fill="#2b3f9e" font-family="Arial" font-weight="bold">PIC SRL</text>`;

describe("cleanStampImage — ștampila dintr-o poză", () => {
  it("hârtia (și partea umbrită) devine transparentă, cerneala rămâne", async () => {
    const out = await analyse(await cleanStampImage(await photo(ROUND)));
    expect(out.corner).toBe(0);
    expect(out.opaque).toBeGreaterThan(5000);
    // Doar ștampila: inelele (2·π·170·10 + 2·π·120·10 ≈ 18 000 px) + textul, nu hârtia (≈1 milion px).
    expect(out.opaque).toBeLessThan(60_000);
  });

  it("se taie la ștampilă (cu o margine mică), fără punctele de murdărie din colțuri", async () => {
    const out = await analyse(await cleanStampImage(await photo(ROUND)));
    // Ștampila are ~350 px; imaginea era 1200×900.
    expect(out.w).toBeGreaterThan(340);
    expect(out.w).toBeLessThan(420);
    expect(out.h).toBeGreaterThan(340);
    expect(out.h).toBeLessThan(420);
  });

  it("o ștampilă dreptunghiulară fotografiată strâmb se îndreaptă", async () => {
    const rect = `<g transform="rotate(9 600 450)">
      <rect x="380" y="400" width="440" height="100" fill="none" stroke="#3a2a8e" stroke-width="8"/>
      <text x="600" y="462" font-size="40" text-anchor="middle" fill="#3a2a8e" font-family="Arial" font-weight="bold">SEF SANTIER</text></g>`;
    const out = await analyse(await cleanStampImage(await photo(rect)));
    // Strâmbă, cutia ar avea ~450×170; îndreptată, ~450×110 (+ margine).
    expect(out.w / out.h).toBeGreaterThan(3.3);
  });

  it("muchia foii / a mesei din poză și murdăria de pe hârtie nu intră în ștampilă", async () => {
    const edge = `${ROUND}<polygon points="1100,900 1200,700 1200,900" fill="#3b372e"/>
      ${Array.from({ length: 30 }, (_, k) => `<circle cx="${80 + ((k * 97) % 1040)}" cy="${60 + ((k * 61) % 780)}" r="2" fill="#555"/>`).join("")}`;
    const out = await analyse(await cleanStampImage(await photo(edge)));
    expect(out.w).toBeLessThan(420);
    expect(out.h).toBeLessThan(420);
  });

  it("o scanare curată (fond alb) iese la fel de bine", async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="100%" height="100%" fill="#fff"/>${ROUND.replace(/600/g, "400").replace(/450/g, "300")}</svg>`;
    const out = await analyse(await cleanStampImage(await sharp(Buffer.from(svg)).png().toBuffer()));
    expect(out.corner).toBe(0);
    expect(out.w).toBeLessThan(420);
    expect(out.opaque).toBeGreaterThan(5000);
  });

  it("o imagine fără nimic pe ea nu dă eroare", async () => {
    const blank = await sharp({ create: { width: 300, height: 200, channels: 3, background: "#f2f0ea" } }).png().toBuffer();
    const out = await analyse(await cleanStampImage(blank));
    expect(out.w).toBeGreaterThan(0);
  });
});
