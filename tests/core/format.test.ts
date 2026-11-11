import { describe, expect, it } from "vitest";
import { formatAspect, formatBytes, formatFps, formatMilliseconds, formatPercent, timestampedFilename } from "../../src/core/format";

describe("format helpers", () => {
  it("formats byte sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(250 * 1024)).toBe("250 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(-1)).toBe("–");
  });

  it("formats durations", () => {
    expect(formatMilliseconds(84.4)).toBe("84 ms");
    expect(formatMilliseconds(1234)).toBe("1.23 s");
    expect(formatMilliseconds(12_345)).toBe("12.3 s");
  });

  it("formats frame rates", () => {
    expect(formatFps(100)).toBe("10 fps");
    expect(formatFps(250)).toBe("4.0 fps");
  });

  it("formats percentages", () => {
    expect(formatPercent(0.256)).toBe("26%");
    expect(formatPercent(0.256, 1)).toBe("25.6%");
  });

  it("reduces dimensions to a ratio", () => {
    expect(formatAspect(1920, 1080)).toBe("16:9");
    expect(formatAspect(500, 500)).toBe("1:1");
    expect(formatAspect(1001, 500)).toBe("2.00:1");
  });

  it("builds timestamped filenames", () => {
    expect(timestampedFilename("pikugo", "webp", new Date(2026, 0, 2, 3, 4, 5))).toBe("pikugo-20260102-030405.webp");
  });
});
