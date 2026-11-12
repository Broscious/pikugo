import type { Point, Size } from "../core/geometry";
import { grayFromRgba, isConfident, matchPoint, type GrayImage, type MatchOutcome } from "../core/match";

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

/**
 * A run of photos matched one after another. The first target is matched
 * against `start`, and each later target against the last photo in the run
 * that matched confidently. Neighbouring frames usually differ least, so this
 * finds matches that a single distant reference would miss.
 */
export interface MatchChain {
  /** Index of the photo whose point is known. */
  start: number;
  /** The known point, in the start photo's matching-size pixels. */
  focus: Point;
  /** Indices of the photos to match, in order. */
  targets: number[];
}

/** Run each chain over `images`, returning one outcome per target, per chain. */
export function matchChains(
  images: readonly MatchImage[],
  chains: readonly MatchChain[],
  read: PixelReader,
  onProgress?: (done: number, total: number) => void,
): MatchOutcome[][] {
  const total = chains.reduce((sum, chain) => sum + chain.targets.length, 0);
  let done = 0;
  return chains.map((chain) => {
    let source = toGray(images[chain.start]!, read);
    let focus = chain.focus;
    return chain.targets.map((index) => {
      const target = toGray(images[index]!, read);
      const outcome = matchPoint(source, focus, target);
      // Only a confident match is trusted as the reference for the next photo.
      if (outcome.ok && isConfident(outcome)) {
        source = target;
        focus = outcome.point;
      }
      done += 1;
      onProgress?.(done, total);
      return outcome;
    });
  });
}
