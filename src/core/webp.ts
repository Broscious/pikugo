/**
 * Minimal WebP (RIFF) container reader/writer.
 *
 * Browsers can encode a single still WebP from a canvas, but not an animation.
 * We encode each frame as a still, pull the bitstream chunks back out, and wrap
 * them in an animated WebP container (VP8X + ANIM + ANMF chunks).
 *
 * Spec: https://developers.google.com/speed/webp/docs/riff_container
 */

export interface WebPChunk {
  type: string;
  /** Chunk payload, without the 8-byte header or padding. */
  data: Uint8Array;
}

export interface EncodedFrame {
  /** ALPH / VP8 / VP8L chunks, serialised with headers and padding. */
  bitstream: Uint8Array;
  hasAlpha: boolean;
}

export interface AnimationParams {
  width: number;
  height: number;
  /** Indices into the encoded frames, in display order. Frames can repeat. */
  sequence: readonly number[];
  /** Display time of each frame, in milliseconds. */
  frameDelay: number;
  /** 0 loops forever. */
  loopCount?: number;
  /** Background colour hint as [r, g, b, a]. Defaults to transparent. */
  backgroundColor?: readonly [number, number, number, number];
}

export class WebPFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebPFormatError";
  }
}

export const MAX_CANVAS_DIMENSION = 1 << 24;
export const MAX_FRAME_DURATION = (1 << 24) - 1;
const VP8X_FLAG_ANIMATION = 0x02;
const VP8X_FLAG_ALPHA = 0x10;
const ANMF_FLAG_NO_BLEND = 0x02;
const BITSTREAM_TYPES = new Set(["ALPH", "VP8 ", "VP8L"]);

const ascii = new TextEncoder();

function fourCC(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset] ?? 0, bytes[offset + 1] ?? 0, bytes[offset + 2] ?? 0, bytes[offset + 3] ?? 0);
}

function writeUint24(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >> 8) & 0xff;
  target[offset + 2] = (value >> 16) & 0xff;
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/** Serialise a chunk: FourCC, little-endian size, payload, and a pad byte if the size is odd. */
export function encodeChunk(type: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
  if (type.length !== 4) {
    throw new WebPFormatError(`Chunk type must be four characters, got "${type}"`);
  }
  const chunk = new Uint8Array(8 + data.length + (data.length % 2));
  chunk.set(ascii.encode(type), 0);
  new DataView(chunk.buffer).setUint32(4, data.length, true);
  chunk.set(data, 8);
  return chunk;
}

/** Wrap chunks in a `RIFF....WEBP` file header. */
export function wrapRiff(chunks: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const body = concatBytes(chunks);
  const file = new Uint8Array(12 + body.length);
  file.set(ascii.encode("RIFF"), 0);
  new DataView(file.buffer).setUint32(4, 4 + body.length, true);
  file.set(ascii.encode("WEBP"), 8);
  file.set(body, 12);
  return file;
}

/** List the top-level chunks of a WebP file. */
export function readChunks(bytes: Uint8Array): WebPChunk[] {
  if (bytes.length < 12 || fourCC(bytes, 0) !== "RIFF" || fourCC(bytes, 8) !== "WEBP") {
    throw new WebPFormatError("Not a WebP file");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const riffEnd = Math.min(bytes.length, 8 + view.getUint32(4, true));
  const chunks: WebPChunk[] = [];
  let offset = 12;
  while (offset + 8 <= riffEnd) {
    const type = fourCC(bytes, offset);
    const size = view.getUint32(offset + 4, true);
    const end = offset + 8 + size;
    if (end > bytes.length) {
      throw new WebPFormatError(`Truncated "${type}" chunk`);
    }
    chunks.push({ type, data: bytes.subarray(offset + 8, end) });
    offset = end + (size % 2);
  }
  return chunks;
}

/** True if a VP8L (lossless) bitstream header declares an alpha channel. */
function vp8lUsesAlpha(data: Uint8Array): boolean {
  // Signature byte 0x2f, then 14 bits width-1, 14 bits height-1, 1 bit alpha_is_used.
  return data.length >= 5 && data[0] === 0x2f && ((data[4] ?? 0) & 0x10) !== 0;
}

/** Pull the image bitstream out of a still WebP so it can be placed in an animation frame. */
export function extractFrame(bytes: Uint8Array): EncodedFrame {
  const chunks = readChunks(bytes).filter((chunk) => BITSTREAM_TYPES.has(chunk.type));
  if (!chunks.some((chunk) => chunk.type === "VP8 " || chunk.type === "VP8L")) {
    throw new WebPFormatError("WebP file contains no image data");
  }
  return {
    bitstream: concatBytes(chunks.map((chunk) => encodeChunk(chunk.type, chunk.data))),
    hasAlpha: chunks.some((chunk) => chunk.type === "ALPH" || (chunk.type === "VP8L" && vp8lUsesAlpha(chunk.data))),
  };
}

function assertDimension(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > MAX_CANVAS_DIMENSION) {
    throw new WebPFormatError(`${name} must be an integer between 1 and ${MAX_CANVAS_DIMENSION}`);
  }
}

