import { describe, expect, it } from "vitest";
import { buildGif, GifFormatError, lzwEncode, MIN_GIF_DELAY_CS, type GifFrame } from "../../src/core/gif";

/** LZW-decode GIF image data (sub-blocks already joined). */
function lzwDecode(data: Uint8Array, minCodeSize: number): number[] {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let table: number[][] = [];
  const reset = () => {
    table = Array.from({ length: endCode + 1 }, (_, i) => (i < clearCode ? [i] : []));
    codeSize = minCodeSize + 1;
  };
  reset();
  const out: number[] = [];
  let previous: number[] | null = null;
  let bit = 0;
  while (bit + codeSize <= data.length * 8) {
    let code = 0;
    for (let i = 0; i < codeSize; i += 1, bit += 1) {
      code |= ((data[bit >> 3]! >> (bit & 7)) & 1) << i;
    }
    if (code === clearCode) {
      reset();
      previous = null;
      continue;
    }
    if (code === endCode) {
      break;
    }
    let entry: number[];
    if (previous === null) {
      entry = table[code]!;
    } else {
      entry = code < table.length ? table[code]! : [...previous, previous[0]!];
      table.push([...previous, entry[0]!]);
    }
    out.push(...entry);
    previous = entry;
    if (table.length === 1 << codeSize && codeSize < 12) {
      codeSize += 1;
    }
  }
  return out;
}

/** Join an image's sub-blocks, starting just after the LZW minimum code size byte. */
function readSubBlocks(bytes: Uint8Array, start: number): { data: Uint8Array; end: number } {
  const parts: number[] = [];
  let p = start;
  while (bytes[p] !== 0) {
    const size = bytes[p]!;
    parts.push(...bytes.subarray(p + 1, p + 1 + size));
    p += size + 1;
  }
  return { data: Uint8Array.from(parts), end: p + 1 };
}

interface DecodedFrame {
  delay: number;
  disposal: number;
  transparent: number | null;
  indices: number[];
}

function decodeGif(bytes: Uint8Array) {
  const ascii = (from: number, length: number) => String.fromCharCode(...bytes.subarray(from, from + length));
  const u16 = (at: number) => bytes[at]! | (bytes[at + 1]! << 8);
  expect(ascii(0, 6)).toBe("GIF89a");
  const width = u16(6);
  const height = u16(8);
  const packed = bytes[10]!;
  expect(packed & 0x80).toBe(0x80);
  const tableSize = 1 << ((packed & 7) + 1);
  const palette: [number, number, number][] = [];
  for (let i = 0; i < tableSize; i += 1) {
    palette.push([bytes[13 + i * 3]!, bytes[14 + i * 3]!, bytes[15 + i * 3]!]);
  }
  let p = 13 + tableSize * 3;
  let loopCount: number | null = null;
  const frames: DecodedFrame[] = [];
  let control = { delay: 0, disposal: 0, transparent: null as number | null };
  while (bytes[p] !== 0x3b) {
    if (bytes[p] === 0x21 && bytes[p + 1] === 0xf9) {
      const flags = bytes[p + 3]!;
      control = { delay: u16(p + 4), disposal: (flags >> 2) & 7, transparent: flags & 1 ? bytes[p + 6]! : null };
      p += 8;
    } else if (bytes[p] === 0x21 && bytes[p + 1] === 0xff) {
      expect(ascii(p + 3, 11)).toBe("NETSCAPE2.0");
      loopCount = u16(p + 16);
      p += 19;
    } else if (bytes[p] === 0x2c) {
      expect([u16(p + 1), u16(p + 3), u16(p + 5), u16(p + 7), bytes[p + 9]]).toEqual([0, 0, width, height, 0]);
      const minCodeSize = bytes[p + 10]!;
      const { data, end } = readSubBlocks(bytes, p + 11);
      frames.push({ ...control, indices: lzwDecode(data, minCodeSize) });
      p = end;
    } else {
      throw new Error(`Unexpected block 0x${bytes[p]!.toString(16)} at ${p}`);
    }
  }
  expect(p).toBe(bytes.length - 1);
  return { width, height, palette, loopCount, frames, background: bytes[11]! };
}

function solid(width: number, height: number, rgba: [number, number, number, number]): GifFrame {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels.set(rgba, i);
  }
  return { pixels };
}

describe("lzwEncode", () => {
  const roundTrip = (indices: Uint8Array, minCodeSize: number) => {
    const encoded = lzwEncode(indices, minCodeSize);
    expect(encoded[0]).toBe(minCodeSize);
    const { data, end } = readSubBlocks(encoded, 1);
    expect(end).toBe(encoded.length);
    return lzwDecode(data, minCodeSize);
  };

  it("round-trips small palettes", () => {
    const indices = Uint8Array.from({ length: 500 }, (_, i) => (i * 7 + (i >> 3)) % 4);
    expect(roundTrip(indices, 2)).toEqual([...indices]);
  });

  it("round-trips long, varied data that fills and resets the code table", () => {
    let seed = 1;
    const indices = Uint8Array.from({ length: 60_000 }, () => {
      seed = (seed * 16807) % 2147483647;
      return seed % 200;
    });
    expect(roundTrip(indices, 8)).toEqual([...indices]);
  });

  it("round-trips repetitive data", () => {
    const indices = new Uint8Array(20_000).fill(3);
    expect(roundTrip(indices, 8)).toEqual([...indices]);
  });

  it("splits data into sub-blocks of at most 255 bytes", () => {
    let seed = 7;
    const encoded = lzwEncode(
      Uint8Array.from({ length: 5_000 }, () => {
        seed = (seed * 16807) % 2147483647;
        return seed % 256;
      }),
      8,
    );
    for (let p = 1; encoded[p] !== 0; p += encoded[p]! + 1) {
      expect(encoded[p]).toBeLessThanOrEqual(255);
    }
  });
});

