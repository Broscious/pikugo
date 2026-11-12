import type { Point } from "../core/geometry";
import type { MatchOutcome } from "../core/match";

/** Messages exchanged with the matcher worker. The bitmaps are already resized for matching. */
export interface MatchRequest {
  id: number;
  reference: ImageBitmap;
  focus: Point;
  targets: ImageBitmap[];
}

export type MatchResponse =
  | { id: number; kind: "progress"; done: number; total: number }
  | { id: number; kind: "done"; outcomes: MatchOutcome[] }
  | { id: number; kind: "error"; message: string };
