/**
 * Find the spot in one photo that matches a point in another.
 *
 * A square patch around the reference point is compared against every
 * position in the target using normalized cross-correlation (NCC), which
 * ignores differences in brightness and contrast between the photos. To keep
 * it fast the search runs coarse-to-fine: a full scan on a small copy of the
 * images finds a few candidates, and each is then refined on progressively
 * larger copies with a small local search. The best candidate wins, with a
 * sub-pixel estimate from the shape of the score peak.
 */
import type { Point } from "./geometry";

/** Single-channel image with luminance values (0–255). */
export interface GrayImage {
  readonly width: number;
  readonly height: number;
  readonly data: Float32Array;
}

export interface MatchOptions {
  /** Patch radius as a fraction of the reference's shorter side. */
  patchFraction?: number;
  /** Bounds for the patch radius, in pixels at full resolution. */
  minRadius?: number;
  maxRadius?: number;
  /** Smallest patch radius worth searching with at the coarsest level. */
  coarseRadius?: number;
  /** How many coarse candidates to refine. */
  candidates?: number;
  /** Search distance (in pixels) around each candidate when refining. */
  refineRange?: number;
}

export type MatchFailure = "featureless" | "too-small";

export type MatchOutcome =
  | {
      ok: true;
      /** Matching point in target pixels. */
      point: Point;
      /** NCC score of the match, -1..1 (1 is a perfect match). */
      score: number;
      /** Best score of any clearly different location, to judge ambiguity. */
      runnerUp: number;
    }
  | { ok: false; reason: MatchFailure };

/** Matches scoring below this are treated as not found. */
export const MIN_MATCH_SCORE = 0.7;
/**
 * How much better the best location must be than any other, measured as the
 * ratio of their distances from a perfect score: (1 − runnerUp) / (1 − score).
 * Cluttered but unrelated photos can reach scores around 0.8 by chance, but
 * then other locations score almost as well; true matches stand out.
 */
export const MIN_MATCH_DISTINCTNESS = 2;
/** Patches with a lower standard deviation (in grey levels) have too little detail to match. */
export const MIN_PATCH_STDDEV = 2;

const DEFAULTS: Required<MatchOptions> = {
  patchFraction: 0.06,
  minRadius: 6,
  maxRadius: 64,
  coarseRadius: 4,
  candidates: 6,
  refineRange: 2,
};

/** Whether a match is good enough to use without asking the user. */
export function isConfident(outcome: MatchOutcome): boolean {
  return outcome.ok && outcome.score >= MIN_MATCH_SCORE && distinctness(outcome.score, outcome.runnerUp) >= MIN_MATCH_DISTINCTNESS;
}

/** (1 − runnerUp) / (1 − score): how far ahead of the next-best location the match is. */
export function distinctness(score: number, runnerUp: number): number {
  return score >= 1 ? Number.POSITIVE_INFINITY : (1 - Math.max(runnerUp, 0)) / (1 - score);
}

/** Convert RGBA pixels to luminance (Rec. 601 weights). */
export function grayFromRgba(rgba: ArrayLike<number>, width: number, height: number): GrayImage {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError("Image dimensions must be positive integers");
  }
  if (rgba.length < width * height * 4) {
    throw new RangeError("Not enough pixel data for the given dimensions");
  }
  const data = new Float32Array(width * height);
  for (let i = 0, j = 0; i < data.length; i += 1, j += 4) {
    data[i] = 0.299 * rgba[j]! + 0.587 * rgba[j + 1]! + 0.114 * rgba[j + 2]!;
  }
  return { width, height, data };
}

/** Halve an image by averaging 2×2 blocks (edge pixels are reused for odd sizes). */
export function downsample(image: GrayImage): GrayImage {
  const width = Math.max(1, Math.floor(image.width / 2));
  const height = Math.max(1, Math.floor(image.height / 2));
  const data = new Float32Array(width * height);
  const { data: source, width: sourceWidth } = image;
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.min(2 * y, image.height - 1) * sourceWidth;
    const y1 = Math.min(2 * y + 1, image.height - 1) * sourceWidth;
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.min(2 * x, image.width - 1);
      const x1 = Math.min(2 * x + 1, image.width - 1);
      data[y * width + x] = (source[y0 + x0]! + source[y0 + x1]! + source[y1 + x0]! + source[y1 + x1]!) / 4;
    }
  }
  return { width, height, data };
}

/** Summed-area tables of values and squared values, for O(1) window statistics. */
interface Integral {
  sum: Float64Array;
  squares: Float64Array;
  stride: number;
}

function integral(image: GrayImage): Integral {
  const stride = image.width + 1;
  const sum = new Float64Array(stride * (image.height + 1));
  const squares = new Float64Array(sum.length);
  for (let y = 0; y < image.height; y += 1) {
    let rowSum = 0;
    let rowSquares = 0;
    for (let x = 0; x < image.width; x += 1) {
      const value = image.data[y * image.width + x]!;
      rowSum += value;
      rowSquares += value * value;
      const index = (y + 1) * stride + x + 1;
      sum[index] = sum[index - stride]! + rowSum;
      squares[index] = squares[index - stride]! + rowSquares;
    }
  }
  return { sum, squares, stride };
}

