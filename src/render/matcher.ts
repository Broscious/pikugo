import type { Point } from "../core/geometry";
import { isConfident, type MatchOutcome } from "../core/match";
import { matchAll, matchSize, type PixelReader } from "./match-core";
import type { MatchRequest, MatchResponse } from "./match-protocol";

export interface FocusMatch {
  /** Matching focus point in the target's own pixels, or null when there's no confident match. */
  focus: Point | null;
  /** Match score, 0..1 (0 when matching couldn't run). */
  score: number;
  /** Why no point was returned. */
  reason: "featureless" | "too-small" | "uncertain" | null;
}

export type ProgressCallback = (done: number, total: number) => void;

function supportsWorker(): boolean {
  return typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined" && typeof createImageBitmap === "function";
}

let worker: Worker | null = null;
let workerBroken = false;
let nextRequestId = 1;

function getWorker(): Worker {
  worker ??= new Worker(new URL("./match.worker.ts", import.meta.url), { type: "module", name: "focus-matcher" });
  return worker;
}

/** Downscaled copy of a photo for matching. It is small to send and the worker can own it. */
function resized(image: ImageBitmap): Promise<ImageBitmap> {
  const size = matchSize(image);
  return createImageBitmap(image, { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: "medium" });
}

function runInWorker(reference: ImageBitmap, focus: Point, targets: ImageBitmap[], onProgress?: ProgressCallback) {
  const target = getWorker();
  const id = nextRequestId++;
  return new Promise<MatchOutcome[]>((resolve, reject) => {
    const cleanup = () => {
      target.removeEventListener("message", onMessage);
      target.removeEventListener("error", onError);
    };
    const onMessage = (event: MessageEvent<MatchResponse>) => {
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
        resolve(message.outcomes);
      } else {
        reject(new Error(message.message));
      }
    };
    const onError = (event: ErrorEvent) => {
      cleanup();
      event.preventDefault();
      reject(new Error(event.message || "Matcher worker failed to start"));
    };
    target.addEventListener("message", onMessage);
    target.addEventListener("error", onError);
    const request: MatchRequest = { id, reference, focus, targets };
    target.postMessage(request, [reference, ...targets]);
  });
}

const readOnMainThread: PixelReader = (image, width, height) => {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("Canvas 2D rendering is unavailable in this browser");
  }
  context.drawImage(image, 0, 0, width, height);
  return context.getImageData(0, 0, width, height);
};

/**
 * Find the point in each target photo that matches `focus` in the reference
 * photo. Runs in a Web Worker when possible, otherwise on the main thread.
 */
export async function matchFocus(
  reference: ImageBitmap,
  focus: Point,
  targets: readonly ImageBitmap[],
  onProgress?: ProgressCallback,
): Promise<FocusMatch[]> {
  if (targets.length === 0) {
    return [];
  }
  const referenceSize = matchSize(reference);
  const scaledFocus = { x: (focus.x * referenceSize.width) / reference.width, y: (focus.y * referenceSize.height) / reference.height };

  let outcomes: MatchOutcome[] | undefined;
  if (supportsWorker() && !workerBroken) {
    try {
      const [small, ...smallTargets] = await Promise.all([reference, ...targets].map(resized));
      outcomes = await runInWorker(small!, scaledFocus, smallTargets, onProgress);
    } catch (error) {
      console.warn("Worker matching failed, retrying on the main thread", error);
      workerBroken = true;
      worker?.terminate();
      worker = null;
    }
  }
  outcomes ??= matchAll(
    { image: reference, ...referenceSize },
    scaledFocus,
    targets.map((image) => ({ image, ...matchSize(image) })),
    readOnMainThread,
    onProgress,
  );

  return outcomes.map((outcome, index) => {
    if (!outcome.ok) {
      return { focus: null, score: 0, reason: outcome.reason };
    }
    if (!isConfident(outcome)) {
      return { focus: null, score: outcome.score, reason: "uncertain" };
    }
    const original = targets[index]!;
    const size = matchSize(original);
    return {
      focus: { x: (outcome.point.x * original.width) / size.width, y: (outcome.point.y * original.height) / size.height },
      score: outcome.score,
      reason: null,
    };
  });
}
