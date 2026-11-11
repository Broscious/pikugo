import { describe, expect, it, vi } from "vitest";
import { drawFrame, encodeAnimation, EncoderUnsupportedError, type EncodePlan, type FrameSurface } from "../../src/render/encode-core";
import { encodeChunk, inspectAnimation, wrapRiff } from "../../src/core/webp";

type Call = [string, ...unknown[]];

/** Records 2D-context calls and "encodes" a fake WebP tagged with the last image drawn. */
function fakeSurface(type = "image/webp") {
  const calls: Call[] = [];
  let lastImage = -1;
  const context = new Proxy(
    {},
    {
      get(_target, prop: string) {
        return (...args: unknown[]) => {
          calls.push([prop, ...args]);
          if (prop === "drawImage") {
            lastImage = (args[0] as { id: number }).id;
          }
        };
      },
      set(_target, prop: string, value: unknown) {
        calls.push([`set:${prop}`, value]);
        return true;
      },
    },
  ) as unknown as CanvasRenderingContext2D;
  const toBlob = vi.fn(async () => {
    const still = wrapRiff([encodeChunk("VP8 ", Uint8Array.of(lastImage))]);
    return new Blob([still], { type });
  });
  const surface: FrameSurface = { context, toBlob };
  return { surface, calls, toBlob };
}

const image = (id: number) => ({ id }) as unknown as CanvasImageSource;

function plan(overrides: Partial<EncodePlan> = {}): EncodePlan {
  return {
    output: { width: 50, height: 40 },
    scale: 0.5,
    placements: [
      { x: 0, y: 0, width: 100, height: 80 },
      { x: -10, y: 5, width: 100, height: 80 },
      { x: -20, y: 0, width: 100, height: 80 },
    ],
    sequence: [0, 1, 2],
    frameDelay: 100,
    quality: 0.8,
    ...overrides,
  };
}

describe("drawFrame", () => {
  it("clears the frame then draws the image scaled at its placement", () => {
    const { surface, calls } = fakeSurface();
    drawFrame(surface.context, image(7), { x: -10, y: 5, width: 100, height: 80 }, { width: 50, height: 40 }, 0.5);
    const names = calls.map((c) => c[0]);
    expect(names.indexOf("clearRect")).toBeLessThan(names.indexOf("drawImage"));
    expect(calls).toContainEqual(["clearRect", 0, 0, 50, 40]);
    expect(calls).toContainEqual(["setTransform", 0.5, 0, 0, 0.5, 0, 0]);
    expect(calls).toContainEqual(["drawImage", image(7), -10, 5, 100, 80]);
    expect(calls.at(-1)).toEqual(["setTransform", 1, 0, 0, 1, 0, 0]);
  });
});

describe("encodeAnimation", () => {
  it("encodes each image once and muxes the sequence", async () => {
    const { surface, toBlob } = fakeSurface();
    const progress = vi.fn();
    const result = await encodeAnimation([image(0), image(1), image(2)], plan({ sequence: [0, 1, 2, 1] }), surface, progress);
    expect(toBlob).toHaveBeenCalledTimes(3);
    expect(toBlob).toHaveBeenCalledWith("image/webp", 0.8);
    expect(progress.mock.calls).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
    expect(result.frameCount).toBe(4);
    const info = inspectAnimation(result.bytes);
    expect(info).toMatchObject({ width: 50, height: 40 });
    expect(info.frames.map((f) => f.duration)).toEqual([100, 100, 100, 100]);
  });

  it("returns a still WebP for a single frame", async () => {
    const { surface } = fakeSurface();
    const result = await encodeAnimation([image(4)], plan({ placements: [plan().placements[0]!], sequence: [0] }), surface);
    expect(result.frameCount).toBe(1);
    expect(() => inspectAnimation(result.bytes)).toThrow();
  });

  it("detects browsers that silently fall back to PNG", async () => {
    const { surface } = fakeSurface("image/png");
    await expect(encodeAnimation([image(0), image(1), image(2)], plan(), surface)).rejects.toBeInstanceOf(EncoderUnsupportedError);
  });

  it("requires a placement per image", async () => {
    const { surface } = fakeSurface();
    await expect(encodeAnimation([image(0)], plan(), surface)).rejects.toThrow(/placement/);
  });
});
