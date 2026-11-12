import { describe, expect, it } from "vitest";
import { framingOf, MIN_FRAME_SIZE, moveFrame, resizeFrame, unionRect } from "../../src/core/frame-edit";

// Focus space: the focal point is the origin.
const start = { x: -100, y: -50, width: 200, height: 100 };
// Left -150, top -100, right 250, bottom 200.
const bounds = { x: -150, y: -100, width: 400, height: 300 };

describe("resizeFrame with a free aspect ratio", () => {
  it("moves only the dragged side", () => {
    expect(resizeFrame(start, { x: 1, y: 0 }, { x: 180, y: 999 }, bounds, null)).toEqual({ x: -100, y: -50, width: 280, height: 100 });
    expect(resizeFrame(start, { x: 0, y: -1 }, { x: 999, y: -80 }, bounds, null)).toEqual({ x: -100, y: -80, width: 200, height: 130 });
  });

  it("moves both sides that meet at a dragged corner", () => {
    expect(resizeFrame(start, { x: 1, y: 1 }, { x: 150, y: 120 }, bounds, null)).toEqual({ x: -100, y: -50, width: 250, height: 170 });
  });

  it("stops at the bounds", () => {
    expect(resizeFrame(start, { x: 1, y: 0 }, { x: 900, y: 0 }, bounds, null).width).toBe(350);
    expect(resizeFrame(start, { x: -1, y: -1 }, { x: -900, y: -900 }, bounds, null)).toEqual({ x: -150, y: -100, width: 250, height: 150 });
  });

  it("keeps the focal point inside the frame", () => {
    expect(resizeFrame(start, { x: -1, y: 0 }, { x: 40, y: 0 }, bounds, null)).toMatchObject({ x: 0, width: 100 });
  });

  it("never gets smaller than the minimum size", () => {
    const small = { x: -10, y: -10, width: 60, height: 60 };
    expect(resizeFrame(small, { x: 1, y: 1 }, { x: -100, y: -100 }, bounds, null)).toMatchObject({ width: MIN_FRAME_SIZE, height: MIN_FRAME_SIZE });
  });
});

describe("resizeFrame with a fixed aspect ratio", () => {
  // The focal point is in the middle of `start`.
  it("scales the whole frame about the focal point when a side is dragged", () => {
    expect(resizeFrame(start, { x: 1, y: 0 }, { x: 125, y: 0 }, bounds, 2)).toEqual({ x: -125, y: -62.5, width: 250, height: 125 });
    expect(resizeFrame(start, { x: -1, y: 0 }, { x: -120, y: 0 }, bounds, 2)).toEqual({ x: -120, y: -60, width: 240, height: 120 });
    expect(resizeFrame(start, { x: 0, y: 1 }, { x: 0, y: 60 }, bounds, 2)).toEqual({ x: -120, y: -60, width: 240, height: 120 });
  });

  it("moves every edge, keeping an off-centre focal point at the same fractions", () => {
    // The focal point is a quarter of the way across and down.
    const offCentre = { x: -50, y: -25, width: 200, height: 100 };
    const result = resizeFrame(offCentre, { x: 1, y: 0 }, { x: 225, y: 0 }, bounds, 2);
    expect(result).toEqual({ x: -75, y: -37.5, width: 300, height: 150 });
    expect(-result.x / result.width).toBe(0.25);
    expect(-result.y / result.height).toBe(0.25);
  });

  it("follows the larger movement at a corner", () => {
    expect(resizeFrame(start, { x: -1, y: -1 }, { x: -130, y: -60 }, bounds, 2)).toEqual({ x: -130, y: -65, width: 260, height: 130 });
  });

  it("stops when any edge reaches the bounds", () => {
    // The left edge reaches -150 first.
    expect(resizeFrame(start, { x: 1, y: 0 }, { x: 400, y: 0 }, bounds, 2)).toEqual({ x: -150, y: -75, width: 300, height: 150 });
  });

  it("never gets smaller than the minimum size", () => {
    expect(resizeFrame(start, { x: 1, y: 0 }, { x: 5, y: 0 }, bounds, 2)).toEqual({ x: -32, y: -16, width: 64, height: 32 });
  });

  it("still resizes when the dragged edge sits on the focal point", () => {
    const onEdge = { x: -200, y: -50, width: 200, height: 100 };
    const wide = { x: -300, y: -100, width: 550, height: 300 };
    expect(resizeFrame(onEdge, { x: 1, y: 0 }, { x: 20, y: 0 }, wide, 2)).toEqual({ x: -220, y: -55, width: 220, height: 110 });
  });
});

describe("moveFrame", () => {
  it("moves the frame without resizing it", () => {
    expect(moveFrame(start, { x: 30, y: -20 }, bounds)).toEqual({ x: -70, y: -70, width: 200, height: 100 });
  });

  it("stays inside the bounds and around the focal point", () => {
    expect(moveFrame(start, { x: 500, y: 0 }, bounds).x).toBe(0);
    expect(moveFrame(start, { x: -500, y: 0 }, bounds).x).toBe(-150);
    expect(moveFrame(start, { x: 0, y: 500 }, bounds).y).toBe(0);
  });
});

describe("framingOf", () => {
  it("describes a frame by where the focal point sits in it and its size", () => {
    expect(framingOf({ x: -50, y: -75, width: 200, height: 100 })).toEqual({ anchor: { x: 0.25, y: 0.75 }, frameSize: { width: 200, height: 100 } });
  });
});

describe("unionRect", () => {
  it("covers both rectangles", () => {
    expect(unionRect({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: -5, width: 10, height: 5 })).toEqual({ x: 0, y: -5, width: 15, height: 15 });
  });
});
