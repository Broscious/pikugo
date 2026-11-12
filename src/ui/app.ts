import { stillFilename, timestampedFilename } from "../core/format";
import { STILL_FORMATS, STILL_MATTE } from "../core/options";
import { createZip } from "../core/zip";
import type { Point } from "../core/geometry";
import { encodeWebP, renderStillFrames } from "../render/encoder";
import { matchFocus, type FocusMatch } from "../render/matcher";
import { byId } from "./dom";
import { Filmstrip } from "./filmstrip";
import { FocusEditor } from "./focus-editor";
import { createSampleImages, disposeImage, isImageFile, loadImageFile } from "./images";
import { OptionsPanel } from "./options-panel";
import { loadAutoMatch, loadOptions, saveAutoMatch, saveOptions, setupThemeToggle } from "./persistence";
import { Preview } from "./preview";
import { createAppStore, isManualFocus, planMatches, signatureOf, tryPlan, type AppStore, type SourceImage } from "./state";
import { ResultView, Stepper, Summary } from "./status";
import { toast } from "./toast";

/** Wires the page together. */
export class App {
  readonly store: AppStore;
  readonly #fileInput = byId("fileInput", HTMLInputElement);
  readonly #hero = byId("hero", HTMLElement);
  readonly #workspace = byId("workspace", HTMLElement);
  readonly #dropOverlay = byId("dropOverlay", HTMLDivElement);
  readonly #options: OptionsPanel;
  readonly #autoMatchToggle = byId("autoMatchToggle", HTMLButtonElement);
  #autoMatch = loadAutoMatch();
  #matchTimer: ReturnType<typeof setTimeout> | undefined;
  /** Incremented for every matching run, so results from superseded runs are dropped. */
  #matchRun = 0;

  constructor() {
    this.store = createAppStore(loadOptions());
    setupThemeToggle();
    new FocusEditor(this.store, () => {
      // Wait for the user to stop clicking or nudging before matching.
      this.#scheduleMatch(350);
    });
    new Filmstrip(this.store, {
      addFiles: () => this.#fileInput.click(),
      remove: (id) => this.#remove(id),
      move: (id, offset) => this.#move(id, offset),
      clear: () => this.#clear(),
    });
    this.#options = new OptionsPanel(this.store);
    new Preview(this.store, (anchor: Point) => this.#options.update({ anchor }));
    new Summary(this.store);
    new Stepper(this.store);
    new ResultView(this.store);

    this.store.subscribe((state, previous) => {
      if (state.options !== previous.options) {
        saveOptions(state.options);
      }
      if (state.images.length !== previous.images.length) {
        this.#hero.hidden = state.images.length > 0;
        this.#workspace.hidden = state.images.length === 0;
      }
    });
    this.#bind();
  }

  #bind(): void {
    this.#autoMatchToggle.setAttribute("aria-pressed", String(this.#autoMatch));
    this.#autoMatchToggle.addEventListener("click", () => {
      this.#autoMatch = !this.#autoMatch;
      this.#autoMatchToggle.setAttribute("aria-pressed", String(this.#autoMatch));
      saveAutoMatch(this.#autoMatch);
      if (this.#autoMatch) {
        this.#scheduleMatch(0);
      } else {
        clearTimeout(this.#matchTimer);
        this.#matchRun += 1;
        this.store.set({ matching: null });
      }
    });
    byId("chooseFilesBtn", HTMLButtonElement).addEventListener("click", () => this.#fileInput.click());
    byId("sampleBtn", HTMLButtonElement).addEventListener("click", () => void this.#loadSamples());
    byId("generateBtn", HTMLButtonElement).addEventListener("click", () => void this.generate());
    byId("stillsBtn", HTMLButtonElement).addEventListener("click", () => void this.exportStills());
    this.#fileInput.addEventListener("change", () => {
      const files = [...(this.#fileInput.files ?? [])];
      this.#fileInput.value = "";
      void this.addFiles(files);
    });

    // Drop files anywhere on the page.
    let dragDepth = 0;
    const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes("Files") ?? false;
    window.addEventListener("dragenter", (event) => {
      if (hasFiles(event)) {
        dragDepth += 1;
        this.#dropOverlay.hidden = false;
      }
    });
    window.addEventListener("dragleave", (event) => {
      if (hasFiles(event)) {
        dragDepth = Math.max(0, dragDepth - 1);
        this.#dropOverlay.hidden = dragDepth > 0;
      }
    });
    window.addEventListener("dragover", (event) => {
      if (hasFiles(event)) {
        event.preventDefault();
      }
    });
    window.addEventListener("drop", (event) => {
      if (!hasFiles(event)) {
        return;
      }
      event.preventDefault();
      dragDepth = 0;
      this.#dropOverlay.hidden = true;
      void this.addFiles([...(event.dataTransfer?.files ?? [])]);
    });

    // Paste images from the clipboard.
    window.addEventListener("paste", (event) => {
      const files = [...(event.clipboardData?.files ?? [])].filter(isImageFile);
      if (files.length > 0) {
        void this.addFiles(files);
      }
    });
  }

  async addFiles(files: File[]): Promise<void> {
    const images = files.filter(isImageFile);
    if (files.length > 0 && images.length === 0) {
      toast("Those files don't look like images.", "error");
      return;
    }
    if (images.length === 0) {
      return;
    }
    this.store.set({ loading: true });
    const results = await Promise.allSettled(images.map((file) => loadImageFile(file)));
    const loaded: SourceImage[] = [];
    for (const result of results) {
      if (result.status === "fulfilled") {
        loaded.push(result.value);
      } else {
        toast(result.reason instanceof Error ? result.reason.message : String(result.reason), "error");
      }
    }
    this.#append(loaded);
    this.store.set({ loading: false });
  }

  async #loadSamples(): Promise<void> {
    try {
      this.#append(await createSampleImages());
      toast("Sample photos loaded. They were taken from points along a line, so the scene shifts around the subject. Try the framing and playback options!", "success");
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    }
  }

  #append(images: SourceImage[]): void {
    if (images.length === 0) {
      return;
    }
    this.store.set((state) => ({
      images: [...state.images, ...images],
      active: state.active < 0 ? 0 : state.images.length,
    }));
    if (this.store.state.images.length === images.length) {
      requestAnimationFrame(() => document.getElementById("editor")?.scrollIntoView({ block: "start" }));
    }
    // New photos are matched to the points already placed by hand.
    this.#scheduleMatch(0);
  }

