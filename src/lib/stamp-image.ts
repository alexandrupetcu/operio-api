import sharp from "sharp";
import { removeWhiteBackground } from "./image.js";

/**
 * Ștampila (sau semnătura) încărcată ca poză de telefon / scanare → PNG transparent, tăiat
 * la ea, îndreptat. Fără „AI generativ”: imaginea reală e doar curățată, nimic redesenat
 * (pe documente oficiale ștampila trebuie să rămână copia celei reale).
 *
 *   1. fundalul: lumina hârtiei se estimează pe blocuri (cel mai luminos pixel din fiecare
 *      bloc, netezit), iar fiecare pixel se împarte la ea — hârtia gri / umbrită ajunge albă;
 *   2. cerneala = ce e mult mai închis sau colorat decât hârtia (margine moale, fără zimți);
 *   3. punctele de murdărie departe de ștampilă dispar;
 *   4. o ștampilă alungită (dreptunghiulară, semnătură) fotografiată strâmb se îndreaptă;
 *   5. se taie la ștampilă, cu o margine mică.
 */
const MAX_SIDE = 1600;

export async function cleanStampImage(input: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(input)
    .rotate() // orientarea EXIF a pozelor de telefon
    .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" }) // PNG-urile deja transparente: pe alb
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  const px = new Uint8Array(data);

  const bg = paperLight(px, w, h);
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0, j = 0; i < w * h; i++, j += 3) {
    const r = Math.min(1, px[j] / bg[j]);
    const g = Math.min(1, px[j + 1] / bg[j + 1]);
    const b = Math.min(1, px[j + 2] / bg[j + 2]);
    const dark = 1 - (0.299 * r + 0.587 * g + 0.114 * b);
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    const ink = Math.max(dark, chroma * 0.8);
    const a = smoothstep(0.15, 0.32, ink);
    const o = i * 4;
    rgba[o] = r * 255;
    rgba[o + 1] = g * 255;
    rgba[o + 2] = b * 255;
    rgba[o + 3] = a * 255;
  }

  removeStraySpecks(rgba, w, h);
  keepEdgesNearInk(rgba, w, h);
  const angle = skewAngle(rgba, w, h);

  let png = await sharp(Buffer.from(rgba.buffer), { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
  if (angle !== 0) {
    png = await sharp(png).rotate(-angle, { background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  }
  const cropped = await cropToInk(png);
  // Nimic recunoscut drept cerneală: varianta veche (doar albul devine transparent).
  return cropped ?? removeWhiteBackground(input);
}

const smoothstep = (lo: number, hi: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
};

/** Lumina hârtiei în fiecare pixel (RGB), din cel mai luminos pixel al blocurilor din jur. */
function paperLight(px: Uint8Array, w: number, h: number): Float32Array {
  const B = Math.max(8, Math.round(Math.min(w, h) / 40));
  const bw = Math.ceil(w / B);
  const bh = Math.ceil(h / B);
  const block = new Float32Array(bw * bh * 3);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let best = -1;
      let bi = 0;
      for (let y = by * B; y < Math.min(h, (by + 1) * B); y++) {
        for (let x = bx * B; x < Math.min(w, (bx + 1) * B); x++) {
          const j = (y * w + x) * 3;
          const l = px[j] * 0.299 + px[j + 1] * 0.587 + px[j + 2] * 0.114;
          if (l > best) {
            best = l;
            bi = j;
          }
        }
      }
      const o = (by * bw + bx) * 3;
      block[o] = px[bi];
      block[o + 1] = px[bi + 1];
      block[o + 2] = px[bi + 2];
    }
  }
  // Cel mai luminos dintre vecini: un bloc acoperit de cerneală ia lumina hârtiei de lângă.
  const lit = new Float32Array(block.length);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let best = -1;
      let bo = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = bx + dx;
          const y = by + dy;
          if (x < 0 || y < 0 || x >= bw || y >= bh) continue;
          const o = (y * bw + x) * 3;
          const l = block[o] * 0.299 + block[o + 1] * 0.587 + block[o + 2] * 0.114;
          if (l > best) {
            best = l;
            bo = o;
          }
        }
      }
      const o = (by * bw + bx) * 3;
      lit[o] = block[bo];
      lit[o + 1] = block[bo + 1];
      lit[o + 2] = block[bo + 2];
    }
  }
  // Interpolare biliniară între centrele blocurilor.
  const out = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const fy = Math.min(bh - 1, Math.max(0, (y + 0.5) / B - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(bh - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(bw - 1, Math.max(0, (x + 0.5) / B - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(bw - 1, x0 + 1);
      const tx = fx - x0;
      for (let c = 0; c < 3; c++) {
        const v00 = lit[(y0 * bw + x0) * 3 + c];
        const v01 = lit[(y0 * bw + x1) * 3 + c];
        const v10 = lit[(y1 * bw + x0) * 3 + c];
        const v11 = lit[(y1 * bw + x1) * 3 + c];
        const v = (v00 * (1 - tx) + v01 * tx) * (1 - ty) + (v10 * (1 - tx) + v11 * tx) * ty;
        out[(y * w + x) * 3 + c] = Math.max(v, 1);
      }
    }
  }
  return out;
}

/**
 * Componentele de cerneală mici și departe de ștampilă (praf, puncte, colțul unei foi)
 * devin transparente. „Ștampila” = componentele mari; în jurul lor se păstrează tot
 * (literele, diacriticele).
 */
function removeStraySpecks(rgba: Uint8ClampedArray, w: number, h: number) {
  const n = w * h;
  const label = new Int32Array(n).fill(-1);
  const comps: { area: number; x0: number; y0: number; x1: number; y1: number }[] = [];
  const stack: number[] = [];
  for (let s = 0; s < n; s++) {
    if (label[s] !== -1 || rgba[s * 4 + 3] < 128) continue;
    const id = comps.length;
    const c = { area: 0, x0: w, y0: h, x1: 0, y1: 0 };
    label[s] = id;
    stack.push(s);
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % w;
      const y = (p - x) / w;
      c.area++;
      if (x < c.x0) c.x0 = x;
      if (x > c.x1) c.x1 = x;
      if (y < c.y0) c.y0 = y;
      if (y > c.y1) c.y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const q = ny * w + nx;
          if (label[q] === -1 && rgba[q * 4 + 3] >= 128) {
            label[q] = id;
            stack.push(q);
          }
        }
      }
    }
    comps.push(c);
  }
  if (!comps.length) return;
  // Ce atinge marginea pozei (muchia foii, masa, umbra) nu e ștampilă.
  const touchesEdge = (c: (typeof comps)[number]) => c.x0 === 0 || c.y0 === 0 || c.x1 === w - 1 || c.y1 === h - 1;
  const inner = comps.map((c, i) => ({ c, i })).filter(({ c }) => !touchesEdge(c));
  if (!inner.length) return;
  const largest = inner.reduce((a, b) => (b.c.area > a.c.area ? b : a));
  // Ștampila crește pornind de la cea mai mare formă: se adaugă formele care se suprapun cu
  // ea (cu o margine de 12%), până nu mai apare nimic nou. Liniile/petele departe rămân afară.
  const minArea = Math.max(12, Math.round(largest.c.area * 0.0015));
  const inStamp = new Set<number>([largest.i]);
  const box = { x0: largest.c.x0, y0: largest.c.y0, x1: largest.c.x1, y1: largest.c.y1 };
  for (let grew = true; grew; ) {
    grew = false;
    const mx = (box.x1 - box.x0) * 0.12 + 6;
    const my = (box.y1 - box.y0) * 0.12 + 6;
    for (const { c, i } of inner) {
      if (inStamp.has(i) || c.area < minArea) continue;
      if (c.x1 < box.x0 - mx || c.x0 > box.x1 + mx || c.y1 < box.y0 - my || c.y0 > box.y1 + my) continue;
      inStamp.add(i);
      box.x0 = Math.min(box.x0, c.x0);
      box.y0 = Math.min(box.y0, c.y0);
      box.x1 = Math.max(box.x1, c.x1);
      box.y1 = Math.max(box.y1, c.y1);
      grew = true;
    }
  }
  const mx = 6;
  const my = 6;
  const keep = comps.map((_, i) => inStamp.has(i));
  for (let p = 0; p < n; p++) {
    const id = label[p];
    if (id >= 0 && !keep[id]) rgba[p * 4 + 3] = 0;
  }
  // Pixelii semitransparenți (marginea moale) din jurul punctelor scoase: și ei afară.
  for (let p = 0; p < n; p++) {
    if (label[p] !== -1 || rgba[p * 4 + 3] === 0) continue;
    const x = p % w;
    const y = (p - x) / w;
    if (x < box.x0 - mx || x > box.x1 + mx || y < box.y0 - my || y > box.y1 + my) rgba[p * 4 + 3] = 0;
  }
}

