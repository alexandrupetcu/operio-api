import sharp from "sharp";

/**
 * Imaginile datelor de exemplu (vezi modules/tenant/sample-data.ts): o semnătură
 * „de mână” și o ștampilă rotundă, desenate din SVG și randate cu sharp în PNG
 * transparent. Ștampila poartă mereu „EXEMPLU” mare, pe diagonală, ca să nu poată
 * fi confundată cu una reală. Totul e determinist (aceleași intrări → același PNG).
 */

export const SIGNATURE_SIZE = { width: 600, height: 200 } as const;
export const STAMP_SIZE = 480;

const INK_SIGNATURE = "#1b2a78";
const INK_STAMP = "#2340a8";

const escapeXml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** Generator pseudo-aleator mic (mulberry32), cu sămânța din text. */
function rng(seedText: string) {
  let h = 2166136261;
  for (let i = 0; i < seedText.length; i++) h = Math.imul(h ^ seedText.charCodeAt(i), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Pt = [number, number];

/** Curbă netedă (Catmull-Rom → Bézier cubic) prin puncte. */
function smoothPath(pts: Pt[]): string {
  if (pts.length < 2) return "";
  const f = (n: number) => n.toFixed(1);
  let d = `M${f(pts[0][0])},${f(pts[0][1])}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1: Pt = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2: Pt = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${f(c1[0])},${f(c1[1])} ${f(c2[0])},${f(c2[1])} ${f(p2[0])},${f(p2[1])}`;
  }
  return d;
}

/**
 * Un „cuvânt” scris legat: o majusculă înaltă (o buclă mare), apoi bucle mici
 * de cicloidă (ca „e”/„l” legate), cu înălțimi variabile. Întoarce punctele și x-ul de final.
 */
function cursiveWord(rand: () => number, x0: number, baseline: number, letters: number): { pts: Pt[]; end: number } {
  const pts: Pt[] = [];
  // Majuscula: urcă mult, buclă înapoi, coboară sub linie.
  const capH = 95 + rand() * 25;
  pts.push([x0, baseline + 10], [x0 + 14, baseline - capH * 0.6], [x0 + 26, baseline - capH], [x0 + 12, baseline - capH * 0.95]);
  pts.push([x0 + 6, baseline - capH * 0.5], [x0 + 18, baseline + 14], [x0 + 34, baseline - 12]);
  let x = x0 + 34;
  // Literele mici: x = x + k·t + A·cos(t)  (A > k → bucle), y = baseline − h·|sin|
  for (let i = 0; i < letters; i++) {
    const kind = rand();
    if (kind < 0.3 && i > 0) {
      // Arcadă („n”/„m”): urcă și coboară fără buclă.
      const humps = rand() < 0.5 ? 1 : 2;
      const h = 22 + rand() * 10;
      for (let k = 0; k < humps; k++) {
        const w = 13 + rand() * 6;
        pts.push([x + w * 0.15, baseline - h * 0.8], [x + w * 0.5, baseline - h], [x + w * 0.85, baseline - h * 0.6], [x + w, baseline]);
        x += w;
      }
      continue;
    }
    const tall = rand() < 0.3;
    const h = tall ? 55 + rand() * 25 : 18 + rand() * 16;
    const w = 13 + rand() * 12;
    const loop = 6 + rand() * 6;
    const steps = 8;
    for (let s = 1; s <= steps; s++) {
      const t = (s / steps) * Math.PI * 2;
      const px = x + (w * s) / steps - loop * Math.sin(t);
      const py = baseline - h * (1 - Math.cos(t)) * 0.5 + (rand() - 0.5) * 2;
      pts.push([px, py]);
    }
    x += w;
  }
  return { pts, end: x };
}

/** Semnătura de exemplu (PNG transparent, 600×200): două cuvinte legate și o trăsătură de subliniere. */
export async function renderSignaturePng(name: string): Promise<Buffer> {
  const rand = rng(name);
  const { width, height } = SIGNATURE_SIZE;
  const parts = name.replace(/^Exemplu\s*—\s*/i, "").split(/\s+/).filter(Boolean);
  const first = parts[0] ?? "A";
  const last = parts[parts.length - 1] ?? "B";
  const baseline = 128;

  // Prenumele: doar inițiala și 1–2 bucle; numele: mai multe litere (max 7, ca să încapă).
  const w1 = cursiveWord(rand, 36, baseline, Math.min(2, Math.max(1, first.length - 3)));
  const w2 = cursiveWord(rand, w1.end + 40, baseline + 4, Math.min(7, Math.max(3, last.length)));
  // Subliniere: din coada numelui, înapoi spre stânga, ușor ascendentă.
  const tail: Pt[] = [
    [w2.end + 10, baseline - 6],
    [w2.end + 26, baseline + 18],
    [w2.end - 40, baseline + 34],
    [(w1.end + w2.end) / 2, baseline + 38 + rand() * 6],
    [70, baseline + 30],
  ];
  const sx = Math.min(1, (width - 30) / (w2.end + 40));
  const paths = [smoothPath(w1.pts), smoothPath([...w2.pts, ...tail])];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <g transform="translate(10,0) scale(${sx.toFixed(3)},1) skewX(-12) translate(30,0)" fill="none" stroke="${INK_SIGNATURE}" stroke-linecap="round" stroke-linejoin="round">
    ${paths.map((d, i) => `<path d="${d}" stroke-width="${i === 0 ? 3.4 : 3}"/>`).join("\n    ")}
    <circle cx="${(w1.pts[2][0] + 2).toFixed(1)}" cy="${(baseline - 4).toFixed(1)}" r="2.2" fill="${INK_SIGNATURE}" stroke="none"/>
  </g>
</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

export interface StampSpec {
  /** Textul de pe coroana de sus (numele firmei). */
  firm: string;
  /** Numele persoanei, în centru. */
  person: string;
  /** Rândurile din centru, sub nume (ex. „Instalator autorizat ANRE”, „EGIU nr. EX-000101”). */
  lines: string[];
  /** Textul de pe coroana de jos (ex. „ANRE · EGIU / EGD”). */
  bottom: string;
}

/**
 * Text pe arc, literă cu literă (fără `textPath` — librsvg-ul din sharp nu-l
 * suportă peste tot). `top` = citit de la stânga la dreapta pe partea de sus.
 */
function arcText(text: string, cx: number, cy: number, r: number, fontSize: number, top: boolean, maxSpan: number): string {
  const chars = [...text];
  if (chars.length === 0) return "";
  // Pas unghiular ≈ lățimea medie a unei litere (0,62 em) pe rază; strâns dacă nu încape.
  let step = (fontSize * 0.62) / r;
  if (step * (chars.length - 1) > maxSpan) step = maxSpan / Math.max(1, chars.length - 1);
  const span = step * (chars.length - 1);
  const center = top ? -Math.PI / 2 : Math.PI / 2;
  return chars
    .map((ch, i) => {
      const a = top ? center - span / 2 + i * step : center + span / 2 - i * step;
      const x = cx + r * Math.cos(a);
      const y = cy + r * Math.sin(a);
      const rot = (a * 180) / Math.PI + (top ? 90 : -90);
      return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" transform="rotate(${rot.toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)})" text-anchor="middle" dominant-baseline="central">${escapeXml(ch)}</text>`;
    })
    .join("");
}

/** Ștampila de exemplu (PNG transparent, 480×480): inel dublu, text pe coroană, „EXEMPLU” pe diagonală. */
export async function renderStampPng(spec: StampSpec): Promise<Buffer> {
  const S = STAMP_SIZE;
  const c = S / 2;
  const firm = spec.firm.toUpperCase().slice(0, 42);
  const bottom = spec.bottom.toUpperCase().slice(0, 42);
  const fitSize = (text: string, max: number, width: number) => Math.min(max, Math.floor(width / (Math.max(1, text.length) * 0.58)));
  const personSize = fitSize(spec.person, 26, 240);
  const lines = spec.lines.slice(0, 3);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
  <g fill="none" stroke="${INK_STAMP}">
    <circle cx="${c}" cy="${c}" r="226" stroke-width="7"/>
    <circle cx="${c}" cy="${c}" r="214" stroke-width="2.5"/>
    <circle cx="${c}" cy="${c}" r="150" stroke-width="3"/>
  </g>
  <g fill="${INK_STAMP}" font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-weight="bold" font-size="25">
    ${arcText(firm, c, c, 183, 25, true, Math.PI * 0.95)}
  </g>
  <g fill="${INK_STAMP}" font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-weight="bold" font-size="21">
    ${arcText(bottom, c, c, 183, 21, false, Math.PI * 0.8)}
  </g>
  <g fill="${INK_STAMP}" font-family="DejaVu Sans, Arial, Helvetica, sans-serif" text-anchor="middle">
    <circle cx="${c - 196}" cy="${c}" r="5"/><circle cx="${c + 196}" cy="${c}" r="5"/>
    <text x="${c}" y="${c - 66}" font-size="${personSize}" font-weight="bold">${escapeXml(spec.person)}</text>
    ${lines
      .map((l, i) => `<text x="${c}" y="${c + 62 + i * 25}" font-size="${fitSize(l, 18, 240 - i * 30)}">${escapeXml(l)}</text>`)
      .join("\n    ")}
  </g>
  <g transform="rotate(-8 ${c} ${c})" font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-weight="bold" text-anchor="middle">
    <rect x="${c - 168}" y="${c - 34}" width="336" height="68" rx="8" fill="none" stroke="${INK_STAMP}" stroke-width="5"/>
    <text x="${c}" y="${c + 21}" font-size="56" letter-spacing="3" fill="${INK_STAMP}">EXEMPLU</text>
  </g>
</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}
