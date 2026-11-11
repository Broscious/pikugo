import { describe, expect, it } from "vitest";
import {
  buildAnimatedWebP,
  concatBytes,
  encodeChunk,
  extractFrame,
  inspectAnimation,
  readChunks,
  WebPFormatError,
  wrapRiff,
} from "../../src/core/webp";

/** A fake still WebP: the bitstream is not decodable, but the container is valid. */
function stillWebP(chunks: [string, number[]][]): Uint8Array {
  return wrapRiff(chunks.map(([type, data]) => encodeChunk(type, Uint8Array.from(data))));
}

describe("encodeChunk", () => {
  it("writes FourCC, little-endian size and pads odd payloads", () => {
    const chunk = encodeChunk("TEST", Uint8Array.from([1, 2, 3]));
    expect(Array.from(chunk)).toEqual([84, 69, 83, 84, 3, 0, 0, 0, 1, 2, 3, 0]);
  });

  it("does not pad even payloads", () => {
    expect(encodeChunk("TEST", new Uint8Array(4)).length).toBe(12);
  });

  it("rejects malformed FourCCs", () => {
    expect(() => encodeChunk("BAD", new Uint8Array())).toThrow(WebPFormatError);
  });
});

describe("wrapRiff / readChunks", () => {
  it("round-trips chunks", () => {
    const file = stillWebP([
      ["VP8 ", [1, 2, 3]],
      ["EXIF", [9, 9]],
    ]);
    expect(new TextDecoder().decode(file.subarray(0, 4))).toBe("RIFF");
    expect(new DataView(file.buffer).getUint32(4, true)).toBe(file.length - 8);
    const chunks = readChunks(file);
    expect(chunks.map((c) => c.type)).toEqual(["VP8 ", "EXIF"]);
    expect(Array.from(chunks[0]!.data)).toEqual([1, 2, 3]);
  });

  it("rejects non-WebP data", () => {
    expect(() => readChunks(new TextEncoder().encode("GIF89a........"))).toThrow(WebPFormatError);
  });

  it("detects truncated chunks", () => {
    const file = stillWebP([["VP8 ", [1, 2, 3, 4]]]);
    expect(() => readChunks(file.subarray(0, file.length - 2))).toThrow(/Truncated/);
  });

  it("works on views with a byte offset", () => {
    const file = stillWebP([["VP8L", [0x2f, 0, 0, 0, 0]]]);
    const padded = new Uint8Array(file.length + 7);
    padded.set(file, 7);
    expect(readChunks(padded.subarray(7)).map((c) => c.type)).toEqual(["VP8L"]);
  });
});

describe("extractFrame", () => {
  it("keeps only bitstream chunks", () => {
    const frame = extractFrame(
      stillWebP([
        ["VP8X", [0x10, 0, 0, 0, 0, 0, 0, 0, 0, 0]],
        ["ALPH", [7]],
        ["VP8 ", [1, 2]],
        ["EXIF", [3]],
      ]),
    );
    const inner = readChunks(wrapRiff([frame.bitstream]));
    expect(inner.map((c) => c.type)).toEqual(["ALPH", "VP8 "]);
    expect(frame.hasAlpha).toBe(true);
  });

  it("reports opaque lossy frames", () => {
    expect(extractFrame(stillWebP([["VP8 ", [1, 2]]])).hasAlpha).toBe(false);
  });

  it("reads the alpha hint from lossless frames", () => {
    expect(extractFrame(stillWebP([["VP8L", [0x2f, 0, 0, 0, 0x10]]])).hasAlpha).toBe(true);
    expect(extractFrame(stillWebP([["VP8L", [0x2f, 0, 0, 0, 0x00]]])).hasAlpha).toBe(false);
  });

  it("fails without image data", () => {
    expect(() => extractFrame(stillWebP([["ALPH", [1]]]))).toThrow(/no image data/);
  });
});

