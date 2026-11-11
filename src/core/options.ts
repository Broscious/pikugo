import { clamp, type EdgeMode, type LayoutOptions, type Point } from "./geometry";

/**
 * - loop: 0 1 2 3 | 0 1 2 3
 * - bounce: forwards then backwards, end frames shown once: 0 1 2 3 2 1 | 0 ...
 * - smooth: forwards then backwards, end frames shown twice so the turnaround
 *   lingers like a real change of direction: 0 1 2 3 3 2 1 0 | 0 ...
 * Both bounce modes need at least 3 frames; with fewer they play as a loop.
 */
export type Playback = "loop" | "bounce" | "smooth";

export const PLAYBACK_LABELS: Readonly<Record<Playback, string>> = Object.freeze({
  loop: "Loop",
  bounce: "Bounce",
  smooth: "Smooth bounce",
});

/** Narrow an arbitrary value to a playback mode, falling back to the default. */
export function parsePlayback(value: unknown): Playback {
  return value === "loop" || value === "bounce" || value === "smooth" ? value : DEFAULT_OPTIONS.playback;
}

export interface AnimationOptions {
  /** Time each frame is shown, in milliseconds. */
  frameDelay: number;
  playback: Playback;
  edges: EdgeMode;
  /** Aspect ratio as typed by the user ("16:9", "1.5"), or "free". */
  aspect: string;
  /** Fixed focal-point position as fractions of the frame, or null for automatic. */
  anchor: Point | null;
  /** Longest output edge in pixels, or null to keep the source resolution. */
  maxEdge: number | null;
  /** Lossy encoder quality, 0..1. */
  quality: number;
}

export const FRAME_DELAY_MIN = 20;
export const FRAME_DELAY_MAX = 5000;

export const DEFAULT_OPTIONS: Readonly<AnimationOptions> = Object.freeze({
  frameDelay: 100,
  playback: "smooth",
  edges: "crop",
  aspect: "free",
  anchor: null,
  maxEdge: 1080,
  quality: 0.85,
});

export const ASPECT_PRESETS: readonly { label: string; value: string }[] = [
  { label: "Free", value: "free" },
  { label: "1:1", value: "1:1" },
  { label: "4:5", value: "4:5" },
  { label: "4:3", value: "4:3" },
  { label: "3:2", value: "3:2" },
  { label: "16:9", value: "16:9" },
  { label: "9:16", value: "9:16" },
];

export const MAX_EDGE_PRESETS: readonly { label: string; value: number | null }[] = [
  { label: "480", value: 480 },
  { label: "720", value: 720 },
  { label: "1080", value: 1080 },
  { label: "2048", value: 2048 },
  { label: "Original", value: null },
];

export const DELAY_PRESETS: readonly number[] = [50, 100, 150, 250, 500];

/**
 * Parse an aspect ratio written as "W:H", "W/H", "WxH" or a single number.
 * Returns null for "free"/empty input, and undefined when the text is invalid.
 */
export function parseAspectRatio(text: string): number | null | undefined {
  const value = text.trim().toLowerCase();
  if (value === "" || value === "free" || value === "auto") {
    return null;
  }
  const pair = /^(\d+(?:\.\d+)?)\s*[:/x×]\s*(\d+(?:\.\d+)?)$/.exec(value);
  const ratio = pair ? Number(pair[1]) / Number(pair[2]) : /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 100 || ratio < 0.01) {
    return undefined;
  }
  return ratio;
}

export function layoutOptionsFrom(options: AnimationOptions): LayoutOptions {
  return {
    edges: options.edges,
    aspectRatio: parseAspectRatio(options.aspect) ?? null,
    anchor: options.anchor,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Coerce untrusted input (e.g. saved settings) into valid options. */
export function sanitizeOptions(input: unknown): AnimationOptions {
  const raw = isRecord(input) ? input : {};
  const delay = finite(raw.frameDelay);
  const quality = finite(raw.quality);
  const maxEdge = finite(raw.maxEdge);
  const aspect = typeof raw.aspect === "string" && parseAspectRatio(raw.aspect) !== undefined ? raw.aspect : DEFAULT_OPTIONS.aspect;
  let anchor: Point | null = null;
  if (isRecord(raw.anchor)) {
    const x = finite(raw.anchor.x);
    const y = finite(raw.anchor.y);
    if (x !== undefined && y !== undefined) {
      anchor = { x: clamp(x, 0, 1), y: clamp(y, 0, 1) };
    }
  }
  return {
    frameDelay: delay === undefined ? DEFAULT_OPTIONS.frameDelay : Math.round(clamp(delay, FRAME_DELAY_MIN, FRAME_DELAY_MAX)),
    playback: parsePlayback(raw.playback),
    edges: raw.edges === "layer" ? "layer" : "crop",
    aspect,
    anchor,
    maxEdge: raw.maxEdge === null ? null : maxEdge !== undefined && maxEdge >= 16 ? Math.round(maxEdge) : DEFAULT_OPTIONS.maxEdge,
    quality: quality === undefined ? DEFAULT_OPTIONS.quality : clamp(quality, 0.05, 1),
  };
}

/** Order in which source images are shown (see {@link Playback}). */
export function frameSequence(count: number, playback: Playback): number[] {
  const forward = Array.from({ length: Math.max(0, count) }, (_, index) => index);
  if (playback === "smooth" && count >= 3) {
    return [...forward, ...forward.slice().reverse()];
  }
  if (playback === "bounce" && count >= 3) {
    return [...forward, ...forward.slice(1, -1).reverse()];
  }
  return forward;
}
