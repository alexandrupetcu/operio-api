import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { PEN_BLUE, penBlue } from "./image.js";

const px = async (png: Buffer, x: number, y: number) => {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * 4;
  return [data[i], data[i + 1], data[i + 2], data[i + 3]];
};

/** 3×1: cerneală neagră, transparent, alb opac. */
const sample = () =>
  sharp(Buffer.from([0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255]), { raw: { width: 3, height: 1, channels: 4 } }).png().toBuffer();

describe("penBlue — semnăturile ca scrise cu pixul", () => {
  it("cerneala neagră devine albastru de pix", async () => {
    expect(await px(await penBlue(await sample()), 0, 0)).toEqual([...PEN_BLUE, 255]);
  });
  it("transparentul rămâne transparent, albul rămâne alb", async () => {
    const out = await penBlue(await sample());
    expect((await px(out, 1, 0))[3]).toBe(0);
    expect(await px(out, 2, 0)).toEqual([255, 255, 255, 255]);
  });
});
