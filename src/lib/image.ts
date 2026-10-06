import sharp from "sharp";

/**
 * Convert an uploaded logo (jpeg/png/etc.) to a normalized PNG buffer. Unlike
 * `removeWhiteBackground` used for stamps/signatures, logos keep their original
 * appearance — backgrounds, colors, and white space are preserved (a brand mark
 * often *needs* its white container). Output is always PNG so the docx image
 * module can embed it with a single consistent mimetype.
 */
export async function normalizeLogo(input: Buffer): Promise<Buffer> {
  return sharp(input).png().toBuffer();
}

/**
 * Make near-white pixels transparent so a scanned/photographed stamp or
 * signature overlays cleanly when placed over document text. Returns a PNG.
 */
export async function removeWhiteBackground(input: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(input)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const threshold = 200; // pixels with R,G,B all above this become transparent
  const pixels = new Uint8Array(data);

  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    if (r > threshold && g > threshold && b > threshold) {
      pixels[i + 3] = 0; // set alpha to 0 (transparent)
    }
  }

  return sharp(Buffer.from(pixels), {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .png()
    .toBuffer();
}
