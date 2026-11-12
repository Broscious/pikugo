import { describe, expect, it } from "vitest";
import { DEFAULT_OPTIONS } from "../../src/core/options";
import { describePreview } from "../../src/ui/preview";
import { createAppStore, effectiveOptions, planMatches, signatureOf, tryPlan, type SourceImage } from "../../src/ui/state";

function image(id: string, x: number, y: number): SourceImage {
  return { id, name: `${id}.png`, url: "", bitmap: {} as ImageBitmap, width: 100, height: 80, focus: { x, y }, focusSet: true, autoMatch: null };
}

describe("tryPlan", () => {
  it("asks for photos when there are none", () => {
    expect(tryPlan([], DEFAULT_OPTIONS)).toEqual({ plan: null, error: "Add some photos to get started." });
  });

  it("returns a plan for valid input", () => {
    const result = tryPlan([image("a", 50, 40), image("b", 60, 40)], DEFAULT_OPTIONS);
    expect(result.error).toBeNull();
    expect(result.plan?.layout.width).toBe(90);
  });

  it("turns layout failures into messages", () => {
    const result = tryPlan([image("a", 0, 40), image("b", 100, 40)], DEFAULT_OPTIONS);
    expect(result.plan).toBeNull();
    expect(result.error).toMatch(/do not overlap/);
  });
});

describe("effectiveOptions", () => {
  it("applies hover previews on top of the saved options", () => {
    const store = createAppStore();
    expect(effectiveOptions(store.state)).toBe(store.state.options);
    store.set({ hoverOptions: { edges: "layer" } });
    expect(effectiveOptions(store.state)).toEqual({ ...DEFAULT_OPTIONS, edges: "layer" });
    expect(store.state.options.edges).toBe("crop");
  });
});

describe("signatureOf", () => {
  it("changes when focus, order or options change", () => {
    const a = image("a", 10, 10);
    const b = image("b", 20, 20);
    const base = signatureOf({ images: [a, b], options: DEFAULT_OPTIONS });
    expect(signatureOf({ images: [a, b], options: { ...DEFAULT_OPTIONS } })).toBe(base);
    expect(signatureOf({ images: [b, a], options: DEFAULT_OPTIONS })).not.toBe(base);
    expect(signatureOf({ images: [a, { ...b, focus: { x: 21, y: 20 } }], options: DEFAULT_OPTIONS })).not.toBe(base);
    expect(signatureOf({ images: [a, b], options: { ...DEFAULT_OPTIONS, frameDelay: 120 } })).not.toBe(base);
    // The stills format only affects the stills export, so the animation is still current.
    expect(signatureOf({ images: [a, b], options: { ...DEFAULT_OPTIONS, stillFormat: "jpeg" } })).toBe(base);
  });
});

describe("describePreview", () => {
  it.each([
    [{ edges: "layer" as const }, "Layer with transparency"],
    [{ aspect: "16:9" }, "Aspect 16:9"],
    [{ aspect: "free" }, "Free aspect ratio"],
    [{ anchor: { x: 0.25, y: 1 } }, "Focus at 25%, 100%"],
    [{ anchor: null }, "Automatic focus position"],
    [{ frameDelay: 150 }, "150 ms per frame"],
    [{ playback: "bounce" as const }, "Bounce playback"],
    [{ playback: "smooth" as const }, "Sway playback"],
    [{ playback: "loop" as const }, "Loop playback"],
    [{ maxEdge: null }, "Original size"],
  ])("describes %j", (patch, text) => {
    expect(describePreview(patch)).toBe(text);
  });
});

describe("planMatches", () => {
  // "m" is placed by hand, "a" was auto-matched, "-" has no point yet.
  const photos = (kinds: string) =>
    [...kinds].map((kind, i) => ({
      ...image(String(i), 10, 10),
      focusSet: kind !== "-",
      autoMatch: kind === "a" ? { score: 0.9, referenceId: "x" } : null,
    }));

  it("needs a hand-placed photo", () => {
    expect(planMatches(photos("-a-"))).toEqual([]);
  });

  it("matches outward from the hand-placed photos, each up to the next one", () => {
    expect(planMatches(photos("-a-m-a"))).toEqual([
      { start: 3, targets: [2, 1, 0] },
      { start: 3, targets: [4, 5] },
    ]);
    expect(planMatches(photos("m-m--m"))).toEqual([
      { start: 0, targets: [1] },
      { start: 2, targets: [3, 4] },
    ]);
    expect(planMatches(photos("mm"))).toEqual([]);
  });
});
