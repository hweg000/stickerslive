import { LIMITS } from "./limits";

export interface SquareCropRect {
  srcX: number;
  srcY: number;
  cropSide: number;
  outputSize: number;
}

/** Zoom range of the square crop (StickerEdit.scale). 1 = the shorter side fills the square. */
export const CROP_ZOOM_MIN = 0.25;
export const CROP_ZOOM_MAX = 4;

export function clampCropZoom(zoom: number): number {
  return Number.isFinite(zoom) ? Math.max(CROP_ZOOM_MIN, Math.min(CROP_ZOOM_MAX, zoom)) : 1;
}

/**
 * Computes a 1:1 square crop anchored at normalized (cropX, cropY) in [0, 1]
 * (0.5, 0.5 = center). Output resolution depends solely on the input file,
 * capped at 512x512 and aligned to an even pixel count for video encoders.
 *
 * `zoom` > 1 crops a smaller square (zoom in); < 1 a square larger than the image, so
 * srcX/srcY can be negative and the area outside the image stays empty (matte/transparent).
 */
export function computeSquareCrop(
  srcWidth: number,
  srcHeight: number,
  cropX = 0.5,
  cropY = 0.5,
  zoom = 1
): SquareCropRect {
  const safeW = Math.max(1, Math.round(srcWidth));
  const safeH = Math.max(1, Math.round(srcHeight));
  const baseSide = Math.min(safeW, safeH);
  const cropSide = Math.max(1, Math.round(baseSide / clampCropZoom(zoom)));

  // Resolution follows the file, not the zoom, so zooming in does not shrink the sticker.
  const rawOut = Math.min(LIMITS.STICKER_DIMENSION_PX, baseSide);
  const outputSize = rawOut <= 2 ? rawOut : rawOut - (rawOut % 2);

  const nx = Number.isFinite(cropX) ? Math.max(0, Math.min(1, cropX)) : 0.5;
  const ny = Number.isFinite(cropY) ? Math.max(0, Math.min(1, cropY)) : 0.5;

  const srcX = Math.round((safeW - cropSide) * nx);
  const srcY = Math.round((safeH - cropSide) * ny);

  return { srcX, srcY, cropSide, outputSize };
}
