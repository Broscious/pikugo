import type { Point } from "../core/geometry";
import { isConfident, type MatchOutcome } from "../core/match";
import { matchChains, matchSize, type MatchChain, type PixelReader } from "./match-core";
import type { MatchRequest, MatchResponse } from "./match-protocol";

export interface FocusMatch {
  /** Matching focus point in the target's own pixels, or null when there's no confident match. */
  focus: Point | null;
  /** Match score, 0..1 (0 when matching couldn't run). */
  score: number;
  /** Why no point was returned. */
  reason: "featureless" | "too-small" | "uncertain" | null;
}

/** Photos to match in order, starting from one whose point is known. See {@link MatchChain}. */
export interface FocusChain {
  reference: ImageBitmap;
  /** Known point in the reference's own pixels. */
  focus: Point;
  targets: readonly ImageBitmap[];
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

function runInWorker(images: ImageBitmap[], chains: MatchChain[], onProgress?: ProgressCallback) {
  const target = getWorker();
  const id = nextRequestId++;
  return new Promise<MatchOutcome[][]>((resolve, reject) => {
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
    const request: MatchRequest = { id, images, chains };
    target.postMessage(request, images);
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

/** Turn a match in matching-size pixels into a result in the photo's own pixels. */
function toFocusMatch(outcome: MatchOutcome, original: ImageBitmap): FocusMatch {
  if (!outcome.ok) {
    return { focus: null, score: 0, reason: outcome.reason };
  }
  if (!isConfident(outcome)) {
    return { focus: null, score: outcome.score, reason: "uncertain" };
  }
  const size = matchSize(original);
  return {
    focus: { x: (outcome.point.x * original.width) / size.width, y: (outcome.point.y * original.height) / size.height },
    score: outcome.score,
    reason: null,
  };
}

/**
 * Find the matching point in each chain's targets, each matched against the
 * previous photo in its chain. Returns one result per target, per chain. Runs
 * in a Web Worker when possible, otherwise on the main thread.
 */
export async function matchFocus(chains: readonly FocusChain[], onProgress?: ProgressCallback): Promise<FocusMatch[][]> {
  // A photo can appear in several chains (one running each way), but is only resized and sent once.
  const images: ImageBitmap[] = [];
  const indexOf = new Map<ImageBitmap, number>();
  const index = (image: ImageBitmap) => {
    let found = indexOf.get(image);
    if (found === undefined) {
      found = images.push(image) - 1;
      indexOf.set(image, found);
    }
    return found;
  };
  const plans: MatchChain[] = chains
    .filter((chain) => chain.targets.length > 0)
    .map(({ reference, focus, targets }) => {
      const size = matchSize(reference);
      return {
        start: index(reference),
        focus: { x: (focus.x * size.width) / reference.width, y: (focus.y * size.height) / reference.height },
        targets: targets.map(index),
      };
    });
  if (plans.length === 0) {
    return chains.map(() => []);
  }

  let outcomes: MatchOutcome[][] | undefined;
  if (supportsWorker() && !workerBroken) {
    try {
      outcomes = await runInWorker(await Promise.all(images.map(resized)), plans, onProgress);
    } catch (error) {
      console.warn("Worker matching failed, retrying on the main thread", error);
      workerBroken = true;
      worker?.terminate();
      worker = null;
    }
  }
  outcomes ??= matchChains(
    images.map((image) => ({ image, ...matchSize(image) })),
    plans,
    readOnMainThread,
    onProgress,
  );

  let next = 0;
  return chains.map((chain) => {
    if (chain.targets.length === 0) {
      return [];
    }
    const results = outcomes[next++]!;
    return results.map((outcome, i) => toFocusMatch(outcome, chain.targets[i]!));
  });
}