/** Assemble an animated WebP from encoded frames. */
export function buildAnimatedWebP(frames: readonly EncodedFrame[], params: AnimationParams): Uint8Array<ArrayBuffer> {
  const { width, height, sequence } = params;
  assertDimension("Width", width);
  assertDimension("Height", height);
  if (sequence.length === 0) {
    throw new WebPFormatError("An animation needs at least one frame");
  }
  const duration = Math.round(params.frameDelay);
  if (!(duration >= 0 && duration <= MAX_FRAME_DURATION)) {
    throw new WebPFormatError(`Frame delay must be between 0 and ${MAX_FRAME_DURATION} ms`);
  }
  const loopCount = params.loopCount ?? 0;
  if (!Number.isInteger(loopCount) || loopCount < 0 || loopCount > 0xffff) {
    throw new WebPFormatError("Loop count must be an integer between 0 and 65535");
  }
  const used = sequence.map((index) => {
    const frame = frames[index];
    if (frame === undefined) {
      throw new WebPFormatError(`Sequence references missing frame ${index}`);
    }
    return frame;
  });

  const header = new Uint8Array(10);
  header[0] = VP8X_FLAG_ANIMATION | (used.some((frame) => frame.hasAlpha) ? VP8X_FLAG_ALPHA : 0);
  writeUint24(header, 4, width - 1);
  writeUint24(header, 7, height - 1);

  const animation = new Uint8Array(6);
  const [red, green, blue, alpha] = params.backgroundColor ?? [0, 0, 0, 0];
  // Stored in [Blue, Green, Red, Alpha] byte order.
  animation.set([blue, green, red, alpha], 0);
  new DataView(animation.buffer).setUint16(4, loopCount, true);

  const chunks = [encodeChunk("VP8X", header), encodeChunk("ANIM", animation)];
  for (const frame of used) {
    const frameHeader = new Uint8Array(16);
    // Bytes 0-5: X/Y offset (both 0, every frame covers the full canvas).
    writeUint24(frameHeader, 6, width - 1);
    writeUint24(frameHeader, 9, height - 1);
    writeUint24(frameHeader, 12, duration);
    // Replace the canvas rather than alpha-blend, so transparent areas stay transparent.
    frameHeader[15] = ANMF_FLAG_NO_BLEND;
    chunks.push(encodeChunk("ANMF", concatBytes([frameHeader, frame.bitstream])));
  }
  return wrapRiff(chunks);
}

export interface AnimationInfo {
  width: number;
  height: number;
  hasAlpha: boolean;
  loopCount: number;
  frames: { width: number; height: number; duration: number; blend: boolean; chunkTypes: string[] }[];
}

function readUint24(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16);
}

/** Describe an animated WebP. Used by the tests and handy for debugging. */
export function inspectAnimation(bytes: Uint8Array): AnimationInfo {
  const chunks = readChunks(bytes);
  const vp8x = chunks.find((chunk) => chunk.type === "VP8X");
  const anim = chunks.find((chunk) => chunk.type === "ANIM");
  if (!vp8x || !anim || ((vp8x.data[0] ?? 0) & VP8X_FLAG_ANIMATION) === 0) {
    throw new WebPFormatError("Not an animated WebP");
  }
  return {
    width: readUint24(vp8x.data, 4) + 1,
    height: readUint24(vp8x.data, 7) + 1,
    hasAlpha: ((vp8x.data[0] ?? 0) & VP8X_FLAG_ALPHA) !== 0,
    loopCount: new DataView(anim.data.buffer, anim.data.byteOffset, anim.data.byteLength).getUint16(4, true),
    frames: chunks
      .filter((chunk) => chunk.type === "ANMF")
      .map((chunk) => {
        const payload = chunk.data;
        const nested = readChunks(wrapRiff([payload.subarray(16)]));
        return {
          width: readUint24(payload, 6) + 1,
          height: readUint24(payload, 9) + 1,
          duration: readUint24(payload, 12),
          blend: ((payload[15] ?? 0) & ANMF_FLAG_NO_BLEND) === 0,
          chunkTypes: nested.map((inner) => inner.type),
        };
      }),
  };
}
