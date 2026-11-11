import type { EncodePlan } from "./encode-core";

/** Messages exchanged with the encoder worker. */
export interface EncodeRequest {
  id: number;
  images: ImageBitmap[];
  plan: EncodePlan;
}

export type EncodeResponse =
  | { id: number; kind: "progress"; done: number; total: number }
  | { id: number; kind: "done"; bytes: Uint8Array<ArrayBuffer>; frameCount: number }
  | { id: number; kind: "error"; name: string; message: string };
