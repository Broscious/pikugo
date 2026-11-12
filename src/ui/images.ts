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
    autoMatch: null,
  };
}

export function disposeImage(image: SourceImage): void {
  URL.revokeObjectURL(image.url);
  image.bitmap.close();
}

export function isImageFile(file: File): boolean {
  return file.type.startsWith("image/") || /\.(avif|bmp|gif|heic|heif|jpe?g|png|svg|webp)$/i.test(file.name);
}

interface SampleShot {
  /** Camera position along the line it moves on, from -1 (left) to 1 (right). */
  view: number;
  width: number;
  height: number;
  /** Where the subject lands in this shot. Framing differs a little from shot to shot, as it would handheld. */
  subject: { x: number; y: number };
}

/** Three shots taken from points along a line, each framed slightly differently. */
const SAMPLE_SHOTS: SampleShot[] = [
  { view: -1, width: 960, height: 680, subject: { x: 430, y: 410 } },
  { view: 0, width: 1000, height: 640, subject: { x: 520, y: 380 } },
  { view: 1, width: 940, height: 700, subject: { x: 500, y: 440 } },
];

/*
 * The scene is drawn around the subject: (0, 0) is its centre. The camera
 * moves sideways without turning, so once the shots are lined up on the
 * subject, everything else shifts according to how much nearer or further it is:
 *   shift = view × PARALLAX × (1 − subjectDistance / distance)
 * Distant things (factor near 1) move with the camera, things in front of the
 * subject (negative factor) move against it, and the subject itself stays put.
 */
const PARALLAX = 46;
const HORIZON = -150;
/** Where the subject stands on the ground. */
const BASE = 66;

/**
 * Depth factor (see above) for a point on the ground at height `y`. Distance
 * along the ground is proportional to 1 / (y − horizon), which makes the
 * factor 1 at the horizon, 0 at the subject's feet and negative in front of it.
 */
function groundDepth(y: number): number {
  return 1 - (y - HORIZON) / (BASE - HORIZON);
}

