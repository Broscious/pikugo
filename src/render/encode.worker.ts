/// Encodes animation frames on an OffscreenCanvas, off the main thread.
import { encodeAnimation, type FrameSurface } from "./encode-core";
import type { EncodeRequest, EncodeResponse } from "./protocol";

function reply(message: EncodeResponse, transfer: Transferable[] = []): void {
  self.postMessage(message, { transfer });
}

self.addEventListener("message", (event: MessageEvent<EncodeRequest>) => {
  const { id, images, plan } = event.data;
  void (async () => {
    try {
      const canvas = new OffscreenCanvas(plan.output.width, plan.output.height);
      const context = canvas.getContext("2d");
      if (!context) {
        throw new Error("OffscreenCanvas 2D context is unavailable");
      }
      const surface: FrameSurface = {
        context,
        toBlob: (type, quality) => canvas.convertToBlob({ type, quality }),
      };
      const result = await encodeAnimation(images, plan, surface, (done, total) =>
        reply({ id, kind: "progress", done, total }),
      );
      reply({ id, kind: "done", bytes: result.bytes, frameCount: result.frameCount }, [result.bytes.buffer]);
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
