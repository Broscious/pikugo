import { describe, expect, it, vi } from "vitest";
import { MATCH_EDGE, matchAll, matchSize, toGray, type MatchImage, type PixelReader } from "../../src/render/match-core";

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

describe("matchAll", () => {
  it("matches the reference point in every target and reports progress", () => {
    const reference = imageOf(texture, 320, 240);
    const shifted = imageOf((x, y) => texture(x + 12, y - 7), 320, 240);
    const progress = vi.fn();
    const [same, moved] = matchAll(reference, { x: 160, y: 120 }, [reference, shifted], reader, progress);
    expect(same).toMatchObject({ ok: true, point: { x: expect.closeTo(160, 0) as number, y: expect.closeTo(120, 0) as number } });
    expect(moved).toMatchObject({ ok: true, point: { x: expect.closeTo(148, 0) as number, y: expect.closeTo(127, 0) as number } });
    expect(progress.mock.calls).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });
});
