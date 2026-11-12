import type { FrameSource } from "../core/geometry";
import { DEFAULT_OPTIONS, type AnimationOptions } from "../core/options";
import { planAnimation, type AnimationPlan } from "../core/plan";
import type { EncoderEngine } from "../render/encoder";
import { Store } from "./store";

export interface SourceImage extends FrameSource {
  id: string;
  name: string;
  /** Object URL for <img> display. */
  url: string;
  /** Decoded pixels, orientation applied, used for drawing. */
  bitmap: ImageBitmap;
  /** Whether the focal point has been chosen (by hand or by auto-match). */
  focusSet: boolean;
  /** Set when the focal point was found automatically rather than placed by hand. */
  autoMatch: { score: number; referenceId: string } | null;
}

export interface GeneratedResult {
  url: string;
  filename: string;
  /** File format label, e.g. "WebP". */
  format: string;
  bytes: number;
  width: number;
  height: number;
  frameCount: number;
  durationMs: number;
  elapsedMs: number;
  engine: EncoderEngine;
  /** Fingerprint of the inputs, to detect when the result is out of date. */
  signature: string;
}

export interface AppState {
  images: SourceImage[];
  active: number;
  options: AnimationOptions;
  /** Options being previewed while the user hovers a control. */
  hoverOptions: Partial<AnimationOptions> | null;
  loading: boolean;
  /** Progress of the running encode: the animation, or the stills export. */
  encoding: { task: "animation" | "stills"; done: number; total: number } | null;
  /** Progress while focal points are being matched across photos. */
  matching: { done: number; total: number } | null;
  result: GeneratedResult | null;
}

export type AppStore = Store<AppState>;

export function createAppStore(options: AnimationOptions = { ...DEFAULT_OPTIONS }): AppStore {
  return new Store<AppState>({
    images: [],
    active: -1,
    options,
    hoverOptions: null,
    loading: false,
    encoding: null,
    matching: null,
    result: null,
  });
}

export type PlanResult = { plan: AnimationPlan; error: null } | { plan: null; error: string };

export function tryPlan(images: readonly FrameSource[], options: AnimationOptions): PlanResult {
  if (images.length === 0) {
    return { plan: null, error: "Add some photos to get started." };
  }
  try {
    return { plan: planAnimation(images, options), error: null };
  } catch (error) {
    return { plan: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Options with any hover preview applied. */
export function effectiveOptions(state: AppState): AnimationOptions {
  return state.hoverOptions ? { ...state.options, ...state.hoverOptions } : state.options;
}

/** Fingerprint of everything that affects the encoded output. */
export function signatureOf(state: Pick<AppState, "images" | "options">): string {
  return JSON.stringify({
    images: state.images.map((image) => [image.id, image.focus.x, image.focus.y]),
    // The stills format doesn't change the animation.
    options: { ...state.options, stillFormat: undefined },
  });
}

/** Photos whose focal point the user placed by hand. */
export function isManualFocus(image: SourceImage): boolean {
  return image.focusSet && image.autoMatch === null;
}

/** Photos (by index) to auto-match in order, starting from a hand-placed one. */
export interface MatchPlan {
  start: number;
  targets: number[];
}

/**
 * How to auto-match the photos that weren't placed by hand. Each is matched
 * against its neighbour rather than one distant photo: photos after a
 * hand-placed one are matched forward from it, up to the next hand-placed
 * photo, and photos before the first hand-placed one are matched backward.
 */
export function planMatches(images: readonly SourceImage[]): MatchPlan[] {
  const manual = images.flatMap((image, index) => (isManualFocus(image) ? [index] : []));
  const first = manual[0];
  if (first === undefined) {
    return [];
  }
  const range = (from: number, to: number) => Array.from({ length: Math.abs(to - from) + 1 }, (_, i) => from + i * Math.sign(to - from || 1));
  const plans: MatchPlan[] = [];
  if (first > 0) {
    plans.push({ start: first, targets: range(first - 1, 0) });
  }
  manual.forEach((start, k) => {
    const end = manual[k + 1] ?? images.length;
    if (end - start > 1) {
      plans.push({ start, targets: range(start + 1, end - 1) });
    }
  });
  return plans;
}