  #scheduleMatch(delay: number): void {
    clearTimeout(this.#matchTimer);
    if (this.#autoMatch) {
      this.#matchTimer = setTimeout(() => void this.#runMatch(), delay);
    }
  }

  /**
   * Find the hand-placed focal points in every photo that hasn't been placed
   * by hand, matching each photo against its neighbour (see `planMatches`).
   * Photos without a confident match are left for the user.
   */
  async #runMatch(): Promise<void> {
    const { images } = this.store.state;
    const plans = planMatches(images);
    const total = plans.reduce((sum, plan) => sum + plan.targets.length, 0);
    if (total === 0) {
      return;
    }
    const run = ++this.#matchRun;
    this.store.set({ matching: { done: 0, total } });
    let results: FocusMatch[][];
    try {
      results = await matchFocus(
        plans.map((plan) => ({
          reference: images[plan.start]!.bitmap,
          focus: images[plan.start]!.focus,
          targets: plan.targets.map((index) => images[index]!.bitmap),
        })),
        (done, count) => run === this.#matchRun && this.store.set({ matching: { done, total: count } }),
      );
    } catch (error) {
      console.error(error);
      if (run === this.#matchRun) {
        this.store.set({ matching: null });
        toast("Auto-match failed. Place the points by hand.", "error");
      }
      return;
    }
    if (run !== this.#matchRun) {
      return;
    }

    // Each photo records the one it was matched against: the last photo before it in its chain that had a point.
    const matchById = new Map<string, { match: FocusMatch; referenceId: string }>();
    plans.forEach((plan, p) => {
      let referenceId = images[plan.start]!.id;
      plan.targets.forEach((index, t) => {
        const match = results[p]![t]!;
        const { id } = images[index]!;
        matchById.set(id, { match, referenceId });
        if (match.focus) {
          referenceId = id;
        }
      });
    });
    const matches = [...matchById.values()].map((entry) => entry.match);
    const failed: string[] = [];
    this.store.set((state) => ({
      matching: null,
      images: state.images.map((image) => {
        const entry = matchById.get(image.id);
        // Skip photos that were removed, or placed by hand while matching ran.
        if (!entry || isManualFocus(image)) {
          return image;
        }
        const { match, referenceId } = entry;
        if (!match.focus) {
          failed.push(image.name);
          // A point matched to an earlier reference point no longer lines up, so ask for it again.
          return image.autoMatch ? { ...image, focusSet: false, autoMatch: null } : image;
        }
        const point = {
          x: Math.min(Math.max(Math.round(match.focus.x), 0), image.width),
          y: Math.min(Math.max(Math.round(match.focus.y), 0), image.height),
        };
        return { ...image, focus: point, focusSet: true, autoMatch: { score: match.score, referenceId } };
      }),
    }));

