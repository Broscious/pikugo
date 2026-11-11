import { describe, expect, it } from "vitest";
import {
  clampFocus,
  computeLayout,
  LAYER_ANCHOR_MARGIN,
  LayoutError,
  outputScale,
  scaledSize,
  WEBP_MAX_DIMENSION,
  type FrameSource,
  type LayoutOptions,
} from "../../src/core/geometry";

const crop: LayoutOptions = { edges: "crop", aspectRatio: null, anchor: null };
const layer: LayoutOptions = { edges: "layer", aspectRatio: null, anchor: null };

function source(width: number, height: number, x: number, y: number): FrameSource {
  return { width, height, focus: { x, y } };
}

/** Every placed image must contain the frame (crop mode never shows empty pixels). */
function expectCovered(layout: ReturnType<typeof computeLayout>) {
  for (const p of layout.placements) {
    expect(p.x).toBeLessThanOrEqual(0);
    expect(p.y).toBeLessThanOrEqual(0);
    expect(p.x + p.width).toBeGreaterThanOrEqual(layout.width);
    expect(p.y + p.height).toBeGreaterThanOrEqual(layout.height);
  }
}

/** Every placed image must be fully inside the frame (layer mode never clips). */
function expectContained(layout: ReturnType<typeof computeLayout>) {
  for (const p of layout.placements) {
    expect(p.x).toBeGreaterThanOrEqual(0);
    expect(p.y).toBeGreaterThanOrEqual(0);
    expect(p.x + p.width).toBeLessThanOrEqual(layout.width);
    expect(p.y + p.height).toBeLessThanOrEqual(layout.height);
  }
}

/** All focal points land on the shared frame focus. */
function expectAligned(sources: FrameSource[], layout: ReturnType<typeof computeLayout>) {
  sources.forEach((s, i) => {
    const p = layout.placements[i]!;
    expect(p.x + s.focus.x).toBe(layout.focus.x);
    expect(p.y + s.focus.y).toBe(layout.focus.y);
  });
}

describe("clampFocus", () => {
  it("rounds and clamps to the image bounds", () => {
    expect(clampFocus({ width: 10, height: 20 }, { x: -3, y: 25.4 })).toEqual({ x: 0, y: 20 });
    expect(clampFocus({ width: 10, height: 20 }, { x: 4.6, y: 7.2 })).toEqual({ x: 5, y: 7 });
  });
});

describe("computeLayout – validation", () => {
  it("rejects an empty source list", () => {
    expect(() => computeLayout([], crop)).toThrow(LayoutError);
  });

  it("rejects non-positive dimensions", () => {
    expect(() => computeLayout([source(0, 10, 0, 0)], crop)).toThrow(LayoutError);
  });

  it("rejects invalid aspect ratios", () => {
    expect(() => computeLayout([source(10, 10, 5, 5)], { ...crop, aspectRatio: 0 })).toThrow(LayoutError);
    expect(() => computeLayout([source(10, 10, 5, 5)], { ...crop, aspectRatio: Number.NaN })).toThrow(LayoutError);
  });

  it("explains when crop mode has no overlap", () => {
    const sources = [source(100, 100, 0, 50), source(100, 100, 100, 50)];
    expect(() => computeLayout(sources, crop)).toThrow(/do not overlap/);
  });
});

describe("computeLayout – crop", () => {
  it("returns the full image for a single source", () => {
    const layout = computeLayout([source(640, 480, 100, 200)], crop);
    expect(layout).toMatchObject({ width: 640, height: 480, focus: { x: 100, y: 200 } });
    expect(layout.placements[0]).toEqual({ x: 0, y: 0, width: 640, height: 480 });
    expect(layout.emptyFraction).toEqual([0]);
  });

  it("crops to the region every image shares around the focal points", () => {
    const sources = [source(100, 100, 50, 50), source(120, 80, 40, 60), source(100, 100, 70, 30)];
    const layout = computeLayout(sources, crop);
    // left = min(50, 40, 70) = 40, right = min(50, 80, 30) = 30
    // top = min(50, 60, 30) = 30, bottom = min(50, 20, 70) = 20
    expect(layout).toMatchObject({ width: 70, height: 50, focus: { x: 40, y: 30 } });
    expect(layout.intersection).toEqual({ x: 0, y: 0, width: 70, height: 50 });
    expectAligned(sources, layout);
    expectCovered(layout);
    expect(layout.emptyFraction.every((f) => f === 0)).toBe(true);
  });

  it("matches the original app behaviour for identical images", () => {
    const sources = [source(200, 100, 0, 0), source(200, 100, 0, 0)];
    expect(computeLayout(sources, crop)).toMatchObject({ width: 200, height: 100 });
  });

  it("applies an aspect ratio while keeping the frame inside the shared area", () => {
    const sources = [source(400, 300, 200, 150), source(400, 300, 220, 140)];
    const layout = computeLayout(sources, { ...crop, aspectRatio: 1 });
    expect(layout.width).toBe(layout.height);
    // Shared area is 380 × 290, so the largest square is 290.
    expect(layout.width).toBe(290);
    expectAligned(sources, layout);
    expectCovered(layout);
  });

  it("centres the focus inside an aspect-cropped frame when there is room", () => {
    const layout = computeLayout([source(1000, 500, 500, 250)], { ...crop, aspectRatio: 1 });
    expect(layout).toMatchObject({ width: 500, height: 500, focus: { x: 250, y: 250 } });
  });

  it("slides the frame towards the focus when it cannot be centred", () => {
    const layout = computeLayout([source(1000, 500, 100, 250)], { ...crop, aspectRatio: 1 });
    expect(layout.width).toBe(500);
    // Only 100px exist to the left of the focus.
    expect(layout.focus.x).toBe(100);
    expectCovered(layout);
  });

  it("handles wide and tall ratios", () => {
    const sources = [source(800, 800, 400, 400)];
    expect(computeLayout(sources, { ...crop, aspectRatio: 16 / 9 })).toMatchObject({ width: 800, height: 450 });
    expect(computeLayout(sources, { ...crop, aspectRatio: 9 / 16 })).toMatchObject({ width: 450, height: 800 });
  });

  it("pins the focus to an anchor", () => {
    const sources = [source(1000, 1000, 500, 500)];
    const layout = computeLayout(sources, { ...crop, anchor: { x: 0.25, y: 0.75 } });
    // Right side limits width: 500 / 0.75 ≈ 666; top limits height: 500 / 0.75 ≈ 666.
    expect(layout).toMatchObject({ width: 666, height: 666 });
    expect(layout.focus.x / layout.width).toBeCloseTo(0.25, 2);
    expect(layout.focus.y / layout.height).toBeCloseTo(0.75, 2);
    expectCovered(layout);
  });

  it("supports anchors on the frame edge", () => {
    const layout = computeLayout([source(300, 200, 100, 50)], { ...crop, anchor: { x: 0, y: 1 } });
    expect(layout).toMatchObject({ width: 200, height: 50, focus: { x: 0, y: 50 } });
  });

  it("combines anchor and aspect ratio", () => {
    const sources = [source(1200, 900, 600, 450), source(1200, 900, 640, 420)];
    const layout = computeLayout(sources, { ...crop, aspectRatio: 1, anchor: { x: 1 / 3, y: 1 / 3 } });
    expect(Math.abs(layout.width - layout.height)).toBeLessThanOrEqual(1);
    expect(layout.focus.x / layout.width).toBeCloseTo(1 / 3, 2);
    expect(layout.focus.y / layout.height).toBeCloseTo(1 / 3, 2);
    expectAligned(sources, layout);
    expectCovered(layout);
  });

  it("clamps focal points that lie outside the image", () => {
    const layout = computeLayout([source(100, 100, 150, -10)], crop);
    expect(layout.focus).toEqual({ x: 100, y: 0 });
  });
});

