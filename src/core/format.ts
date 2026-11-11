export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "–";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

export function formatMilliseconds(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)} ms`;
  }
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

export function formatFps(frameDelay: number): string {
  const fps = 1000 / frameDelay;
  return `${fps >= 10 ? Math.round(fps) : fps.toFixed(1)} fps`;
}

export function formatPercent(fraction: number, digits = 0): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** Render pixel dimensions as a small ratio when one exists ("1920 × 1080" → "16:9"). */
export function formatAspect(width: number, height: number): string {
  const divisor = gcd(Math.round(width), Math.round(height)) || 1;
  const w = Math.round(width) / divisor;
  const h = Math.round(height) / divisor;
  if (w <= 32 && h <= 32) {
    return `${w}:${h}`;
  }
  return `${(width / height).toFixed(2)}:1`;
}

export function timestampedFilename(prefix: string, extension: string, date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `${prefix}-${stamp}.${extension}`;
}

/**
 * File name for one exported still: a zero-padded position (so the files sort
 * in animation order) followed by a filesystem-safe version of the photo name.
 */
export function stillFilename(index: number, count: number, sourceName: string, extension = "png"): string {
  const width = Math.max(2, String(count).length);
  const base =
    sourceName
      // Drop the extension (only from the last path segment).
      .replace(/\.[^./]*$/, "")
      // Decompose and drop accents: "café" → "cafe".
      .normalize("NFKD")
      .replace(/\p{M}+/gu, "")
      .replace(/[^\w.-]+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .slice(0, 60) || "frame";
  return `${String(index + 1).padStart(width, "0")}-${base}.${extension}`;
}