interface Template {
  radius: number;
  /** Zero-mean patch values, row by row. */
  values: Float32Array;
  /** Euclidean norm of `values`. */
  norm: number;
}

function extractTemplate(image: GrayImage, cx: number, cy: number, radius: number): Template {
  const size = 2 * radius + 1;
  const values = new Float32Array(size * size);
  let mean = 0;
  for (let dy = 0, k = 0; dy < size; dy += 1) {
    const row = (cy - radius + dy) * image.width + cx - radius;
    for (let dx = 0; dx < size; dx += 1, k += 1) {
      values[k] = image.data[row + dx]!;
      mean += values[k]!;
    }
  }
  mean /= values.length;
  let energy = 0;
  for (let k = 0; k < values.length; k += 1) {
    values[k]! -= mean;
    energy += values[k]! * values[k]!;
  }
  return { radius, values, norm: Math.sqrt(energy) };
}

/** NCC between the template and the target window centred on (cx, cy). */
function nccAt(target: GrayImage, table: Integral, template: Template, cx: number, cy: number): number {
  const { radius, values } = template;
  const size = 2 * radius + 1;
  const count = size * size;
  const x0 = cx - radius;
  const y0 = cy - radius;
  const { sum, squares, stride } = table;
  const a = y0 * stride + x0;
  const b = a + size;
  const c = a + size * stride;
  const d = c + size;
  const windowSum = sum[d]! - sum[b]! - sum[c]! + sum[a]!;
  const windowSquares = squares[d]! - squares[b]! - squares[c]! + squares[a]!;
  const variance = windowSquares - (windowSum * windowSum) / count;
  if (variance <= 1e-6 * count || template.norm === 0) {
    return 0;
  }
  // The template is zero-mean, so the window's mean drops out of the cross term.
  let cross = 0;
  for (let dy = 0, k = 0; dy < size; dy += 1) {
    const row = (y0 + dy) * target.width + x0;
    for (let dx = 0; dx < size; dx += 1, k += 1) {
      cross += values[k]! * target.data[row + dx]!;
    }
  }
  return cross / (template.norm * Math.sqrt(variance));
}

/** Template placement for one pyramid level. */
interface LevelTemplate {
  template: Template;
  /** Reference point minus the template centre's pixel centre. */
  offset: Point;
}

function levelTemplate(image: GrayImage, point: Point, radius: number): LevelTemplate {
  const cx = Math.min(Math.max(Math.floor(point.x), radius), image.width - 1 - radius);
  const cy = Math.min(Math.max(Math.floor(point.y), radius), image.height - 1 - radius);
  return {
    template: extractTemplate(image, cx, cy, radius),
    offset: { x: point.x - (cx + 0.5), y: point.y - (cy + 0.5) },
  };
}

interface Candidate {
  /** Template centre in the current level's pixels. */
  cx: number;
  cy: number;
  score: number;
}

function fits(image: GrayImage, radius: number): boolean {
  return image.width >= 2 * radius + 1 && image.height >= 2 * radius + 1;
}

/** Scan every position and return the strongest well-separated local peaks. */
function coarseCandidates(target: GrayImage, table: Integral, template: Template, limit: number): Candidate[] {
  const { radius } = template;
  const width = target.width - 2 * radius;
  const height = target.height - 2 * radius;
  const scores = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      scores[y * width + x] = nccAt(target, table, template, x + radius, y + radius);
    }
  }
  const peaks: Candidate[] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const score = scores[y * width + x]!;
      let isPeak = true;
      for (let ny = Math.max(0, y - 1); isPeak && ny <= Math.min(height - 1, y + 1); ny += 1) {
        for (let nx = Math.max(0, x - 1); nx <= Math.min(width - 1, x + 1); nx += 1) {
          if (scores[ny * width + nx]! > score) {
            isPeak = false;
            break;
          }
        }
      }
      if (isPeak) {
        peaks.push({ cx: x + radius, cy: y + radius, score });
      }
    }
  }
  peaks.sort((a, b) => b.score - a.score);
  const chosen: Candidate[] = [];
  for (const peak of peaks) {
    if (chosen.every((other) => Math.hypot(other.cx - peak.cx, other.cy - peak.cy) > radius)) {
      chosen.push(peak);
      if (chosen.length === limit) {
        break;
      }
    }
  }
  return chosen;
}

