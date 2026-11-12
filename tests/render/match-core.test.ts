import { describe, expect, it, vi } from "vitest";
import { MATCH_EDGE, matchChains, matchSize, toGray, type MatchImage, type PixelReader } from "../../src/render/match-core";

describe("matchSize", () => {
  it("scales every photo to the same longest edge", () => {
    expect(matchSize({ width: 4000, height: 3000 })).toEqual({ width: MATCH_EDGE, height: 768 });
    expect(matchSize({ width: 300, height: 600 })).toEqual({ width: 512, height: MATCH_EDGE });
    expect(matchSize({ width: 5000, height: 2 }, 100)).toEqual({ width: 100, height: 1 });
  });
});

/** Fake "images" are functions of (x, y) that the fake reader rasterises. */
type Pattern = (x: number, y: number) => number;
const imageOf = (pattern: Pattern, width: number, height: number): MatchImage => ({
  image: pattern as unknown as CanvasImageSource,
  width,
  height,
});
const reader: PixelReader = (image, width, height) => {
  const pattern = image as unknown as Pattern;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = pattern(x, y);
      data.set([value, value, value, 255], (y * width + x) * 4);
    }
  }
  return { data, width, height, colorSpace: "srgb" } as ImageData;
};

// A pseudo-random but smooth texture, so every spot is distinctive.
const texture: Pattern = (x, y) => 128 + 60 * Math.sin(x / 7 + Math.sin(y / 11) * 3) + 50 * Math.cos(y / 5 + Math.cos(x / 13) * 2);

describe("toGray", () => {
  it("reads pixels at the requested size", () => {
    const read = vi.fn(reader);
    const gray = toGray(imageOf(() => 200, 4, 3), read);
    expect(read).toHaveBeenCalledWith(expect.any(Function), 4, 3);
    expect(gray.width).toBe(4);
    expect(gray.data[0]).toBeCloseTo(200, 3);
  });
});

describe("matchChains", () => {
  it("matches the start point in each target and reports progress across chains", () => {
    const start = imageOf(texture, 320, 240);
    const shifted = imageOf((x, y) => texture(x + 12, y - 7), 320, 240);
    const progress = vi.fn();
    const [first, second] = matchChains(
      [start, shifted],
      [
        { start: 0, focus: { x: 160, y: 120 }, targets: [0] },
        { start: 0, focus: { x: 160, y: 120 }, targets: [1] },
      ],
      reader,
      progress,
    );
    expect(first![0]).toMatchObject({ ok: true, point: { x: expect.closeTo(160, 0) as number, y: expect.closeTo(120, 0) as number } });
    expect(second![0]).toMatchObject({ ok: true, point: { x: expect.closeTo(148, 0) as number, y: expect.closeTo(127, 0) as number } });
    expect(progress.mock.calls).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });

  // Smooth value noise: distinctive everywhere, and two seeds give unrelated scenes.
  const hash = (seed: number, i: number, j: number) => {
    let h = (i * 374761393 + j * 668265263 + seed * 2147483647) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const noise =
    (seed: number, cell = 6): Pattern =>
    (x, y) => {
      const i = Math.floor(x / cell);
      const j = Math.floor(y / cell);
      const fx = x / cell - i;
      const fy = y / cell - j;
      const top = hash(seed, i, j) * (1 - fx) + hash(seed, i + 1, j) * fx;
      const bottom = hash(seed, i, j + 1) * (1 - fx) + hash(seed, i + 1, j + 1) * fx;
      return 30 + 196 * (top * (1 - fy) + bottom * fy);
    };
  const before = noise(1);
  const after = noise(2);
  // Frame k shows the scene a further 5 px across and down, a quarter further from `before` towards `after`.
  const frame = (k: number) =>
    imageOf((x, y) => (1 - k / 4) * before(x + 5 * k, y + 5 * k) + (k / 4) * after(x + 5 * k, y + 5 * k), 320, 240);
  const expected = (k: number) => ({ x: expect.closeTo(160 - 5 * k, 0) as number, y: expect.closeTo(120 - 5 * k, 0) as number });

  it("matches each target against the previous one, following gradual changes", () => {
    const frames = [0, 1, 2, 3, 4].map(frame);
    const chained = matchChains(frames, [{ start: 0, focus: { x: 160, y: 120 }, targets: [1, 2, 3, 4] }], reader)[0]!;
    chained.forEach((outcome, i) => expect(outcome).toMatchObject({ ok: true, point: expected(i + 1) }));
    // Matched straight from the first frame, the last one has changed too much to find.
    const direct = matchChains(frames, [{ start: 0, focus: { x: 160, y: 120 }, targets: [4] }], reader)[0]![0]!;
    expect(direct.ok && direct.score).toBeLessThan(0.7);
  });

  it("skips over a target that doesn't match", () => {
    const frames = [frame(0), frame(1), imageOf(() => 90, 320, 240), frame(2)];
    const [first, flat, last] = matchChains(frames, [{ start: 0, focus: { x: 160, y: 120 }, targets: [1, 2, 3] }], reader)[0]!;
    expect(first).toMatchObject({ ok: true, point: expected(1) });
    expect(flat!.ok && flat!.score).toBeLessThan(0.7);
    expect(last).toMatchObject({ ok: true, point: expected(2) });
  });
});
