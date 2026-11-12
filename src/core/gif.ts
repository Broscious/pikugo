/**
 * Animated GIF (GIF89a) encoder.
 *
 * GIF stores at most 256 colours per frame, so the frames are reduced to one
 * shared palette (median cut over a colour histogram of every frame). Sharing
 * a palette keeps colours from flickering between frames. Pixels are mapped to
 * it with ordered (Bayer) dithering, which, unlike error diffusion, gives the
 * same pattern on every frame, so still areas don't shimmer as it plays.
 * Pixels less than half opaque become transparent.
 *
 * Spec: https://www.w3.org/Graphics/GIF/spec-gif89a.txt
 */

export interface GifFrame {
  /** RGBA pixels, row by row (as from `getImageData`). */
  pixels: Uint8Array | Uint8ClampedArray;
}

export interface GifParams {
  width: number;
  height: number;
  /** Indices into the frames, in display order. Frames can repeat. */
  sequence: readonly number[];
  /** Display time of each frame, in milliseconds. */
  frameDelay: number;
  /** 0 loops forever. */
  loopCount?: number;
  /** Ordered dithering (on by default) smooths gradients that 256 colours would band. */
  dither?: boolean;
}

export class GifFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GifFormatError";
  }
}

export const MAX_GIF_DIMENSION = 0xffff;
/** Pixels with lower alpha than this become transparent. */
export const GIF_ALPHA_THRESHOLD = 128;
/** Browsers show shorter GIF delays as 100 ms, so 20 ms is the shortest that plays as written. */
export const MIN_GIF_DELAY_CS = 2;

const MAX_CODES = 4096;
const DITHER_STRENGTH = 24;
// 4×4 Bayer threshold matrix.
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/** A growable byte buffer. */
class ByteWriter {
  #bytes = new Uint8Array(1 << 16);
  #length = 0;

  #reserve(extra: number): void {
    if (this.#length + extra > this.#bytes.length) {
      let size = this.#bytes.length * 2;
      while (size < this.#length + extra) {
        size *= 2;
      }
      const grown = new Uint8Array(size);
      grown.set(this.#bytes.subarray(0, this.#length));
      this.#bytes = grown;
    }
  }

  byte(value: number): void {
    this.#reserve(1);
    this.#bytes[this.#length++] = value & 0xff;
  }

  uint16(value: number): void {
    this.byte(value);
    this.byte(value >> 8);
  }

  ascii(text: string): void {
    for (let i = 0; i < text.length; i += 1) {
      this.byte(text.charCodeAt(i));
    }
  }

  bytes(data: Uint8Array): void {
    this.#reserve(data.length);
    this.#bytes.set(data, this.#length);
    this.#length += data.length;
  }

  result(): Uint8Array<ArrayBuffer> {
    return this.#bytes.slice(0, this.#length);
  }
}

type Rgb = [number, number, number];

/** Colour histogram over 5 bits per channel, with exact sums for averaging. */
interface Histogram {
  counts: Float64Array;
  sums: Float64Array;
}

const binOf = (r: number, g: number, b: number) => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);

function histogram(frames: readonly GifFrame[]): Histogram {
  const counts = new Float64Array(1 << 15);
  const sums = new Float64Array(3 << 15);
  for (const { pixels } of frames) {
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3]! < GIF_ALPHA_THRESHOLD) {
        continue;
      }
      const r = pixels[i]!;
      const g = pixels[i + 1]!;
      const b = pixels[i + 2]!;
      const bin = binOf(r, g, b);
      counts[bin]! += 1;
      sums[bin * 3]! += r;
      sums[bin * 3 + 1]! += g;
      sums[bin * 3 + 2]! += b;
    }
  }
  return { counts, sums };
}

