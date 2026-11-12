/// Finds matching focus points off the main thread.
import { matchChains, type MatchImage, type PixelReader } from "./match-core";
import type { MatchRequest, MatchResponse } from "./match-protocol";

function reply(message: MatchResponse): void {
  self.postMessage(message);
}

const read: PixelReader = (image, width, height) => {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("OffscreenCanvas 2D context is unavailable");
  }
  context.drawImage(image, 0, 0, width, height);
  return context.getImageData(0, 0, width, height);
};

const asMatchImage = (bitmap: ImageBitmap): MatchImage => ({ image: bitmap, width: bitmap.width, height: bitmap.height });

self.addEventListener("message", (event: MessageEvent<MatchRequest>) => {
  const { id, images, chains } = event.data;
  try {
    const outcomes = matchChains(images.map(asMatchImage), chains, read, (done, total) => reply({ id, kind: "progress", done, total }));
    reply({ id, kind: "done", outcomes });
  } catch (error) {
    reply({ id, kind: "error", message: error instanceof Error ? error.message : String(error) });
  } finally {
    for (const image of images) {
      image.close();
    }
  }
});
