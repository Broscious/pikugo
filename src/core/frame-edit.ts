/**
 * Moving and resizing the output frame by hand.
 *
 * Everything is in "focus space" (see geometry.ts): the shared focal point is
 * the origin. The frame always keeps the focal point inside it, and stays
 * within `bounds`, the area it may cover (the photos' overlap when cropping).
 */
import { clamp, type Point, type Rect, type Size } from "./geometry";

/** Which edges a handle drags: -1 the left/top edge, 1 the right/bottom edge, 0 neither. */
export interface Handle {
  x: -1 | 0 | 1;
  y: -1 | 0 | 1;
}

/** Smallest frame side, in source pixels. */
export const MIN_FRAME_SIZE = 32;

/** Keep `low <= value <= high`, preferring `high` when the range is empty. */
function fit(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/**
 * Resize `start` by dragging `handle` to `pointer`.
 *
 * - Free aspect ratio (`ratio` null): a side handle moves only that edge, and
 *   a corner moves its two edges.
 * - Fixed aspect ratio: the whole frame scales about the focal point (the
 *   point the photos are lined up on), so all four edges move and the focal
 *   point keeps its relative position in the frame. The dragged edge follows
 *   the pointer; a corner follows whichever direction it moved further.
 */
export function resizeFrame(start: Rect, handle: Handle, pointer: Point, bounds: Rect, ratio: number | null, min = MIN_FRAME_SIZE): Rect {
  let left = start.x;
  let top = start.y;
  let right = start.x + start.width;
  let bottom = start.y + start.height;
  const boundsRight = bounds.x + bounds.width;
  const boundsBottom = bounds.y + bounds.height;

  if (ratio === null) {
    if (handle.x === 1) {
      right = fit(pointer.x, Math.max(0, left + min), boundsRight);
    } else if (handle.x === -1) {
      left = fit(pointer.x, bounds.x, Math.min(0, right - min));
    }
    if (handle.y === 1) {
      bottom = fit(pointer.y, Math.max(0, top + min), boundsBottom);
    } else if (handle.y === -1) {
      top = fit(pointer.y, bounds.y, Math.min(0, bottom - min));
    }
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  // The whole frame scales about the focal point: every edge moves, and the
  // focal point keeps the same fraction across and down the frame.
  const fractionX = -left / start.width;
  const fractionY = -top / start.height;

  /** Span the pointer asks for along one axis, from where it puts the dragged edge. */
  const spanFor = (drag: -1 | 0 | 1, position: number, startSpan: number, fraction: number) => {
    if (drag === 0) {
      return Number.NaN;
    }
    // Share of the span on the dragged side of the focal point.
    const share = drag === 1 ? 1 - fraction : fraction;
    if (share > 0.02) {
      return (drag * position) / share;
    }
    // The dragged edge sits on the focal point, so it can't scale from there: grow by however far it moved.
    const startEdge = drag === 1 ? startSpan * (1 - fraction) : -startSpan * fraction;
    return startSpan + drag * (position - startEdge);
  };
  const fromX = spanFor(handle.x, pointer.x, start.width, fractionX);
  const fromY = spanFor(handle.y, pointer.y, start.height, fractionY) * ratio;
  // A corner follows whichever direction the pointer moved further.
  const wanted = handle.x !== 0 && handle.y !== 0 ? Math.max(fromX, fromY) : handle.x !== 0 ? fromX : fromY;

  /** Largest span along an axis before an edge leaves [low, high]. */
  const room = (fraction: number, low: number, high: number) =>
    Math.min(fraction > 0 ? -low / fraction : Number.POSITIVE_INFINITY, fraction < 1 ? high / (1 - fraction) : Number.POSITIVE_INFINITY);
  const width = fit(
    wanted,
    Math.max(min, min * ratio),
    Math.min(room(fractionX, bounds.x, boundsRight), room(fractionY, bounds.y, boundsBottom) * ratio),
  );
  const height = width / ratio;
  return { x: -fractionX * width, y: -fractionY * height, width, height };
}

/** Move `start` by `delta`, keeping it inside `bounds` and around the focal point. */
export function moveFrame(start: Rect, delta: Point, bounds: Rect): Rect {
  const x = fit(start.x + delta.x, Math.max(bounds.x, -start.width), Math.min(bounds.x + bounds.width - start.width, 0));
  const y = fit(start.y + delta.y, Math.max(bounds.y, -start.height), Math.min(bounds.y + bounds.height - start.height, 0));
  return { ...start, x, y };
}

/** The anchor (focal point as fractions of the frame) and size that describe `frame`. */
export function framingOf(frame: Rect): { anchor: Point; frameSize: Size } {
  return {
    anchor: { x: clamp(-frame.x / frame.width, 0, 1), y: clamp(-frame.y / frame.height, 0, 1) },
    frameSize: { width: frame.width, height: frame.height },
  };
}

/** Smallest rectangle containing both. */
export function unionRect(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}