describe("computeLayout – layer", () => {
  it("grows the frame to contain every image", () => {
    const sources = [source(100, 100, 50, 50), source(120, 80, 40, 60), source(100, 100, 70, 30)];
    const layout = computeLayout(sources, layer);
    // left = max(50, 40, 70) = 70, right = max(50, 80, 30) = 80
    // top = max(50, 60, 30) = 60, bottom = max(50, 20, 70) = 70
    expect(layout).toMatchObject({ width: 150, height: 130, focus: { x: 70, y: 60 } });
    expect(layout.union).toEqual({ x: 0, y: 0, width: 150, height: 130 });
    expect(layout.intersection).toEqual({ x: 30, y: 30, width: 70, height: 50 });
    expectAligned(sources, layout);
    expectContained(layout);
  });

  it("reports how much of the frame each image leaves transparent", () => {
    const sources = [source(100, 100, 0, 0), source(100, 100, 50, 0)];
    const layout = computeLayout(sources, layer);
    expect(layout).toMatchObject({ width: 150, height: 100 });
    expect(layout.emptyFraction[0]).toBeCloseTo(1 / 3);
    expect(layout.emptyFraction[1]).toBeCloseTo(1 / 3);
  });

  it("pads to an aspect ratio and centres the content", () => {
    const layout = computeLayout([source(200, 100, 100, 50)], { ...layer, aspectRatio: 1 });
    expect(layout).toMatchObject({ width: 200, height: 200, focus: { x: 100, y: 100 } });
    expectContained(layout);
  });

  it("pins the focus to an anchor by padding", () => {
    const layout = computeLayout([source(100, 100, 50, 50)], { ...layer, anchor: { x: 0.25, y: 0.5 } });
    // Right needs 50 / 0.75 ≈ 66.7 → 67; left needs 50 / 0.25 = 200.
    expect(layout).toMatchObject({ width: 200, height: 100, focus: { x: 50, y: 50 } });
    expectContained(layout);
  });

  it("keeps anchors away from the edges so the frame stays finite", () => {
    const layout = computeLayout([source(100, 100, 50, 50)], { ...layer, anchor: { x: 0, y: 1 } });
    expect(Number.isFinite(layout.width)).toBe(true);
    expect(layout.width).toBe(Math.ceil(50 / LAYER_ANCHOR_MARGIN));
    expectContained(layout);
  });

  it("never needs to fail for disjoint images", () => {
    const sources = [source(100, 100, 0, 50), source(100, 100, 100, 50)];
    const layout = computeLayout(sources, layer);
    expect(layout.width).toBe(200);
    expectContained(layout);
  });
});

describe("outputScale", () => {
  it("never upscales", () => {
    expect(outputScale({ width: 300, height: 200 }, 1080)).toBe(1);
    expect(outputScale({ width: 300, height: 200 }, null)).toBe(1);
  });

  it("fits the longest edge", () => {
    expect(outputScale({ width: 4000, height: 3000 }, 1000)).toBe(0.25);
    expect(outputScale({ width: 3000, height: 4000 }, 1000)).toBe(0.25);
  });

  it("respects the WebP size limit", () => {
    expect(outputScale({ width: WEBP_MAX_DIMENSION * 2, height: 10 }, null)).toBe(0.5);
  });
});

describe("scaledSize", () => {
  it("rounds and keeps at least one pixel", () => {
    expect(scaledSize({ width: 1001, height: 3 }, 0.1)).toEqual({ width: 100, height: 1 });
  });
});
