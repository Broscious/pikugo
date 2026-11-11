import type { Rect, Size } from "../core/geometry";
import { buildAnimatedWebP, extractFrame, type EncodedFrame } from "../core/webp";

export type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface FrameSurface {
  readonly context: Context2D;
  /** Encode the surface's current pixels. */
  toBlob(type: string, quality: number): Promise<Blob>;
}

export interface EncodePlan {
  /** Output size in pixels (after scaling). */
  output: Size;
  /** Source-pixel → output-pixel scale. */
  scale: number;
  /** Where each unique source image sits in the (unscaled) frame. */
  placements: Rect[];
  sequence: number[];
  frameDelay: number;
  quality: number;
}

export interface EncodeResult {
  bytes: Uint8Array<ArrayBuffer>;
  frameCount: number;
}

export type ProgressCallback = (done: number, total: number) => void;

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
