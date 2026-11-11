import type { EncodeTask, TaskResult } from "./encode-core";

/** Messages exchanged with the encoder worker. */
export type EncodeRequest = { id: number; images: ImageBitmap[] } & EncodeTask;

export type EncodeResponse =
  | { id: number; kind: "progress"; done: number; total: number }
  | { id: number; kind: "done"; result: TaskResult }
  | { id: number; kind: "error"; name: string; message: string };
