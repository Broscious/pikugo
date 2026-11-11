/**
 * Frame layout maths.
 *
 * Every source image has a focal point. The animation is built by stacking the
 * images so that all focal points land on the same pixel of the output frame.
 * This module decides how big that output frame is and where the shared focal
 * point sits inside it, based on the user's framing options.
 *
 * Coordinates use "focus space" where the shared focal point is the origin, and
 * "frame space" where (0, 0) is the top-left corner of the output frame.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Rect extends Point, Size {}

export interface FrameSource extends Size {
  /** Focal point in the source image's own pixel coordinates. */
  focus: Point;
}

/**
 * - `crop`: the frame only covers pixels every image has, so no frame shows empty space.
 * - `layer`: the frame covers every pixel of every image; gaps become transparent.
 */
export type EdgeMode = "crop" | "layer";

export interface LayoutOptions {
  edges: EdgeMode;
  /** Output width / height. `null` keeps whatever shape the edge mode produces. */
  aspectRatio: number | null;
  /**
   * Where the focal point must appear in the output, as fractions of the frame
   * (0, 0 = top-left, 1, 1 = bottom-right). `null` lets the layout centre it as
   * well as it can.
   */
  anchor: Point | null;
}

export interface FrameLayout extends Size {
  /** Shared focal point in frame space. */
  focus: Point;
  /** Where each source image is drawn, in frame space and source pixels. */
  placements: Rect[];
  /** The region every image covers, in frame space. */
  intersection: Rect;
  /** The region any image covers, in frame space. */
  union: Rect;
  /** Fraction (0..1) of the frame that each image leaves transparent. */
  emptyFraction: number[];
}

/** Largest dimension the WebP container can describe (14-bit width/height). */
export const WEBP_MAX_DIMENSION = 16383;

/**
 * In layer mode the frame grows to keep every image visible. Pinning the focus
 * to the very edge would need an infinitely large frame, so anchors are kept
 * at least this far from each edge.
 */
export const LAYER_ANCHOR_MARGIN = 0.05;

export class LayoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LayoutError";
  }
}