describe("buildGif", () => {
  const red = solid(4, 3, [255, 0, 0, 255]);
  const blue = solid(4, 3, [0, 0, 255, 255]);

  it("writes a looping animation following the sequence", () => {
    const gif = decodeGif(buildGif([red, blue], { width: 4, height: 3, sequence: [0, 1, 0], frameDelay: 100 }));
    expect(gif).toMatchObject({ width: 4, height: 3, loopCount: 0 });
    expect(gif.frames.map((frame) => frame.delay)).toEqual([10, 10, 10]);
    const colours = gif.frames.map((frame) => gif.palette[frame.indices[0]!]);
    expect(colours).toEqual([
      [255, 0, 0],
      [0, 0, 255],
      [255, 0, 0],
    ]);
    for (const frame of gif.frames) {
      expect(frame.indices).toHaveLength(12);
      expect(new Set(frame.indices).size).toBe(1);
      expect(frame).toMatchObject({ transparent: null, disposal: 1 });
    }
  });

  it("merges a frame repeated back to back into one longer frame", () => {
    const gif = decodeGif(buildGif([red, blue], { width: 4, height: 3, sequence: [0, 1, 1, 0], frameDelay: 100 }));
    expect(gif.frames.map((frame) => frame.delay)).toEqual([10, 20, 10]);
  });

  it("rounds delays to centiseconds without drifting from the total", () => {
    const gif = decodeGif(buildGif([red, blue, red], { width: 4, height: 3, sequence: [0, 1, 2, 1], frameDelay: 25 }));
    const delays = gif.frames.map((frame) => frame.delay);
    expect(delays.reduce((sum, delay) => sum + delay, 0)).toBe(10);
    expect(Math.min(...delays)).toBeGreaterThanOrEqual(MIN_GIF_DELAY_CS);
  });

  it("makes see-through pixels transparent and replaces each frame in full", () => {
    const holey = solid(4, 3, [0, 200, 0, 255]);
    holey.pixels.set([0, 0, 0, 0], 0);
    const gif = decodeGif(buildGif([holey, red], { width: 4, height: 3, sequence: [0, 1], frameDelay: 100 }));
    const [first, second] = gif.frames;
    expect(first!.transparent).not.toBeNull();
    expect(first!.indices[0]).toBe(first!.transparent);
    expect(first!.indices[1]).not.toBe(first!.transparent);
    expect(gif.palette[first!.indices[1]!]).toEqual([0, 200, 0]);
    expect(first!.disposal).toBe(2);
    expect(second!.transparent).toBe(first!.transparent);
  });

  it("writes a single frame without a loop extension", () => {
    const gif = decodeGif(buildGif([red], { width: 4, height: 3, sequence: [0], frameDelay: 100 }));
    expect(gif.loopCount).toBeNull();
    expect(gif.frames).toHaveLength(1);
  });

  it("reduces many colours to a 256-colour palette that stays close to the original", () => {
    const width = 64;
    const height = 64;
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        pixels.set([x * 4, y * 4, (x + y) * 2, 255], (y * width + x) * 4);
      }
    }
    for (const dither of [true, false]) {
      const gif = decodeGif(buildGif([{ pixels }], { width, height, sequence: [0], frameDelay: 100, dither }));
      expect(gif.palette).toHaveLength(256);
      let error = 0;
      gif.frames[0]!.indices.forEach((index, p) => {
        const [r, g, b] = gif.palette[index]!;
        error += Math.abs(r - pixels[p * 4]!) + Math.abs(g - pixels[p * 4 + 1]!) + Math.abs(b - pixels[p * 4 + 2]!);
      });
      // Average error per channel stays small.
      expect(error / (width * height * 3)).toBeLessThan(dither ? 10 : 6);
    }
  });

  it("rejects bad input", () => {
    expect(() => buildGif([red], { width: 4, height: 3, sequence: [], frameDelay: 100 })).toThrow(GifFormatError);
    expect(() => buildGif([red], { width: 4, height: 3, sequence: [1], frameDelay: 100 })).toThrow(/missing frame/);
    expect(() => buildGif([red], { width: 5, height: 3, sequence: [0], frameDelay: 100 })).toThrow(/wrong number of pixels/);
    expect(() => buildGif([red], { width: 70_000, height: 3, sequence: [0], frameDelay: 100 })).toThrow(/can't exceed/);
  });
});