/**
 * Marginea moale (pixeli semitransparenți) rămâne doar lângă cerneala propriu-zisă: departe
 * de ea, „ceața” slabă din gradientul hârtiei / compresia JPEG devine transparentă.
 */
function keepEdgesNearInk(rgba: Uint8ClampedArray, w: number, h: number) {
  const R = 2;
  const solid = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) solid[p] = rgba[p * 4 + 3] >= 128 ? 1 : 0;
  // Dilatare separabilă: întâi pe orizontală, apoi pe verticală.
  const row = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let d = -R; d <= R && !v; d++) {
        const xx = x + d;
        if (xx >= 0 && xx < w && solid[y * w + xx]) v = 1;
      }
      row[y * w + x] = v;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (solid[p] || rgba[p * 4 + 3] === 0) continue;
      let near = 0;
      for (let d = -R; d <= R && !near; d++) {
        const yy = y + d;
        if (yy >= 0 && yy < h && row[yy * w + x]) near = 1;
      }
      if (!near) rgba[p * 4 + 3] = 0;
    }
  }
}

/**
 * Unghiul (grade) cu care e strâmbă o ștampilă alungită, din axa principală a cernelii.
 * 0 = nu se rotește: ștampilă rotundă / pătrată, abatere neglijabilă sau prea mare ca
 * să fie o poză strâmbă (o ștampilă pusă intenționat vertical rămâne așa).
 */
