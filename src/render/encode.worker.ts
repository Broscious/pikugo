/// Encodes animation frames and stills on an OffscreenCanvas, off the main thread.
import { resultBuffers, runTask, type FrameSurface } from "./encode-core";
import type { EncodeRequest, EncodeResponse } from "./protocol";

function reply(message: EncodeResponse, transfer: Transferable[] = []): void {
  self.postMessage(message, { transfer });
}

self.addEventListener("message", (event: MessageEvent<EncodeRequest>) => {
  const { id, images, ...task } = event.data;
  void (async () => {
    try {
      const canvas = new OffscreenCanvas(task.plan.output.width, task.plan.output.height);
      const context = canvas.getContext("2d");
      if (!context) {
        throw new Error("OffscreenCanvas 2D context is unavailable");
      }
      const surface: FrameSurface = {
        context,
        toBlob: (type, quality) => canvas.convertToBlob({ type, quality }),
      };
      const result = await runTask(images, task, surface, (done, total) => reply({ id, kind: "progress", done, total }));
      reply({ id, kind: "done", result }, resultBuffers(result));
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      reply({ id, kind: "error", name: err.name, message: err.message });
    } finally {
      for (const image of images) {
        image.close();
      }
    }
  })();
});