/** Best position within `range` pixels of (cx, cy). */
function refine(target: GrayImage, table: Integral, template: Template, cx: number, cy: number, range: number): Candidate {
  const { radius } = template;
  let best: Candidate = { cx, cy, score: -Infinity };
  for (let y = Math.max(radius, cy - range); y <= Math.min(target.height - 1 - radius, cy + range); y += 1) {
    for (let x = Math.max(radius, cx - range); x <= Math.min(target.width - 1 - radius, cx + range); x += 1) {
      const score = nccAt(target, table, template, x, y);
      if (score > best.score) {
        best = { cx: x, cy: y, score };
      }
    }
  }
  return best;
}

/** Vertex of the parabola through three equally spaced scores, as an offset from the middle one. */
export function parabolicPeak(before: number, centre: number, after: number): number {
  const curvature = before - 2 * centre + after;
  if (!(curvature < 0)) {
    return 0;
  }
  // `|| 0` turns -0 into 0.
  return Math.min(0.5, Math.max(-0.5, (before - after) / (2 * curvature))) || 0;
}

/**
 * Find where `point` in `reference` appears in `target`. Both images should
 * show the scene at roughly the same scale (resize them to the same size first).
 */
export function matchPoint(reference: GrayImage, point: Point, target: GrayImage, options: MatchOptions = {}): MatchOutcome {
  const settings = { ...DEFAULTS, ...options };
  const radius = Math.round(
    Math.min(settings.maxRadius, Math.max(settings.minRadius, settings.patchFraction * Math.min(reference.width, reference.height))),
  );
  if (!fits(reference, radius) || !fits(target, radius)) {
    return { ok: false, reason: "too-small" };
  }
  const anchor = {
    x: Math.min(Math.max(point.x, 0), reference.width),
    y: Math.min(Math.max(point.y, 0), reference.height),
  };

  // Build matching pyramids, stopping when the patch would get too small to be distinctive.
  const references = [reference];
  const targets = [target];
  const radii = [radius];
  while (true) {
    const nextRadius = Math.round(radii.at(-1)! / 2);
    const nextReference = downsample(references.at(-1)!);
    const nextTarget = downsample(targets.at(-1)!);
    if (nextRadius < settings.coarseRadius || !fits(nextReference, nextRadius) || !fits(nextTarget, nextRadius)) {
      break;
    }
    references.push(nextReference);
    targets.push(nextTarget);
    radii.push(nextRadius);
  }

  const templates = references.map((image, level) =>
    levelTemplate(image, { x: anchor.x / 2 ** level, y: anchor.y / 2 ** level }, radii[level]!),
  );
  const finest = templates[0]!.template;
  if (finest.norm / Math.sqrt(finest.values.length) < MIN_PATCH_STDDEV) {
    return { ok: false, reason: "featureless" };
  }

  const coarsest = targets.length - 1;
  const tables = targets.map(integral);
  let candidates = coarseCandidates(targets[coarsest]!, tables[coarsest]!, templates[coarsest]!.template, settings.candidates);

  // Refine every candidate down to full resolution, tracking the predicted point (not the patch centre),
  // since the patch may sit off-centre near the image edges.
  for (let level = coarsest - 1; level >= 0; level -= 1) {
    const from = templates[level + 1]!.offset;
    const to = templates[level]!.offset;
    candidates = candidates.map((candidate) => {
      const predicted = { x: 2 * (candidate.cx + 0.5 + from.x), y: 2 * (candidate.cy + 0.5 + from.y) };
      const cx = Math.round(predicted.x - to.x - 0.5);
      const cy = Math.round(predicted.y - to.y - 0.5);
      return refine(targets[level]!, tables[level]!, templates[level]!.template, cx, cy, settings.refineRange);
    });
  }

  const pointOf = (candidate: Candidate) => ({
    x: candidate.cx + 0.5 + templates[0]!.offset.x,
    y: candidate.cy + 0.5 + templates[0]!.offset.y,
  });
  const ranked = [...candidates].sort((a, b) => b.score - a.score);
  const best = ranked[0]!;
  const bestPoint = pointOf(best);
  const runnerUp = ranked
    .slice(1)
    .filter((candidate) => {
      const other = pointOf(candidate);
      return Math.hypot(other.x - bestPoint.x, other.y - bestPoint.y) > radius;
    })
    .reduce((max, candidate) => Math.max(max, candidate.score), 0);

  // Sub-pixel refinement from the neighbouring scores.
  const score = (x: number, y: number) =>
    x >= radius && y >= radius && x < target.width - radius && y < target.height - radius
      ? nccAt(target, tables[0]!, finest, x, y)
      : Number.NaN;
  const dx = parabolicPeak(score(best.cx - 1, best.cy), best.score, score(best.cx + 1, best.cy));
  const dy = parabolicPeak(score(best.cx, best.cy - 1), best.score, score(best.cx, best.cy + 1));

  return {
    ok: true,
    point: {
      x: Math.min(Math.max(bestPoint.x + dx, 0), target.width),
      y: Math.min(Math.max(bestPoint.y + dy, 0), target.height),
    },
    score: best.score,
    runnerUp,
  };
}