    if (failed.length > 0) {
      const featureless = matches.every((match) => match.reason === "featureless");
      toast(
        featureless
          ? "There isn't enough detail around that point to find it in the other photos. Try a more distinctive spot, or place the points by hand."
          : failed.length === 1
            ? `Couldn't find a confident match in ${failed[0]}. Place its point by hand.`
            : `Couldn't find confident matches in ${failed.length} photos (${failed.join(", ")}). Place their points by hand.`,
        "info",
      );
    }
  }

  #remove(id: string): void {
    const { images, active } = this.store.state;
    const index = images.findIndex((image) => image.id === id);
    const image = images[index];
    if (!image) {
      return;
    }
    disposeImage(image);
    const remaining = images.filter((candidate) => candidate.id !== id);
    this.store.set({
      images: remaining,
      active: Math.min(remaining.length - 1, index < active ? active - 1 : active),
    });
  }

  #move(id: string, offset: number): void {
    const { images, active } = this.store.state;
    const from = images.findIndex((image) => image.id === id);
    const to = from + offset;
    if (from < 0 || to < 0 || to >= images.length) {
      return;
    }
    const reordered = [...images];
    const [moved] = reordered.splice(from, 1);
    reordered.splice(to, 0, moved!);
    const activeId = images[active]?.id;
    this.store.set({ images: reordered, active: reordered.findIndex((image) => image.id === activeId) });
  }

  #clear(): void {
    const { images, result } = this.store.state;
    images.forEach(disposeImage);
    if (result) {
      URL.revokeObjectURL(result.url);
    }
    // Drop any matching still in flight.
    clearTimeout(this.#matchTimer);
    this.#matchRun += 1;
    this.store.set({ images: [], active: -1, result: null, matching: null });
    window.scrollTo({ top: 0 });
  }

  async generate(): Promise<void> {
    const state = this.store.state;
    const { plan, error } = tryPlan(state.images, state.options);
    if (!plan || state.encoding) {
      if (error) {
        toast(error, "error");
      }
      return;
    }
    const signature = signatureOf(state);
    const unique = new Set(plan.sequence).size;
    this.store.set({ encoding: { task: "animation", done: 0, total: unique } });
    try {
      const outcome = await encodeWebP(
        state.images.map((image) => image.bitmap),
        {
          output: plan.output,
          scale: plan.scale,
          placements: plan.layout.placements,
          sequence: plan.sequence,
          frameDelay: state.options.frameDelay,
          quality: state.options.quality,
        },
        (done, total) => this.store.set({ encoding: { task: "animation", done, total } }),
      );
      const previous = this.store.state.result;
      if (previous) {
        URL.revokeObjectURL(previous.url);
      }
      this.store.set({
        result: {
          url: URL.createObjectURL(outcome.blob),
          filename: timestampedFilename("pikugo", "webp"),
          bytes: outcome.blob.size,
          width: plan.output.width,
          height: plan.output.height,
          frameCount: outcome.frameCount,
          durationMs: plan.durationMs,
          elapsedMs: outcome.elapsedMs,
          engine: outcome.engine,
          signature,
        },
      });
      requestAnimationFrame(() => document.getElementById("result")?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
    } catch (error) {
      console.error(error);
      toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      this.store.set({ encoding: null });
    }
  }

  /**
   * Export every photo as its own PNG, aligned and framed exactly as it appears
   * in the animation, packaged as a .zip (or a single PNG for one photo).
   */
  async exportStills(): Promise<void> {
    const state = this.store.state;
    const { plan, error } = tryPlan(state.images, state.options);
    if (!plan || state.encoding) {
      if (error) {
        toast(error, "error");
      }
      return;
    }
    const images = state.images;
    const format = STILL_FORMATS[state.options.stillFormat];
    this.store.set({ encoding: { task: "stills", done: 0, total: images.length } });
    try {
      const { stills } = await renderStillFrames(
        images.map((image) => image.bitmap),
        { output: plan.output, scale: plan.scale, placements: plan.layout.placements },
        { mimeType: format.mimeType, quality: format.lossy ? state.options.quality : 1, matte: format.alpha ? null : STILL_MATTE },
        (done, total) => this.store.set({ encoding: { task: "stills", done, total } }),
      );
      const names = images.map((image, index) => stillFilename(index, images.length, image.name, format.extension));
      if (stills.length === 1) {
        downloadBlob(new Blob([stills[0]!], { type: format.mimeType }), names[0]!);
      } else {
        const zip = createZip(stills.map((data, index) => ({ name: names[index]!, data })));
        downloadBlob(new Blob([zip], { type: "application/zip" }), timestampedFilename("pikugo-stills", "zip"));
      }
      toast(
        stills.length === 1
          ? `Exported a ${plan.output.width} × ${plan.output.height} ${format.label}.`
          : `Exported ${stills.length} ${format.label} stills (${plan.output.width} × ${plan.output.height}) as a .zip.`,
        "success",
      );
    } catch (error) {
      console.error(error);
      toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      this.store.set({ encoding: null });
    }
  }
}

/** Save a blob through a temporary download link. */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  // Give the browser time to start the download before releasing the data.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