describe("buildAnimatedWebP", () => {
  const opaque = extractFrame(stillWebP([["VP8 ", [1, 2, 3]]]));
  const transparent = extractFrame(stillWebP([["ALPH", [1]], ["VP8 ", [4, 5]]]));

  it("writes canvas size, loop count and per-frame timing", () => {
    const bytes = buildAnimatedWebP([opaque, opaque], { width: 640, height: 360, sequence: [0, 1], frameDelay: 100 });
    const info = inspectAnimation(bytes);
    expect(info).toMatchObject({ width: 640, height: 360, loopCount: 0, hasAlpha: false });
    expect(info.frames).toHaveLength(2);
    for (const frame of info.frames) {
      expect(frame).toMatchObject({ width: 640, height: 360, duration: 100, blend: false, chunkTypes: ["VP8 "] });
    }
  });

  it("stores durations longer than 16 bits", () => {
    const bytes = buildAnimatedWebP([opaque], { width: 1, height: 1, sequence: [0, 0], frameDelay: 70_000 });
    expect(inspectAnimation(bytes).frames[0]!.duration).toBe(70_000);
  });

  it("repeats frames following the sequence", () => {
    const bytes = buildAnimatedWebP([opaque, transparent, opaque], {
      width: 10,
      height: 10,
      sequence: [0, 1, 2, 1],
      frameDelay: 50,
    });
    const info = inspectAnimation(bytes);
    expect(info.frames.map((f) => f.chunkTypes.join("+"))).toEqual(["VP8 ", "ALPH+VP8 ", "VP8 ", "ALPH+VP8 "]);
  });

  it("sets the alpha flag when any frame is transparent", () => {
    const bytes = buildAnimatedWebP([opaque, transparent], { width: 2, height: 2, sequence: [0, 1], frameDelay: 100 });
    expect(inspectAnimation(bytes).hasAlpha).toBe(true);
  });

  it("writes loop count and background colour", () => {
    const bytes = buildAnimatedWebP([opaque], {
      width: 2,
      height: 2,
      sequence: [0],
      frameDelay: 100,
      loopCount: 3,
      backgroundColor: [255, 128, 0, 255],
    });
    const anim = readChunks(bytes).find((c) => c.type === "ANIM")!;
    expect(Array.from(anim.data)).toEqual([0, 128, 255, 255, 3, 0]);
  });

  it("keeps the RIFF size consistent", () => {
    const bytes = buildAnimatedWebP([opaque], { width: 3, height: 3, sequence: [0, 0, 0], frameDelay: 10 });
    expect(new DataView(bytes.buffer).getUint32(4, true)).toBe(bytes.length - 8);
    expect(bytes.length % 2).toBe(0);
  });

  it("validates its input", () => {
    const base = { width: 2, height: 2, sequence: [0], frameDelay: 100 };
    expect(() => buildAnimatedWebP([opaque], { ...base, width: 0 })).toThrow(WebPFormatError);
    expect(() => buildAnimatedWebP([opaque], { ...base, height: 1.5 })).toThrow(WebPFormatError);
    expect(() => buildAnimatedWebP([opaque], { ...base, sequence: [] })).toThrow(WebPFormatError);
    expect(() => buildAnimatedWebP([opaque], { ...base, sequence: [1] })).toThrow(/missing frame/);
    expect(() => buildAnimatedWebP([opaque], { ...base, frameDelay: -1 })).toThrow(WebPFormatError);
    expect(() => buildAnimatedWebP([opaque], { ...base, loopCount: 70_000 })).toThrow(WebPFormatError);
  });
});

describe("concatBytes", () => {
  it("joins arrays in order", () => {
    expect(Array.from(concatBytes([Uint8Array.of(1), Uint8Array.of(), Uint8Array.of(2, 3)]))).toEqual([1, 2, 3]);
  });
});

describe("inspectAnimation", () => {
  it("rejects still images", () => {
    expect(() => inspectAnimation(stillWebP([["VP8 ", [1]]]))).toThrow(/Not an animated/);
  });
});