interface Extents {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Clamp a focal point so it lies on the image. */
export function clampFocus(source: Size, focus: Point): Point {
  return {
    x: clamp(Math.round(focus.x), 0, source.width),
    y: clamp(Math.round(focus.y), 0, source.height),
  };
}

function extentsOf(source: FrameSource): Extents {
  const focus = clampFocus(source, source.focus);
  return {
    left: focus.x,
    right: source.width - focus.x,
    top: focus.y,
    bottom: source.height - focus.y,
  };
}

function combineExtents(all: Extents[], pick: (...values: number[]) => number): Extents {
  return {
    left: pick(...all.map((e) => e.left)),
    right: pick(...all.map((e) => e.right)),
    top: pick(...all.map((e) => e.top)),
    bottom: pick(...all.map((e) => e.bottom)),
  };
}

/** Largest span that fits inside [-before, after] with the focus at `anchor`. */
function largestSpanInside(before: number, after: number, anchor: number | null): number {
  if (anchor === null) {
    return before + after;
  }
  const fromBefore = anchor > 0 ? before / anchor : Number.POSITIVE_INFINITY;
  const fromAfter = anchor < 1 ? after / (1 - anchor) : Number.POSITIVE_INFINITY;
  return Math.min(fromBefore, fromAfter);
}

/** Smallest span that contains [-before, after] with the focus at `anchor`. */
function smallestSpanAround(before: number, after: number, anchor: number | null): number {
  if (anchor === null) {
    return before + after;
  }
  return Math.max(before / anchor, after / (1 - anchor));
}

/** Position of the focus along one axis of a frame, keeping it within [min, max]. */
function placeFocus(span: number, anchor: number | null, min: number, max: number, centred: number): number {
  const preferred = anchor === null ? centred : Math.round(anchor * span);
  return clamp(preferred, min, max);
}

function rectFromExtents(focus: Point, extents: Extents): Rect {
  return {
    x: focus.x - extents.left,
    y: focus.y - extents.top,
    width: extents.left + extents.right,
    height: extents.top + extents.bottom,
  };
}

function overlapArea(a: Rect, b: Rect): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

function normaliseAnchor(anchor: Point | null, margin: number): Point | null {
  if (anchor === null) {
    return null;
  }
  return {
    x: clamp(anchor.x, margin, 1 - margin),
    y: clamp(anchor.y, margin, 1 - margin),
  };
}

export function computeLayout(sources: readonly FrameSource[], options: LayoutOptions): FrameLayout {
  if (sources.length === 0) {
    throw new LayoutError("Add at least one image to build a frame.");
  }
  for (const source of sources) {
    if (!(source.width > 0 && source.height > 0)) {
      throw new LayoutError("Image dimensions must be positive.");
    }
  }
  const ratio = options.aspectRatio;
  if (ratio !== null && !(Number.isFinite(ratio) && ratio > 0)) {
    throw new LayoutError("Aspect ratio must be a positive number.");
  }

  const extents = sources.map(extentsOf);
  const shared = combineExtents(extents, Math.min);
  const total = combineExtents(extents, Math.max);

  let width: number;
  let height: number;
  let focus: Point;

  if (options.edges === "crop") {
    const anchor = normaliseAnchor(options.anchor, 0);
    let spanX = largestSpanInside(shared.left, shared.right, anchor?.x ?? null);
    let spanY = largestSpanInside(shared.top, shared.bottom, anchor?.y ?? null);
    if (ratio !== null) {
      spanX = Math.min(spanX, spanY * ratio);
      spanY = spanX / ratio;
    }
    width = Math.floor(spanX + 1e-9);
    height = Math.floor(spanY + 1e-9);
    if (width < 1 || height < 1) {
      throw new LayoutError(
        "The images do not overlap around their focal points. Move the focal points away from the edges or switch to layering.",
      );
    }
    focus = {
      x: placeFocus(width, anchor?.x ?? null, width - shared.right, shared.left, Math.round(width / 2)),
      y: placeFocus(height, anchor?.y ?? null, height - shared.bottom, shared.top, Math.round(height / 2)),
    };
  } else {
    const anchor = normaliseAnchor(options.anchor, LAYER_ANCHOR_MARGIN);
    let spanX = smallestSpanAround(total.left, total.right, anchor?.x ?? null);
    let spanY = smallestSpanAround(total.top, total.bottom, anchor?.y ?? null);
    if (ratio !== null) {
      spanX = Math.max(spanX, spanY * ratio);
      spanY = spanX / ratio;
    }
    width = Math.max(1, Math.ceil(spanX - 1e-9));
    height = Math.max(1, Math.ceil(spanY - 1e-9));
    const unionWidth = total.left + total.right;
    const unionHeight = total.top + total.bottom;
    focus = {
      x: placeFocus(
        width,
        anchor?.x ?? null,
        total.left,
        width - total.right,
        total.left + Math.floor((width - unionWidth) / 2),
      ),
      y: placeFocus(
        height,
        anchor?.y ?? null,
        total.top,
        height - total.bottom,
        total.top + Math.floor((height - unionHeight) / 2),
      ),
    };
  }

  const frame: Rect = { x: 0, y: 0, width, height };
  const placements = sources.map((source) => {
    const sourceFocus = clampFocus(source, source.focus);
    return {
      x: focus.x - sourceFocus.x,
      y: focus.y - sourceFocus.y,
      width: source.width,
      height: source.height,
    };
  });
  const frameArea = width * height;

  return {
    width,
    height,
    focus,
    placements,
    intersection: rectFromExtents(focus, shared),
    union: rectFromExtents(focus, total),
    emptyFraction: placements.map((placement) => 1 - overlapArea(frame, placement) / frameArea),
  };
}

/**
 * Scale factor applied when encoding, so the longest edge fits `maxEdge` and
 * the result stays inside the WebP size limit. Never upscales.
 */
export function outputScale(size: Size, maxEdge: number | null): number {
  const longest = Math.max(size.width, size.height);
  let scale = 1;
  if (maxEdge !== null && maxEdge > 0) {
    scale = Math.min(scale, maxEdge / longest);
  }
  return Math.min(scale, WEBP_MAX_DIMENSION / longest);
}

export function scaledSize(size: Size, scale: number): Size {
  return {
    width: clamp(Math.round(size.width * scale), 1, WEBP_MAX_DIMENSION),
    height: clamp(Math.round(size.height * scale), 1, WEBP_MAX_DIMENSION),
  };
}
