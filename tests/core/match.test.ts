import { describe, expect, it } from "vitest";
import {
  distinctness,
  downsample,
  grayFromRgba,
  isConfident,
  matchPoint,
  MIN_MATCH_SCORE,
  parabolicPeak,
  type GrayImage,
  type MatchOutcome,
} from "../../src/core/match";

/** Deterministic pseudo-random numbers (mulberry32). */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A "world" full of overlapping shapes, like a cluttered photo. */
function scene(width: number, height: number, seed = 1): GrayImage {
  const next = random(seed);
  const data = new Float32Array(width * height);
  for (let i = 0; i < data.length; i += 1) {
    data[i] = 100 + 40 * Math.sin((i % width) / 37) * Math.cos(Math.floor(i / width) / 29);
  }
  for (let n = 0; n < 400; n += 1) {
    const w = 4 + next() * 40;
    const h = 4 + next() * 40;
    const x0 = next() * width - w / 2;
    const y0 = next() * height - h / 2;
    const value = next() * 255;
    const round = next() < 0.5;
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(height, y0 + h); y += 1) {
      for (let x = Math.max(0, Math.floor(x0)); x < Math.min(width, x0 + w); x += 1) {
        const inside = !round || ((x - x0 - w / 2) / (w / 2)) ** 2 + ((y - y0 - h / 2) / (h / 2)) ** 2 <= 1;
        if (inside) {
          data[y * width + x] = value;
        }
      }
    }
  }
  return { width, height, data };
}

/** Bilinear sample of a window of `world` starting at a (possibly fractional) offset. */
function crop(world: GrayImage, left: number, top: number, width: number, height: number, transform = (v: number) => v): GrayImage {
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sx = x + left;
      const sy = y + top;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      const at = (px: number, py: number) => world.data[Math.min(world.height - 1, py) * world.width + Math.min(world.width - 1, px)]!;
      const value =
        at(x0, y0) * (1 - fx) * (1 - fy) + at(x0 + 1, y0) * fx * (1 - fy) + at(x0, y0 + 1) * (1 - fx) * fy + at(x0 + 1, y0 + 1) * fx * fy;
      data[y * width + x] = transform(value);
    }
  }
  return { width, height, data };
}

function blur(image: GrayImage, passes = 2): GrayImage {
  let current = image;
  for (let pass = 0; pass < passes; pass += 1) {
    const data = new Float32Array(current.data.length);
    for (let y = 0; y < current.height; y += 1) {
      for (let x = 0; x < current.width; x += 1) {
        let total = 0;
        let count = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const px = x + dx;
            const py = y + dy;
            if (px >= 0 && py >= 0 && px < current.width && py < current.height) {
              total += current.data[py * current.width + px]!;
              count += 1;
            }
          }
        }
        data[y * current.width + x] = total / count;
      }
    }
    current = { ...current, data };
  }
  return current;
}

function expectMatch(outcome: MatchOutcome, expected: { x: number; y: number }, tolerance: number) {
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) {
    return;
  }
  expect(Math.abs(outcome.point.x - expected.x)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(outcome.point.y - expected.y)).toBeLessThanOrEqual(tolerance);
}

const world = scene(720, 560);
const reference = crop(world, 60, 50, 600, 450);

describe("grayFromRgba", () => {
  it("converts RGBA to luminance and ignores alpha", () => {
    const gray = grayFromRgba(Uint8ClampedArray.of(255, 0, 0, 255, 0, 255, 0, 0, 0, 0, 255, 128, 255, 255, 255, 255), 2, 2);
    expect([...gray.data].map((v) => Math.round(v * 1000) / 1000)).toEqual([76.245, 149.685, 29.07, 255]);
  });

  it("rejects bad dimensions and short buffers", () => {
    expect(() => grayFromRgba(new Uint8Array(4), 0, 1)).toThrow(RangeError);
    expect(() => grayFromRgba(new Uint8Array(4), 1.5, 1)).toThrow(RangeError);
    expect(() => grayFromRgba(new Uint8Array(4), 2, 1)).toThrow(/pixel data/);
  });
});

describe("downsample", () => {
  it("averages 2×2 blocks", () => {
    const half = downsample({ width: 4, height: 2, data: Float32Array.of(0, 4, 8, 8, 4, 8, 0, 0) });
    expect(half).toEqual({ width: 2, height: 1, data: Float32Array.of(4, 4) });
  });

  it("reuses edge pixels for odd and tiny sizes", () => {
    expect(downsample({ width: 3, height: 3, data: Float32Array.of(1, 1, 9, 1, 1, 9, 5, 5, 5) })).toEqual({
      width: 1,
      height: 1,
      data: Float32Array.of(1),
    });
    expect(downsample({ width: 1, height: 1, data: Float32Array.of(7) })).toEqual({ width: 1, height: 1, data: Float32Array.of(7) });
  });
});

describe("parabolicPeak", () => {
  it("finds the vertex between samples", () => {
    expect(parabolicPeak(0.8, 1, 0.8)).toBe(0);
    expect(parabolicPeak(0.5, 1, 0.9)).toBeGreaterThan(0);
    expect(parabolicPeak(0.9, 1, 0.5)).toBeLessThan(0);
  });

  it("ignores flat, valley-shaped or missing neighbours and clamps the offset", () => {
    expect(parabolicPeak(1, 1, 1)).toBe(0);
    expect(parabolicPeak(1, 0, 1)).toBe(0);
    expect(parabolicPeak(Number.NaN, 1, 0.5)).toBe(0);
    expect(parabolicPeak(2, 1, -1)).toBe(-0.5);
    expect(parabolicPeak(-1, 1, 2)).toBe(0.5);
  });
});

