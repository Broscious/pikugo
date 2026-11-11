import { describe, expect, it, vi } from "vitest";
import {
  drawFrame,
  encodeAnimation,
  EncoderUnsupportedError,
  renderStills,
  resultBuffers,
  runTask,
  type StillFormatPlan,
  type EncodePlan,
  type FrameSurface,
} from "../../src/render/encode-core";
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

const PNG: StillFormatPlan = { mimeType: "image/png", quality: 1, matte: null };
const JPEG: StillFormatPlan = { mimeType: "image/jpeg", quality: 0.8, matte: "#000000" };

describe("renderStills", () => {
  /** The fake surface tags each "encoded" image with the id of the image drawn last (first payload byte). */
  const drawnId = (bytes: Uint8Array) => bytes[20];

  it("renders one still per photo, in photo order, with the animation's placements", async () => {
    const { surface, calls, toBlob } = fakeSurface("image/png");
    const progress = vi.fn();
    const stills = await renderStills([image(5), image(6), image(7)], plan(), PNG, surface, progress);
    expect(stills.map(drawnId)).toEqual([5, 6, 7]);
    expect(toBlob).toHaveBeenCalledTimes(3);
    expect(toBlob).toHaveBeenCalledWith("image/png", 1);
    expect(calls).toContainEqual(["drawImage", image(6), -10, 5, 100, 80]);
    // Formats with alpha keep transparent areas transparent.
    expect(calls.some(([name]) => name === "fillRect")).toBe(false);
    expect(progress.mock.calls).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  it("flattens onto the matte behind the photo for formats without alpha", async () => {
    const { surface, calls, toBlob } = fakeSurface("image/jpeg");
    await renderStills([image(0)], plan({ placements: [plan().placements[0]!] }), JPEG, surface);
    expect(toBlob).toHaveBeenCalledWith("image/jpeg", 0.8);
    const names = calls.map(([name, value]) => (name.startsWith("set:") ? `${name}=${String(value)}` : name));
    const drawn = names.indexOf("drawImage");
    const behind = names.indexOf("set:globalCompositeOperation=destination-over");
    expect(drawn).toBeLessThan(behind);
    expect(names.slice(behind)).toEqual([
      "set:globalCompositeOperation=destination-over",
      "set:fillStyle=#000000",
      "fillRect",
      "set:globalCompositeOperation=source-over",
    ]);
    expect(calls).toContainEqual(["fillRect", 0, 0, 50, 40]);
  });

  it("ignores the playback sequence", async () => {
    const { surface } = fakeSurface("image/png");
    const stills = await renderStills([image(0), image(1), image(2)], plan({ sequence: [0, 1, 2, 2, 1, 0] }), PNG, surface);
    expect(stills).toHaveLength(3);
  });

  it("fails clearly when the browser can't produce the format", async () => {
    const webp: StillFormatPlan = { mimeType: "image/webp", quality: 0.8, matte: null };
    await expect(renderStills([image(0), image(1), image(2)], plan(), webp, fakeSurface("image/png").surface)).rejects.toThrow(
      "This browser can't export WEBP images from a canvas. Try PNG instead.",
    );
  });

  it("requires a placement per image", async () => {
    const { surface } = fakeSurface("image/png");
    await expect(renderStills([image(0)], plan(), PNG, surface)).rejects.toThrow(/placement/);
  });
});

describe("runTask", () => {
  it("dispatches stills and animation tasks and lists their buffers for transfer", async () => {
    const stills = await runTask([image(0), image(1), image(2)], { task: "stills", plan: plan(), format: PNG }, fakeSurface("image/png").surface);
    expect(stills.task).toBe("stills");
    expect(resultBuffers(stills)).toHaveLength(3);

    const animation = await runTask([image(0), image(1), image(2)], { task: "animation", plan: plan() }, fakeSurface().surface);
    expect(animation).toMatchObject({ task: "animation", frameCount: 3 });
    expect(resultBuffers(animation)).toHaveLength(1);
  });
});
