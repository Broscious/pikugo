import type { Point, Size } from "../core/geometry";
import { grayFromRgba, matchPoint, type GrayImage, type MatchOutcome } from "../core/match";

/**
 * Photos are resized so their longest edge is this many pixels before
 * matching. Using the same size for every photo puts them at roughly the same
 * scale (assuming a similar field of view) and keeps matching fast.
 */
export const MATCH_EDGE = 1024;

/** Size a photo is resized to for matching. */
export function matchSize(size: Size, edge = MATCH_EDGE): Size {
  const scale = edge / Math.max(size.width, size.height);
  return { width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) };
}

/** An image and the size to draw it at for matching. */
export interface MatchImage extends Size {
  image: CanvasImageSource;
}

/** Draws an image at the given size and returns its pixels. */
export type PixelReader = (image: CanvasImageSource, width: number, height: number) => ImageData;

export function toGray(source: MatchImage, read: PixelReader): GrayImage {
  const pixels = read(source.image, source.width, source.height);
  return grayFromRgba(pixels.data, pixels.width, pixels.height);
}

/** Match `focus` (in the reference's matching-size pixels) against each target. */
export function matchAll(
  reference: MatchImage,
  focus: Point,
  targets: readonly MatchImage[],
  read: PixelReader,
  onProgress?: (done: number, total: number) => void,
): MatchOutcome[] {
  const source = toGray(reference, read);
  return targets.map((target, index) => {
    const outcome = matchPoint(source, focus, toGray(target, read));
    onProgress?.(index + 1, targets.length);
    return outcome;
  });
}