/** Reduce a histogram to at most `maxColors` colours by median cut. */
export function medianCut({ counts, sums }: Histogram, maxColors: number): Rgb[] {
  const bins: number[] = [];
  for (let bin = 0; bin < counts.length; bin += 1) {
    if (counts[bin]! > 0) {
      bins.push(bin);
    }
  }
  if (bins.length === 0) {
    return [[0, 0, 0]];
  }
  const channel = (bin: number, c: number) => (bin >> (10 - c * 5)) & 31;
  const rangeOf = (box: number[]) => {
    let best = { channel: 0, range: -1 };
    for (let c = 0; c < 3; c += 1) {
      let low = 31;
      let high = 0;
      for (const bin of box) {
        const value = channel(bin, c);
        low = Math.min(low, value);
        high = Math.max(high, value);
      }
      if (high - low > best.range) {
        best = { channel: c, range: high - low };
      }
    }
    return best;
  };
  const population = (box: number[]) => box.reduce((sum, bin) => sum + counts[bin]!, 0);

  const boxes: number[][] = [bins];
  while (boxes.length < maxColors) {
    // Split the box with the widest spread of colours, preferring busier boxes on a tie.
    let target = -1;
    let score = 0;
    for (const [index, box] of boxes.entries()) {
      if (box.length < 2) {
        continue;
      }
      const { range } = rangeOf(box);
      const value = range * 1e12 + population(box);
      if (range > 0 && value > score) {
        score = value;
        target = index;
      }
    }
    if (target < 0) {
      break;
    }
    const box = boxes[target]!;
    const { channel: c } = rangeOf(box);
    box.sort((a, b) => channel(a, c) - channel(b, c));
    // Cut at the weighted median, keeping at least one bin on each side.
    const half = population(box) / 2;
    let running = 0;
    let cut = 1;
    for (let i = 0; i < box.length - 1; i += 1) {
      running += counts[box[i]!]!;
      cut = i + 1;
      if (running >= half) {
        break;
      }
    }
    boxes.splice(target, 1, box.slice(0, cut), box.slice(cut));
  }

  return boxes.map((box) => {
    let total = 0;
    let r = 0;
    let g = 0;
    let b = 0;
    for (const bin of box) {
      total += counts[bin]!;
      r += sums[bin * 3]!;
      g += sums[bin * 3 + 1]!;
      b += sums[bin * 3 + 2]!;
    }
    return [Math.round(r / total), Math.round(g / total), Math.round(b / total)];
  });
}

/** Map RGBA pixels to palette indices, caching the nearest colour for each histogram bin. */
function indexPixels(
  { pixels }: GifFrame,
  width: number,
  palette: readonly Rgb[],
  transparentIndex: number,
  nearest: Int16Array,
  dither: boolean,
): Uint8Array {
  const indices = new Uint8Array(pixels.length / 4);
  for (let p = 0, i = 0; i < pixels.length; p += 1, i += 4) {
    if (pixels[i + 3]! < GIF_ALPHA_THRESHOLD) {
      indices[p] = transparentIndex;
      continue;
    }
    let r = pixels[i]!;
    let g = pixels[i + 1]!;
    let b = pixels[i + 2]!;
    if (dither) {
      const x = p % width;
      const y = (p - x) / width;
      const offset = ((BAYER[(y & 3) * 4 + (x & 3)]! + 0.5) / 16 - 0.5) * DITHER_STRENGTH;
      r = Math.min(255, Math.max(0, Math.round(r + offset)));
      g = Math.min(255, Math.max(0, Math.round(g + offset)));
      b = Math.min(255, Math.max(0, Math.round(b + offset)));
    }
    const bin = binOf(r, g, b);
    let index = nearest[bin]!;
    if (index < 0) {
      // Nearest palette colour to the centre of this bin.
      const cr = ((bin >> 10) << 3) + 4;
      const cg = (((bin >> 5) & 31) << 3) + 4;
      const cb = ((bin & 31) << 3) + 4;
      let best = Number.POSITIVE_INFINITY;
      for (const [candidate, [pr, pg, pb]] of palette.entries()) {
        // Weighted towards green, which the eye is most sensitive to.
        const distance = 2 * (pr - cr) ** 2 + 4 * (pg - cg) ** 2 + 3 * (pb - cb) ** 2;
        if (distance < best) {
          best = distance;
          index = candidate;
        }
      }
      nearest[bin] = index;
    }
    indices[p] = index;
  }
  return indices;
}

/** LZW-compress palette indices as GIF image data (code size byte, sub-blocks, terminator). */
export function lzwEncode(indices: Uint8Array, minCodeSize: number): Uint8Array<ArrayBuffer> {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  const out = new ByteWriter();
  out.byte(minCodeSize);

  // Sub-blocks of at most 255 bytes.
  const block = new Uint8Array(255);
  let blockLength = 0;
  const flushBlock = () => {
    if (blockLength > 0) {
      out.byte(blockLength);
      out.bytes(block.subarray(0, blockLength));
      blockLength = 0;
    }
  };
  let bitBuffer = 0;
  let bitCount = 0;
  let codeSize = minCodeSize + 1;
  const emit = (code: number) => {
    bitBuffer |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      block[blockLength++] = bitBuffer & 0xff;
      if (blockLength === 255) {
        flushBlock();
      }
      bitBuffer >>>= 8;
      bitCount -= 8;
    }
  };

  // String table keyed by (prefix code, next index), reset cheaply by bumping a generation counter.
  const table = new Int32Array(MAX_CODES * 256);
  const generation = new Uint32Array(MAX_CODES * 256);
  let current = 1;
  let nextCode = endCode + 1;

  emit(clearCode);
  if (indices.length > 0) {
    let prefix = indices[0]!;
    for (let i = 1; i < indices.length; i += 1) {
      const symbol = indices[i]!;
      const key = prefix * 256 + symbol;
      if (generation[key] === current) {
        prefix = table[key]!;
        continue;
      }
      emit(prefix);
      if (nextCode === MAX_CODES) {
        // Table full: start again.
        emit(clearCode);
        current += 1;
        nextCode = endCode + 1;
        codeSize = minCodeSize + 1;
      } else {
        if (nextCode >= 1 << codeSize) {
          codeSize += 1;
        }
        generation[key] = current;
        table[key] = nextCode++;
      }
      prefix = symbol;
    }
    emit(prefix);
  }
  emit(endCode);
  if (bitCount > 0) {
    block[blockLength++] = bitBuffer & 0xff;
  }
  flushBlock();
  out.byte(0);
  return out.result();
}

