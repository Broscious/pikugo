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
  /** Whether the user has chosen a focal point yet. */
  focusSet: boolean;
}

export interface GeneratedResult {
  url: string;
  filename: string;
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
  encoding: { done: number; total: number } | null;
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
    options: state.options,
  });
}
