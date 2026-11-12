import type { MatchOutcome } from "../core/match";
import type { MatchChain } from "./match-core";

/** Messages exchanged with the matcher worker. The bitmaps are already resized for matching. */
export interface MatchRequest {
  id: number;
  /** Every photo the chains refer to, each sent once. */
  images: ImageBitmap[];
  chains: MatchChain[];
}

export type MatchResponse =
  | { id: number; kind: "progress"; done: number; total: number }
  | { id: number; kind: "done"; outcomes: MatchOutcome[][] }
  | { id: number; kind: "error"; message: string };
