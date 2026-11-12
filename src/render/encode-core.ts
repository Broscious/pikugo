import type { Rect, Size } from "../core/geometry";
import { buildGif, type GifFrame } from "../core/gif";
import type { AnimationFormat } from "../core/options";
import { buildAnimatedWebP, extractFrame, type EncodedFrame } from "../core/webp";

export type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface FrameSurface {
  readonly context: Context2D;
  /** Encode the surface's current pixels. */
  toBlob(type: string, quality: number): Promise<Blob>;
}

/** How to draw each source image into an output frame. */
export interface StillsPlan {
  /** Output size in pixels (after scaling). */
  output: Size;
  /** Source-pixel → output-pixel scale. */
  scale: number;
  /** Where each unique source image sits in the (unscaled) frame. */
  placements: Rect[];
}

/** How to encode each still. */
export interface StillFormatPlan {
  mimeType: string;
  quality: number;
  /** Fill transparent areas with this colour first (for formats without alpha). */
  matte: string | null;
}

export interface EncodePlan extends StillsPlan {
  sequence: number[];
  frameDelay: number;
  /** WebP quality (GIF ignores it). */
  quality: number;
  format: AnimationFormat;
}

export interface EncodeResult {
  bytes: Uint8Array<ArrayBuffer>;
  frameCount: number;
}

export type ProgressCallback = (done: number, total: number) => void;

/** Work the encoder can do, on a worker or on the main thread. */
export type EncodeTask = { task: "animation"; plan: EncodePlan } | { task: "stills"; plan: StillsPlan; format: StillFormatPlan };

export type TaskResult =
  | ({ task: "animation" } & EncodeResult)
  | { task: "stills"; stills: Uint8Array<ArrayBuffer>[] };

export class EncoderUnsupportedError extends Error {
  constructor() {
    super("This browser can't encode WebP images from a canvas. Try a current version of Chrome, Edge or Firefox.");
    this.name = "EncoderUnsupportedError";
  }
}

/** Draw one source image into an output frame. */
export function drawFrame(context: Context2D, image: CanvasImageSource, placement: Rect, output: Size, scale: number): void {
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, output.width, output.height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.setTransform(scale, 0, 0, scale, 0, 0);
  context.drawImage(image, placement.x, placement.y, placement.width, placement.height);
  context.setTransform(1, 0, 0, 1, 0, 0);
}

/**
 * Render and encode every source image once, then mux them into an animation
 * following the plan's sequence (which may repeat frames, e.g. for bounce).
 */
export async function encodeAnimation(
  images: readonly CanvasImageSource[],
  plan: EncodePlan,
  surface: FrameSurface,
  onProgress?: ProgressCallback,
): Promise<EncodeResult> {
  if (images.length !== plan.placements.length) {
    throw new Error("Each image needs exactly one placement");
  }
  if (plan.format === "gif") {
    return encodeGifAnimation(images, plan, surface, onProgress);
  }
  const used = [...new Set(plan.sequence)].sort((a, b) => a - b);
  const frames: EncodedFrame[] = [];
  let lastStill: Uint8Array<ArrayBuffer> | undefined;

  for (const [step, index] of used.entries()) {
    const image = images[index];
    const placement = plan.placements[index];
    if (image === undefined || placement === undefined) {
      throw new Error(`Sequence references missing image ${index}`);
    }
    drawFrame(surface.context, image, placement, plan.output, plan.scale);
    const blob = await surface.toBlob("image/webp", plan.quality);
    if (blob.type !== "image/webp") {
      throw new EncoderUnsupportedError();
    }
    lastStill = new Uint8Array(await blob.arrayBuffer());
    frames[index] = extractFrame(lastStill);
    onProgress?.(step + 1, used.length);
  }

  if (plan.sequence.length === 1 && lastStill) {
    return { bytes: lastStill, frameCount: 1 };
  }
  return {
    bytes: buildAnimatedWebP(frames, {
      width: plan.output.width,
      height: plan.output.height,
      sequence: plan.sequence,
      frameDelay: plan.frameDelay,
    }),
    frameCount: plan.sequence.length,
  };
}

/** Render each source image once, read its pixels back and encode a GIF. */
function encodeGifAnimation(
  images: readonly CanvasImageSource[],
  plan: EncodePlan,
  surface: FrameSurface,
  onProgress?: ProgressCallback,
): EncodeResult {
  const used = [...new Set(plan.sequence)].sort((a, b) => a - b);
  const frames: GifFrame[] = [];
  const { width, height } = plan.output;
  for (const [step, index] of used.entries()) {
    const image = images[index];
    const placement = plan.placements[index];
    if (image === undefined || placement === undefined) {
      throw new Error(`Sequence references missing image ${index}`);
    }
    drawFrame(surface.context, image, placement, plan.output, plan.scale);
    frames[index] = { pixels: surface.context.getImageData(0, 0, width, height).data };
    onProgress?.(step + 1, used.length);
  }
  return {
    bytes: buildGif(frames, { width, height, sequence: plan.sequence, frameDelay: plan.frameDelay }),
    frameCount: plan.sequence.length,
  };
}

/**
 * Render every source image into its own still, in photo order, exactly as it
 * is drawn into the animation.
 */
export async function renderStills(
  images: readonly CanvasImageSource[],
  plan: StillsPlan,
  format: StillFormatPlan,
  surface: FrameSurface,
  onProgress?: ProgressCallback,
): Promise<Uint8Array<ArrayBuffer>[]> {
  if (images.length !== plan.placements.length) {
    throw new Error("Each image needs exactly one placement");
  }
  const stills: Uint8Array<ArrayBuffer>[] = [];
  for (const [index, image] of images.entries()) {
    const { context } = surface;
    drawFrame(context, image, plan.placements[index]!, plan.output, plan.scale);
    if (format.matte) {
      // Paint the matte behind the photo, so only uncovered areas take its colour.
      context.globalCompositeOperation = "destination-over";
      context.fillStyle = format.matte;
      context.fillRect(0, 0, plan.output.width, plan.output.height);
      context.globalCompositeOperation = "source-over";
    }
    const blob = await surface.toBlob(format.mimeType, format.quality);
    if (blob.type !== format.mimeType) {
      const name = format.mimeType.replace("image/", "").toUpperCase();
      throw new Error(`This browser can't export ${name} images from a canvas. Try PNG instead.`);
    }
    stills.push(new Uint8Array(await blob.arrayBuffer()));
    onProgress?.(index + 1, images.length);
  }
  return stills;
}

/** Run an encoder task against a drawing surface. */
export async function runTask(
  images: readonly CanvasImageSource[],
  task: EncodeTask,
  surface: FrameSurface,
  onProgress?: ProgressCallback,
): Promise<TaskResult> {
  if (task.task === "stills") {
    return { task: "stills", stills: await renderStills(images, task.plan, task.format, surface, onProgress) };
  }
  return { task: "animation", ...(await encodeAnimation(images, task.plan, surface, onProgress)) };
}

/** Buffers to transfer (rather than copy) when posting a result between threads. */
export function resultBuffers(result: TaskResult): ArrayBuffer[] {
  return result.task === "stills" ? result.stills.map((still) => still.buffer) : [result.bytes.buffer];
}