/** Delays in centiseconds for runs of `ms` each, rounded so the total stays accurate. */
function centiseconds(durations: readonly number[]): number[] {
  let elapsed = 0;
  return durations.map((ms) => {
    const start = Math.round(elapsed / 10);
    elapsed += ms;
    return Math.max(MIN_GIF_DELAY_CS, Math.round(elapsed / 10) - start);
  });
}

/** Encode frames as a (possibly animated) GIF. */
export function buildGif(frames: readonly GifFrame[], params: GifParams): Uint8Array<ArrayBuffer> {
  const { width, height, sequence, frameDelay } = params;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new GifFormatError("GIF dimensions must be positive integers");
  }
  if (width > MAX_GIF_DIMENSION || height > MAX_GIF_DIMENSION) {
    throw new GifFormatError(`GIF dimensions can't exceed ${MAX_GIF_DIMENSION} pixels`);
  }
  if (sequence.length === 0) {
    throw new GifFormatError("A GIF needs at least one frame");
  }
  const used = [...new Set(sequence)];
  for (const index of used) {
    const frame = frames[index];
    if (!frame) {
      throw new GifFormatError(`Sequence references missing frame ${index}`);
    }
    if (frame.pixels.length !== width * height * 4) {
      throw new GifFormatError(`Frame ${index} has the wrong number of pixels`);
    }
  }
  const usedFrames = used.map((index) => frames[index]!);

  const hasAlpha = usedFrames.some(({ pixels }) => {
    for (let i = 3; i < pixels.length; i += 4) {
      if (pixels[i]! < GIF_ALPHA_THRESHOLD) {
        return true;
      }
    }
    return false;
  });
  const palette = medianCut(histogram(usedFrames), hasAlpha ? 255 : 256);
  const transparentIndex = hasAlpha ? palette.length : -1;
  const colours = palette.length + (hasAlpha ? 1 : 0);
  // The colour table holds a power of two entries, at least 2.
  let tableBits = 1;
  while (1 << tableBits < colours) {
    tableBits += 1;
  }
  const minCodeSize = Math.max(2, tableBits);

  const nearest = new Int16Array(1 << 15).fill(-1);
  const dither = params.dither ?? true;
  const images = new Map<number, Uint8Array>();
  for (const index of used) {
    images.set(index, lzwEncode(indexPixels(frames[index]!, width, palette, transparentIndex, nearest, dither), minCodeSize));
  }

  // A frame shown twice in a row becomes one frame shown for twice as long.
  const runs: { index: number; ms: number }[] = [];
  for (const index of sequence) {
    const last = runs.at(-1);
    if (last && last.index === index) {
      last.ms += frameDelay;
    } else {
      runs.push({ index, ms: frameDelay });
    }
  }
  const delays = centiseconds(runs.map((run) => run.ms));

  const out = new ByteWriter();
  out.ascii("GIF89a");
  // Logical screen descriptor with a global colour table.
  out.uint16(width);
  out.uint16(height);
  out.byte(0x80 | 0x70 | (tableBits - 1));
  out.byte(hasAlpha ? transparentIndex : 0);
  out.byte(0);
  for (let i = 0; i < 1 << tableBits; i += 1) {
    const [r, g, b] = palette[i] ?? [0, 0, 0];
    out.byte(r);
    out.byte(g);
    out.byte(b);
  }
  if (runs.length > 1) {
    // NETSCAPE2.0 application extension: loop count.
    out.bytes(Uint8Array.of(0x21, 0xff, 0x0b));
    out.ascii("NETSCAPE2.0");
    out.bytes(Uint8Array.of(0x03, 0x01));
    out.uint16(params.loopCount ?? 0);
    out.byte(0);
  }
  for (const [i, run] of runs.entries()) {
    // Graphic control extension: replace the previous frame (restore to background) when frames have holes.
    out.bytes(Uint8Array.of(0x21, 0xf9, 0x04));
    out.byte(((hasAlpha ? 2 : 1) << 2) | (hasAlpha ? 1 : 0));
    out.uint16(delays[i]!);
    out.byte(hasAlpha ? transparentIndex : 0);
    out.byte(0);
    // Image descriptor covering the whole canvas, using the global colour table.
    out.byte(0x2c);
    out.uint16(0);
    out.uint16(0);
    out.uint16(width);
    out.uint16(height);
    out.byte(0);
    out.bytes(images.get(run.index)!);
  }
  out.byte(0x3b);
  return out.result();
}