function skewAngle(rgba: Uint8ClampedArray, w: number, h: number): number {
  let n = 0;
  let sx = 0;
  let sy = 0;
  for (let p = 0; p < w * h; p++) {
    if (rgba[p * 4 + 3] < 128) continue;
    const x = p % w;
    const y = (p - x) / w;
    n++;
    sx += x;
    sy += y;
  }
  if (n < 50) return 0;
  const cx = sx / n;
  const cy = sy / n;
  let xx = 0;
  let yy = 0;
  let xy = 0;
  for (let p = 0; p < w * h; p++) {
    if (rgba[p * 4 + 3] < 128) continue;
    const x = (p % w) - cx;
    const y = Math.floor(p / w) - cy;
    xx += x * x;
    yy += y * y;
    xy += x * y;
  }
  const tr = xx + yy;
  const det = xx * yy - xy * xy;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const l1 = tr / 2 + disc;
  const l2 = tr / 2 - disc;
  if (l2 <= 0 || l1 / l2 < 2.2) return 0; // nu e alungită
  const deg = (0.5 * Math.atan2(2 * xy, xx - yy) * 180) / Math.PI;
  return Math.abs(deg) >= 1.5 && Math.abs(deg) <= 30 ? deg : 0;
}

/** Taie la cerneală, cu o margine de ~3%; null dacă nu e nimic opac. */
async function cropToInk(png: Buffer): Promise<Buffer | null> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] < 128) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  const pad = Math.max(4, Math.round(Math.max(x1 - x0, y1 - y0) * 0.03));
  const left = Math.max(0, x0 - pad);
  const top = Math.max(0, y0 - pad);
  const width = Math.min(w, x1 + pad + 1) - left;
  const height = Math.min(h, y1 + pad + 1) - top;
  return sharp(png).extract({ left, top, width, height }).png().toBuffer();
}

/** `?mode=original` la încărcare: doar albul devine transparent (ca înainte), fără tăiere / îndreptare. */
export type StampImageMode = "clean" | "original";
export const stampImageMode = (q: unknown): StampImageMode =>
  q && typeof q === "object" && (q as { mode?: unknown }).mode === "original" ? "original" : "clean";

export function prepareStampImage(input: Buffer, mode: StampImageMode): Promise<Buffer> {
  return mode === "original" ? removeWhiteBackground(input) : cleanStampImage(input);
}
