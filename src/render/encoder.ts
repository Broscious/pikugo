import { encodeAnimation, EncoderUnsupportedError, type EncodePlan, type FrameSurface, type ProgressCallback } from "./encode-core";
import type { EncodeRequest, EncodeResponse } from "./protocol";

export type EncoderEngine = "worker" | "main-thread";

export interface EncodeOutcome {
  blob: Blob;
  frameCount: number;
  engine: EncoderEngine;
  elapsedMs: number;
}

function supportsWorkerEncoding(): boolean {
  return (
    typeof Worker !== "undefined" &&
    typeof OffscreenCanvas !== "undefined" &&
    typeof OffscreenCanvas.prototype.convertToBlob === "function" &&
    typeof createImageBitmap === "function"
  );
}

let worker: Worker | null = null;
let workerBroken = false;
let nextRequestId = 1;

function getWorker(): Worker {
  worker ??= new Worker(new URL("./encode.worker.ts", import.meta.url), { type: "module", name: "webp-encoder" });
  return worker;
}

async function encodeInWorker(images: readonly ImageBitmap[], plan: EncodePlan, onProgress?: ProgressCallback) {
  // The worker takes ownership of the bitmaps it receives, so send copies.
  const copies = await Promise.all(images.map((image) => createImageBitmap(image)));
  const target = getWorker();
  const id = nextRequestId++;
  return new Promise<{ bytes: Uint8Array<ArrayBuffer>; frameCount: number }>((resolve, reject) => {
    const cleanup = () => {
      target.removeEventListener("message", onMessage);
      target.removeEventListener("error", onError);
    };
    const onMessage = (event: MessageEvent<EncodeResponse>) => {
      const message = event.data;
      if (message.id !== id) {
        return;
      }
      if (message.kind === "progress") {
        onProgress?.(message.done, message.total);
        return;
      }
      cleanup();
      if (message.kind === "done") {
        resolve({ bytes: message.bytes, frameCount: message.frameCount });
      } else if (message.name === "EncoderUnsupportedError") {
        reject(new EncoderUnsupportedError());
      } else {
        reject(new Error(message.message));
      }
    };
    const onError = (event: ErrorEvent) => {
      cleanup();
      event.preventDefault();
      reject(new Error(event.message || "Encoder worker failed to start"));
    };
    target.addEventListener("message", onMessage);
    target.addEventListener("error", onError);
    const request: EncodeRequest = { id, images: copies, plan };
    target.postMessage(request, copies);
  });
}

async function encodeOnMainThread(images: readonly CanvasImageSource[], plan: EncodePlan, onProgress?: ProgressCallback) {
  const canvas = document.createElement("canvas");
  canvas.width = plan.output.width;
  canvas.height = plan.output.height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas 2D rendering is unavailable in this browser");
  }
  const surface: FrameSurface = {
    context,
    toBlob: (type, quality) =>
      new Promise((resolve, reject) => {
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new EncoderUnsupportedError())), type, quality);
      }),
  };
  return encodeAnimation(images, plan, surface, onProgress);
}

/**
 * Encode an animated WebP. Prefers a Web Worker with OffscreenCanvas so the
 * page stays responsive, and falls back to the main thread when that is not
 * available.
 */
export async function encodeWebP(
  images: readonly ImageBitmap[],
  plan: EncodePlan,
  onProgress?: ProgressCallback,
): Promise<EncodeOutcome> {
  const startedAt = performance.now();
  const finish = (result: { bytes: Uint8Array<ArrayBuffer>; frameCount: number }, engine: EncoderEngine): EncodeOutcome => ({
    blob: new Blob([result.bytes], { type: "image/webp" }),
    frameCount: result.frameCount,
    engine,
    elapsedMs: performance.now() - startedAt,
  });

  if (supportsWorkerEncoding() && !workerBroken) {
    try {
      return finish(await encodeInWorker(images, plan, onProgress), "worker");
    } catch (error) {
      if (error instanceof EncoderUnsupportedError) {
        throw error;
      }
      console.warn("Worker encoding failed, retrying on the main thread", error);
      workerBroken = true;
      worker?.terminate();
      worker = null;
    }
  }
  return finish(await encodeOnMainThread(images, plan, onProgress), "main-thread");
}
