import sharp from "sharp";

/**
 * Ensure output is true 9:16 portrait without "weird crops":
 * - create a blurred 9:16 background (cover)
 * - composite the image resized to fit inside (contain)
 *
 * This preserves the full content while still forcing 9:16.
 */
export async function ensurePortrait916(
  input: Buffer,
  targetWidth = 1080,
  targetHeight = 1920
): Promise<Buffer> {
  const base = sharp(input).rotate();

  const bg = await base
    .clone()
    .resize(targetWidth, targetHeight, { fit: "cover", position: "centre" })
    .blur(28)
    .jpeg({ quality: 80 })
    .toBuffer();

  const fg = await base
    .clone()
    .resize(targetWidth, targetHeight, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  return sharp(bg)
    .composite([{ input: fg, gravity: "centre" }])
    .jpeg({ quality: 92 })
    .toBuffer();
}