/** Deterministic pseudo-random numbers, so every load draws the same scene. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 16807) % 2147483647;
    return state / 2147483647;
  };
}

function drawSample(context: CanvasRenderingContext2D, shot: SampleShot): void {
  const shift = (depth: number) => shot.view * PARALLAX * depth;
  // Scene extents around the subject, with room for the parallax shifts.
  const left = -shot.subject.x - 200;
  const right = shot.width - shot.subject.x + 200;
  const top = -shot.subject.y;
  const bottom = shot.height - shot.subject.y;
  context.save();
  context.translate(shot.subject.x, shot.subject.y);

  const sky = context.createLinearGradient(0, top, 0, HORIZON);
  sky.addColorStop(0, "#7fb8ff");
  sky.addColorStop(0.7, "#c9b6ff");
  sky.addColorStop(1, "#ffc2d1");
  context.fillStyle = sky;
  context.fillRect(left, top, right - left, HORIZON - top);

  // Far layer: the sun and mountains are effectively at infinity.
  const far = shift(1);
  context.fillStyle = "#fff1b8";
  context.beginPath();
  context.arc(-250 + far, -320, 50, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "#8e7fd6";
  context.beginPath();
  context.moveTo(-800 + far, HORIZON + 2);
  for (let x = -800, i = 0; x <= 800; x += 120, i += 1) {
    context.lineTo(x + far, HORIZON - 90 - ((i * 53) % 80));
    context.lineTo(x + 60 + far, HORIZON - 30);
  }
  context.lineTo(860 + far, HORIZON + 2);
  context.closePath();
  context.fill();

  const ground = context.createLinearGradient(0, HORIZON, 0, bottom);
  ground.addColorStop(0, "#7fd0a8");
  ground.addColorStop(1, "#3fa97a");
  context.fillStyle = ground;
  context.fillRect(left, HORIZON, right - left, bottom - HORIZON);

  // Pebbles scattered over the ground, smaller and closer together towards the horizon.
  const next = random(11);
  const pebbles = Array.from({ length: 90 }, () => {
    const t = next();
    return { x: (next() - 0.5) * 1600, y: HORIZON + 6 + t * t * (bottom - HORIZON), size: next() };
  });
  const drawPebble = (pebble: (typeof pebbles)[number]) => {
    const scale = (pebble.y - HORIZON) / (BASE - HORIZON);
    const x = pebble.x * scale + shift(groundDepth(pebble.y));
    context.fillStyle = pebble.size > 0.5 ? "#2f8f68" : "#a3e0c0";
    context.beginPath();
    context.ellipse(x, pebble.y, (3 + pebble.size * 6) * scale, (1.2 + pebble.size * 2.2) * scale, 0, 0, Math.PI * 2);
    context.fill();
  };
  pebbles.filter((pebble) => pebble.y < BASE).forEach(drawPebble);

  // Shadow: the light is behind the camera, so the shadow always falls
  // straight back towards the horizon. Its far end is deeper than the subject,
  // so it shifts with the camera and the shadow seems to lean out to one side.
  const bodyW = 120;
  const bodyH = 132;
  const tipY = -118;
  // Perspective narrows the far end; a light close behind the camera spreads it again a little.
  const tipScale = 0.4;
  const tipX = shift(groundDepth(tipY));
  const shadow = context.createLinearGradient(0, BASE, 0, tipY);
  shadow.addColorStop(0, "rgba(20, 10, 40, 0.45)");
  shadow.addColorStop(1, "rgba(20, 10, 40, 0.15)");
  context.fillStyle = shadow;
  context.beginPath();
  context.moveTo(-bodyW / 2, BASE);
  context.lineTo(tipX - (bodyW / 2) * tipScale, tipY);
  context.quadraticCurveTo(tipX, tipY - 12 * tipScale - 4, tipX + (bodyW / 2) * tipScale, tipY);
  context.lineTo(bodyW / 2, BASE);
  context.closePath();
  context.fill();

  // Subject, lit from the front. Without the camera turning, it looks the same in every shot.
  const bodyLeft = -bodyW / 2;
  const bodyTop = -bodyH / 2;
  const body = context.createLinearGradient(0, bodyTop, 0, bodyTop + bodyH);
  body.addColorStop(0, "#a58bff");
  body.addColorStop(1, "#5b38f0");
  context.fillStyle = "rgba(20, 10, 40, 0.3)";
  context.beginPath();
  context.ellipse(0, BASE, bodyW / 2 + 6, 8, 0, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = body;
  context.beginPath();
  context.roundRect(bodyLeft, bodyTop, bodyW, bodyH, [52, 52, 34, 34]);
  context.fill();
  for (const dx of [-24, 24]) {
    context.fillStyle = "#fff";
    context.beginPath();
    context.arc(dx, -12, 14, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = "#1b1830";
    context.beginPath();
    context.arc(dx + 3, -10, 6, 0, Math.PI * 2);
    context.fill();
  }

  pebbles.filter((pebble) => pebble.y >= BASE).forEach(drawPebble);

  // Near layer: grass right in front of the camera.
  const near = shift(-2.4);
  context.fillStyle = "#2f8f68";
  for (let x = left - 160; x < right + 160; x += 34) {
    const root = bottom - 20;
    context.beginPath();
    context.moveTo(x + near, root + 30);
    context.quadraticCurveTo(x + near + 10, root - 70, x + near + 24, root - 90 - ((Math.abs(x) * 7) % 40));
    context.quadraticCurveTo(x + near + 18, root - 40, x + near + 30, root + 30);
    context.fill();
  }
  context.restore();
}

/**
 * Generate three demo photos taken from points along a line, showing parallax
 * around the subject. Their sizes and framing differ a little, so the framing
 * options have something to show.
 */
export async function createSampleImages(): Promise<SourceImage[]> {
  return Promise.all(
    SAMPLE_SHOTS.map(async (shot, index) => {
      const canvas = document.createElement("canvas");
      canvas.width = shot.width;
      canvas.height = shot.height;
      const context = canvas.getContext("2d");
      if (!context) {
        throw new Error("Canvas is unavailable");
      }
      drawSample(context, shot);
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((result) => (result ? resolve(result) : reject(new Error("Couldn't create sample"))), "image/png"),
      );
      const image = await loadImageFile(Object.assign(blob, { name: `sample-${index + 1}.png` }));
      return { ...image, focus: { ...shot.subject }, focusSet: true };
    }),
  );
}