describe("matchPoint", () => {
  const point = { x: 300, y: 220 };

  it("finds a shifted point to within a pixel", () => {
    const target = crop(world, 60 + 37, 50 - 21, 600, 450);
    const outcome = matchPoint(reference, point, target);
    expectMatch(outcome, { x: point.x - 37, y: point.y + 21 }, 0.5);
    expect(isConfident(outcome)).toBe(true);
    expect(outcome.ok && outcome.score).toBeGreaterThan(0.95);
  });

  it("estimates sub-pixel shifts", () => {
    const smooth = blur(world);
    const target = crop(smooth, 60 + 12.4, 50 + 5.7, 600, 450);
    const outcome = matchPoint(crop(smooth, 60, 50, 600, 450), point, target);
    expectMatch(outcome, { x: point.x - 12.4, y: point.y - 5.7 }, 0.3);
  });

  it("ignores brightness and contrast differences and copes with noise", () => {
    const next = random(9);
    const target = crop(world, 60 - 15, 50 + 30, 600, 450, (v) => 0.6 * v + 40 + (next() - 0.5) * 30);
    const outcome = matchPoint(reference, point, target);
    expectMatch(outcome, { x: point.x + 15, y: point.y - 30 }, 1);
    expect(isConfident(outcome)).toBe(true);
  });

  it("handles points near the edges, where the patch can't be centred", () => {
    const target = crop(world, 60 + 20, 50 + 10, 600, 450);
    expectMatch(matchPoint(reference, { x: 590, y: 445 }, target), { x: 570, y: 435 }, 1);
    // Points outside the image are clamped to its edge.
    expectMatch(matchPoint(reference, { x: -50, y: 9999 }, crop(world, 60, 50, 600, 450)), { x: 0, y: 450 }, 1);
  });

  it("matches targets of a different size", () => {
    const target = crop(world, 0, 0, 720, 560);
    expectMatch(matchPoint(reference, point, target), { x: point.x + 60, y: point.y + 50 }, 0.5);
  });

  it("reports featureless patches instead of guessing", () => {
    const flat = { width: 200, height: 150, data: new Float32Array(200 * 150).fill(128) };
    expect(matchPoint(flat, { x: 100, y: 75 }, reference)).toEqual({ ok: false, reason: "featureless" });
  });

  it("reports images too small to hold a patch", () => {
    const tiny = { width: 5, height: 5, data: new Float32Array(25) };
    expect(matchPoint(reference, point, tiny)).toEqual({ ok: false, reason: "too-small" });
    expect(matchPoint(tiny, { x: 2, y: 2 }, reference)).toEqual({ ok: false, reason: "too-small" });
  });

  it("is not confident when nothing in the target resembles the patch", () => {
    // Cluttered scenes can score well by chance, but never stand out from the runner-up.
    for (const seed of [2, 3, 5, 10, 42]) {
      const unrelated = crop(scene(720, 560, seed), 0, 0, 600, 450);
      for (const at of [point, { x: 100, y: 100 }, { x: 500, y: 380 }]) {
        expect(isConfident(matchPoint(reference, at, unrelated))).toBe(false);
      }
    }
  });

  it("stays confident for true matches in heavy noise", () => {
    const next = random(3);
    const noisy = crop(world, 60 + 25, 50 + 8, 600, 450, (v) => v + (next() - 0.5) * 60);
    for (const at of [point, { x: 100, y: 100 }, { x: 500, y: 380 }]) {
      const outcome = matchPoint(reference, at, noisy);
      expectMatch(outcome, { x: at.x - 25, y: at.y - 8 }, 1);
      expect(isConfident(outcome)).toBe(true);
    }
  });

  it("is not confident when the patch repeats across the target", () => {
    // A regular grid of identical dots: every dot matches equally well.
    const width = 400;
    const height = 300;
    const data = new Float32Array(width * height).fill(30);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (((x % 50) - 25) ** 2 + ((y % 50) - 25) ** 2 < 100) {
          data[y * width + x] = 220;
        }
      }
    }
    const grid = { width, height, data };
    const outcome = matchPoint(grid, { x: 175, y: 125 }, grid);
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.runnerUp).toBeGreaterThan(0.9);
    expect(isConfident(outcome)).toBe(false);
  });

  it("treats failures and weak scores as not confident", () => {
    expect(isConfident({ ok: false, reason: "featureless" })).toBe(false);
    expect(isConfident({ ok: true, point: { x: 0, y: 0 }, score: MIN_MATCH_SCORE - 0.01, runnerUp: 0 })).toBe(false);
    expect(isConfident({ ok: true, point: { x: 0, y: 0 }, score: 0.9, runnerUp: 0.85 })).toBe(false);
    expect(isConfident({ ok: true, point: { x: 0, y: 0 }, score: 0.9, runnerUp: 0.7 })).toBe(true);
  });

  it("measures distinctness against a perfect score", () => {
    expect(distinctness(0.9, 0.8)).toBeCloseTo(2);
    expect(distinctness(0.9, -0.5)).toBeCloseTo(10);
    expect(distinctness(1, 0.99)).toBe(Number.POSITIVE_INFINITY);
  });

  it("can stop at full resolution when the patch is already small", () => {
    const target = crop(world, 60 + 3, 50 + 4, 600, 450);
    expectMatch(matchPoint(reference, point, target, { maxRadius: 6, coarseRadius: 6 }), { x: point.x - 3, y: point.y - 4 }, 0.5);
  });
});

