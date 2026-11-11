import {
  EncoderUnsupportedError,
  runTask,
  type EncodePlan,
  type EncodeTask,
  type FrameSurface,
  type ProgressCallback,
  type StillFormatPlan,
  type StillsPlan,
  type TaskResult,
} from "./encode-core";
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

async function runInWorker(images: readonly ImageBitmap[], task: EncodeTask, onProgress?: ProgressCallback): Promise<TaskResult> {
  // The worker takes ownership of the bitmaps it receives, so send copies.
  const copies = await Promise.all(images.map((image) => createImageBitmap(image)));
  const target = getWorker();
  const id = nextRequestId++;
  return new Promise<TaskResult>((resolve, reject) => {
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
        resolve(message.result);
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
    const request: EncodeRequest = { id, images: copies, ...task };
    target.postMessage(request, copies);
  });
}

async function runOnMainThread(images: readonly CanvasImageSource[], task: EncodeTask, onProgress?: ProgressCallback): Promise<TaskResult> {
  const canvas = document.createElement("canvas");
  canvas.width = task.plan.output.width;
  canvas.height = task.plan.output.height;
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
  return runTask(images, task, surface, onProgress);
}

/**
 * Run a task, preferring a Web Worker with OffscreenCanvas so the page stays
 * responsive, and falling back to the main thread when that is not available.
 */
async function run(
  images: readonly ImageBitmap[],
  task: EncodeTask,
  onProgress?: ProgressCallback,
): Promise<{ result: TaskResult; engine: EncoderEngine; elapsedMs: number }> {
  const startedAt = performance.now();
  const finish = (result: TaskResult, engine: EncoderEngine) => ({ result, engine, elapsedMs: performance.now() - startedAt });

  if (supportsWorkerEncoding() && !workerBroken) {
    try {
      return finish(await runInWorker(images, task, onProgress), "worker");
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
  return finish(await runOnMainThread(images, task, onProgress), "main-thread");
}

/** Encode an animated WebP (or a still WebP for a single frame). */
export async function encodeWebP(images: readonly ImageBitmap[], plan: EncodePlan, onProgress?: ProgressCallback): Promise<EncodeOutcome> {
  const { result, engine, elapsedMs } = await run(images, { task: "animation", plan }, onProgress);
  if (result.task !== "animation") {
    throw new Error("Encoder returned the wrong kind of result");
  }
  return { blob: new Blob([result.bytes], { type: "image/webp" }), frameCount: result.frameCount, engine, elapsedMs };
}

export interface StillsOutcome {
  /** One PNG per source image, in photo order. */
  stills: Uint8Array<ArrayBuffer>[];
  engine: EncoderEngine;
  elapsedMs: number;
}

/** Render each source image as its own aligned, framed still. */
export async function renderStillFrames(
  images: readonly ImageBitmap[],
  plan: StillsPlan,
  format: StillFormatPlan,
  onProgress?: ProgressCallback,
): Promise<StillsOutcome> {
  const { result, engine, elapsedMs } = await run(images, { task: "stills", plan, format }, onProgress);
  if (result.task !== "stills") {
    throw new Error("Encoder returned the wrong kind of result");
  }
  return { stills: result.stills, engine, elapsedMs };
}
