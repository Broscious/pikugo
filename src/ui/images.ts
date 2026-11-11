import type { SourceImage } from "./state";

let nextId = 1;

/** Decode an image file. The focal point starts at the centre. */
export async function loadImageFile(file: Blob & { name?: string }): Promise<SourceImage> {
  const name = file.name ?? "image";
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error(`Couldn't read “${name}”. Is it an image format your browser supports?`);
  }
  return {
    id: `img-${nextId++}`,
    name,
    url: URL.createObjectURL(file),
    bitmap,
    width: bitmap.width,
    height: bitmap.height,
    focus: { x: Math.round(bitmap.width / 2), y: Math.round(bitmap.height / 2) },
    focusSet: false,
  };
}

export function disposeImage(image: SourceImage): void {
  URL.revokeObjectURL(image.url);
  image.bitmap.close();
}

export function isImageFile(file: File): boolean {
  return file.type.startsWith("image/") || /\.(avif|bmp|gif|heic|heif|jpe?g|png|svg|webp)$/i.test(file.name);
}

interface SampleSpec {
  width: number;
  height: number;
  /** Where the subject sits in this shot (handheld drift). */
  subject: { x: number; y: number };
  /** Camera position: background and foreground shift in opposite directions. */
  parallax: number;
}

const SAMPLES: SampleSpec[] = [
  { width: 960, height: 680, subject: { x: 430, y: 410 }, parallax: -1 },
  { width: 1000, height: 640, subject: { x: 520, y: 380 }, parallax: 0 },
  { width: 940, height: 700, subject: { x: 500, y: 440 }, parallax: 1 },
];

function drawSample(context: CanvasRenderingContext2D, spec: SampleSpec): void {
  const { width, height, subject, parallax } = spec;
  const horizon = subject.y + 30;

  const sky = context.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, "#7fb8ff");
  sky.addColorStop(0.55, "#c9b6ff");
  sky.addColorStop(1, "#ffc2d1");
  context.fillStyle = sky;
  context.fillRect(0, 0, width, height);

  // Far layer: sun and mountains move with the camera.
  const far = parallax * -38;
  context.fillStyle = "#fff1b8";
  context.beginPath();
  context.arc(subject.x + 260 + far, subject.y - 250, 54, 0, Math.PI * 2);
  context.fill();

  context.fillStyle = "#8e7fd6";
  context.beginPath();
  context.moveTo(-50, horizon);
  for (let x = -50, i = 0; x <= width + 100; x += 120, i += 1) {
    context.lineTo(x + far, horizon - 150 - ((i * 53) % 90));
    context.lineTo(x + 60 + far, horizon - 60);
  }
  context.lineTo(width + 100, horizon);
  context.closePath();
  context.fill();

  context.fillStyle = "#4fb98b";
  context.fillRect(0, horizon - 4, width, height - horizon + 4);

  // Subject: the focal point everything lines up on.
  const bodyW = 120;
  const bodyH = 132;
  const left = subject.x - bodyW / 2;
  const top = subject.y - bodyH / 2;
  const body = context.createLinearGradient(left, top, left + bodyW, top + bodyH);
  body.addColorStop(0, "#9b7dff");
  body.addColorStop(1, "#5b38f0");
  context.fillStyle = "rgba(20, 10, 40, 0.18)";
  context.beginPath();
  context.ellipse(subject.x, top + bodyH + 6, 70, 12, 0, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = body;
  context.beginPath();
  context.roundRect(left, top, bodyW, bodyH, [52, 52, 34, 34]);
  context.fill();
  for (const dx of [-24, 24]) {
    context.fillStyle = "#fff";
    context.beginPath();
    context.arc(subject.x + dx, subject.y - 12, 14, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = "#1b1830";
    context.beginPath();
    context.arc(subject.x + dx + 3, subject.y - 10, 6, 0, Math.PI * 2);
    context.fill();
  }

  // Near layer: grass moves against the camera.
  const near = parallax * 46;
  context.fillStyle = "#2f8f68";
  for (let x = -60; x < width + 60; x += 34) {
    const base = height - 20;
    context.beginPath();
    context.moveTo(x + near, base + 30);
    context.quadraticCurveTo(x + near + 10, base - 70, x + near + 24, base - 90 - ((x * 7) % 40));
    context.quadraticCurveTo(x + near + 18, base - 40, x + near + 30, base + 30);
    context.fill();
  }
}

/** Generate three demo photos with deliberate drift, so the framing options have something to show. */
export async function createSampleImages(): Promise<SourceImage[]> {
  return Promise.all(
    SAMPLES.map(async (spec, index) => {
      const canvas = document.createElement("canvas");
      canvas.width = spec.width;
      canvas.height = spec.height;
      const context = canvas.getContext("2d");
      if (!context) {
        throw new Error("Canvas is unavailable");
      }
      drawSample(context, spec);
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((result) => (result ? resolve(result) : reject(new Error("Couldn't create sample"))), "image/png"),
      );
      const image = await loadImageFile(Object.assign(blob, { name: `sample-${index + 1}.png` }));
      return { ...image, focus: { ...spec.subject }, focusSet: true };
    }),
  );
}
