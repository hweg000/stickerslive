import { computeSquareCrop, type RgbaFrame512 } from "@stiksound/core";

export function parseHexColor(hex: string): [number, number, number] {
  const clean = hex.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{6}$/.test(clean)) {
    return [
      parseInt(clean.slice(0, 2), 16),
      parseInt(clean.slice(2, 4), 16),
      parseInt(clean.slice(4, 6), 16)
    ];
  }
  return [255, 255, 255];
}

/**
 * Crops a 1:1 square centered at (cropX, cropY) from the source RGBA buffer
 * and scales it to `outputSize x outputSize` (<= 512, determined solely by input dimensions),
 * preserving straight alpha without premultiplication fringing.
 */
export function cropAndFitSquareRgba(
  src: Uint8Array,
  srcWidth: number,
  srcHeight: number,
  cropX = 0.5,
  cropY = 0.5,
  zoom = 1
): RgbaFrame512 {
  const { srcX, srcY, cropSide, outputSize } = computeSquareCrop(srcWidth, srcHeight, cropX, cropY, zoom);
  const out = new Uint8Array(outputSize * outputSize * 4); // zero = transparent, kept outside the image

  for (let y = 0; y < outputSize; y++) {
    const sy = srcY + ((y + 0.5) * cropSide) / outputSize - 0.5;
    if (sy < -0.5 || sy > srcHeight - 0.5) continue; // zoomed out past the image edge
    const y0 = Math.max(0, Math.min(srcHeight - 1, Math.floor(sy)));
    const y1 = Math.max(0, Math.min(srcHeight - 1, y0 + 1));
    const fy = Math.max(0, sy - y0);

    for (let x = 0; x < outputSize; x++) {
      const sx = srcX + ((x + 0.5) * cropSide) / outputSize - 0.5;
      if (sx < -0.5 || sx > srcWidth - 0.5) continue;
      const x0 = Math.max(0, Math.min(srcWidth - 1, Math.floor(sx)));
      const x1 = Math.max(0, Math.min(srcWidth - 1, x0 + 1));
      const fx = Math.max(0, sx - x0);

      const i00 = (y0 * srcWidth + x0) * 4;
      const i10 = (y0 * srcWidth + x1) * 4;
      const i01 = (y1 * srcWidth + x0) * 4;
      const i11 = (y1 * srcWidth + x1) * 4;

      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;

      const a00 = src[i00 + 3]!;
      const a10 = src[i10 + 3]!;
      const a01 = src[i01 + 3]!;
      const a11 = src[i11 + 3]!;
      const alpha = a00 * w00 + a10 * w10 + a01 * w01 + a11 * w11;

      const dstIdx = (y * outputSize + x) * 4;
      if (alpha <= 0.5) {
        out[dstIdx] = 0;
        out[dstIdx + 1] = 0;
        out[dstIdx + 2] = 0;
        out[dstIdx + 3] = 0;
      } else {
        const r =
          (src[i00]! * a00 * w00 +
            src[i10]! * a10 * w10 +
            src[i01]! * a01 * w01 +
            src[i11]! * a11 * w11) /
          alpha;
        const g =
          (src[i00 + 1]! * a00 * w00 +
            src[i10 + 1]! * a10 * w10 +
            src[i01 + 1]! * a01 * w01 +
            src[i11 + 1]! * a11 * w11) /
          alpha;
        const b =
          (src[i00 + 2]! * a00 * w00 +
            src[i10 + 2]! * a10 * w10 +
            src[i01 + 2]! * a01 * w01 +
            src[i11 + 2]! * a11 * w11) /
          alpha;
        out[dstIdx] = Math.round(r);
        out[dstIdx + 1] = Math.round(g);
        out[dstIdx + 2] = Math.round(b);
        out[dstIdx + 3] = Math.round(alpha);
      }
    }
  }

  return { width: outputSize, height: outputSize, data: out };
}

/** Backwards-compatible alias */
export const containFitRgba512 = cropAndFitSquareRgba;

export function compositeRgbaOnMatte(frame: RgbaFrame512, matteHex: string): Uint8Array {
  const [mr, mg, mb] = parseHexColor(matteHex);
  const out = new Uint8Array(frame.data.length);
  for (let i = 0; i < frame.data.length; i += 4) {
    const a = frame.data[i + 3]! / 255;
    const inv = 1 - a;
    out[i] = Math.round(frame.data[i]! * a + mr * inv);
    out[i + 1] = Math.round(frame.data[i + 1]! * a + mg * inv);
    out[i + 2] = Math.round(frame.data[i + 2]! * a + mb * inv);
    out[i + 3] = 255;
  }
  return out;
}
