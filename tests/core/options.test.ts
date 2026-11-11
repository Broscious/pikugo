import { describe, expect, it } from "vitest";
import {
  DEFAULT_OPTIONS,
  FRAME_DELAY_MAX,
  FRAME_DELAY_MIN,
  frameSequence,
  layoutOptionsFrom,
  parseAspectRatio,
  sanitizeOptions,
} from "../../src/core/options";
import { planAnimation } from "../../src/core/plan";

describe("parseAspectRatio", () => {
  it.each([
    ["16:9", 16 / 9],
    ["4/3", 4 / 3],
    ["3x2", 1.5],
    [" 1 : 1 ", 1],
    ["1.91:1", 1.91],
    ["2.35", 2.35],
  ])("parses %s", (text, expected) => {
    expect(parseAspectRatio(text)).toBeCloseTo(expected);
  });

  it.each(["free", "", "Auto"])("treats %j as no constraint", (text) => {
    expect(parseAspectRatio(text)).toBeNull();
  });

  it.each(["0:1", "1:0", "wide", "-1", "16:9:1", "1000:1"])("rejects %j", (text) => {
    expect(parseAspectRatio(text)).toBeUndefined();
  });
});

describe("sanitizeOptions", () => {
  it("defaults to a 100ms frame delay", () => {
    expect(DEFAULT_OPTIONS.frameDelay).toBe(100);
    expect(sanitizeOptions(undefined)).toEqual(DEFAULT_OPTIONS);
  });

  it("keeps valid values", () => {
    const options = {
      frameDelay: 250,
      playback: "bounce",
      edges: "layer",
      aspect: "4:5",
      anchor: { x: 0.25, y: 0.75 },
      maxEdge: null,
      quality: 0.5,
    };
    expect(sanitizeOptions(options)).toEqual(options);
  });

  it("clamps and repairs invalid values", () => {
    const result = sanitizeOptions({
      frameDelay: 1,
      playback: "sideways",
      edges: 3,
      aspect: "nonsense",
      anchor: { x: 5, y: -1 },
      maxEdge: 2,
      quality: 9,
    });
    expect(result).toEqual({
      frameDelay: FRAME_DELAY_MIN,
      playback: "loop",
      edges: "crop",
      aspect: "free",
      anchor: { x: 1, y: 0 },
      maxEdge: DEFAULT_OPTIONS.maxEdge,
      quality: 1,
    });
    expect(sanitizeOptions({ frameDelay: 1e9 }).frameDelay).toBe(FRAME_DELAY_MAX);
  });

  it("drops incomplete anchors", () => {
    expect(sanitizeOptions({ anchor: { x: 0.5 } }).anchor).toBeNull();
  });
});

describe("layoutOptionsFrom", () => {
  it("converts the aspect text to a ratio", () => {
    expect(layoutOptionsFrom({ ...DEFAULT_OPTIONS, aspect: "2:1" }).aspectRatio).toBe(2);
    expect(layoutOptionsFrom({ ...DEFAULT_OPTIONS, aspect: "bad" }).aspectRatio).toBeNull();
  });
});

describe("frameSequence", () => {
  it("loops forwards", () => {
    expect(frameSequence(4, "loop")).toEqual([0, 1, 2, 3]);
  });

  it("bounces without doubling the end frames", () => {
    expect(frameSequence(4, "bounce")).toEqual([0, 1, 2, 3, 2, 1]);
    expect(frameSequence(3, "bounce")).toEqual([0, 1, 2, 1]);
  });

  it("does not bounce one or two frames", () => {
    expect(frameSequence(2, "bounce")).toEqual([0, 1]);
    expect(frameSequence(1, "bounce")).toEqual([0]);
    expect(frameSequence(0, "bounce")).toEqual([]);
  });
});

describe("planAnimation", () => {
  const sources = [
    { width: 4000, height: 3000, focus: { x: 2000, y: 1500 } },
    { width: 4000, height: 3000, focus: { x: 2100, y: 1500 } },
    { width: 4000, height: 3000, focus: { x: 2200, y: 1500 } },
  ];

  it("scales the layout to the requested longest edge", () => {
    const plan = planAnimation(sources, { ...DEFAULT_OPTIONS, maxEdge: 1000 });
    expect(plan.layout.width).toBe(3800);
    expect(plan.output.width).toBe(1000);
    expect(plan.output.height).toBe(Math.round(3000 * (1000 / 3800)));
  });

  it("computes the loop duration from the delay and sequence", () => {
    const plan = planAnimation(sources, { ...DEFAULT_OPTIONS, frameDelay: 120, playback: "bounce" });
    expect(plan.sequence).toEqual([0, 1, 2, 1]);
    expect(plan.durationMs).toBe(480);
  });
});
