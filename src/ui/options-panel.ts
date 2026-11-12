import { formatFps, formatMilliseconds } from "../core/format";
import type { Point } from "../core/geometry";
import {
  ASPECT_PRESETS,
  DEFAULT_OPTIONS,
  DELAY_PRESETS,
  FRAME_DELAY_MAX,
  FRAME_DELAY_MIN,
  MAX_EDGE_PRESETS,
  frameSequence,
  parsePlayback,
  parseStillFormat,
  parseAspectRatio,
  type AnimationOptions,
  type Playback,
} from "../core/options";
import { frameGeometry, frameSizeLimits, framingOf, setFrameSize, type FrameGeometry } from "../core/frame-edit";
import { byId, h, prefersReducedMotion, setRange, syncRangeFill } from "./dom";
import { tryPlan, type AppState, type AppStore } from "./state";

type OptionPatch = Partial<AnimationOptions>;

/**
 * Snap positions follow the rule-of-thirds guides: the corners of the grid are
 * where two guide lines cross, the edges are the midpoints of a single guide
 * line, and the middle is the centre of the frame.
 */
const THIRDS = [1 / 3, 0.5, 2 / 3];
const ANCHOR_POINTS: Point[] = THIRDS.flatMap((y) => THIRDS.map((x) => ({ x, y })));
const ANCHOR_NAMES = [
  "Top left intersection",
  "Top line",
  "Top right intersection",
  "Left line",
  "Centre",
  "Right line",
  "Bottom left intersection",
  "Bottom line",
  "Bottom right intersection",
];

/**
 * How long each tick in the frame order row stays highlighted. Fixed and slow,
 * so the order is easy to follow whatever frame delay is chosen.
 */
const ORDER_STEP_MS = 200;

/** What each playback mode looks like, shown under the playback buttons. */
const PLAYBACK_HINTS: Readonly<Record<Playback, string>> = {
  smooth: "Back and forth, pausing on the first and last photo like a pendulum.",
  bounce: "Back and forth, turning straight round at each end.",
  loop: "Forwards, then jumps back to the first photo.",
};

/** The options sidebar. Every control previews its effect on hover. */
export class OptionsPanel {
  readonly #store: AppStore;
  readonly #delayRange = byId("delayRange", HTMLInputElement);
  readonly #delayInput = byId("delayInput", HTMLInputElement);
  readonly #delayHint = byId("delayHint", HTMLParagraphElement);
  readonly #delayPresets = byId("delayPresets", HTMLDivElement);
  readonly #aspectPresets = byId("aspectPresets", HTMLDivElement);
  readonly #aspectCustom = byId("aspectCustom", HTMLInputElement);
  readonly #anchorGrid = byId("anchorGrid", HTMLDivElement);
  readonly #frameWidth = byId("frameWidth", HTMLInputElement);
  readonly #frameHeight = byId("frameHeight", HTMLInputElement);
  readonly #frameWidthOut = byId("frameWidthOut", HTMLOutputElement);
  readonly #frameHeightOut = byId("frameHeightOut", HTMLOutputElement);
  readonly #frameSize = byId("frameSize", HTMLDivElement);
  readonly #frameSizeLock = byId("frameSizeLock", HTMLSpanElement);
  readonly #fillFrame = byId("fillFrameBtn", HTMLButtonElement);
  readonly #sizePresets = byId("sizePresets", HTMLDivElement);
  readonly #quality = byId("qualityRange", HTMLInputElement);
  readonly #qualityOut = byId("qualityOut", HTMLOutputElement);
  readonly #playbackOrder = byId("playbackOrder", HTMLDivElement);
  readonly #playbackHint = byId("playbackHint", HTMLParagraphElement);
  /** What the frame order row currently shows, so it's only rebuilt when that changes. */
  #orderKey = "";
  /** Highlighted position in the frame order row, or null while it isn't animating. */
  #orderStep: number | null = null;
  #orderTimer: ReturnType<typeof setInterval> | undefined;

  constructor(store: AppStore) {
    this.#store = store;
    this.#buildChips();
    this.#bind();
    store.subscribe((state, previous) => {
      if (state.options !== previous.options || state.images !== previous.images) {
        this.#render(state);
      } else if (state.hoverOptions !== previous.hoverOptions) {
        this.#renderOrder(state);
      }
    });
    this.#render(store.state);
    this.#bindOrderAnimation();
  }

  /**
   * Step through the frame order on its own clock (independent of the
   * preview's frame delay), but only while the pointer is over the playback
   * field or focus is inside it, so it doesn't distract the rest of the time.
   */
  #bindOrderAnimation(): void {
    const field = this.#playbackOrder.parentElement;
    if (!field) {
      return;
    }
    let hovered = false;
    const update = () => {
      const active = (hovered || field.contains(document.activeElement)) && !prefersReducedMotion();
      if (active === (this.#orderTimer !== undefined)) {
        return;
      }
      if (active) {
        this.#orderStep = 0;
        this.#orderTimer = setInterval(() => {
          this.#orderStep = ((this.#orderStep ?? -1) + 1) % Math.max(1, this.#playbackOrder.childElementCount);
          this.#markPlaying();
        }, ORDER_STEP_MS);
      } else {
        clearInterval(this.#orderTimer);
        this.#orderTimer = undefined;
        this.#orderStep = null;
      }
      this.#markPlaying();
    };
    field.addEventListener("pointerenter", (event) => {
      if (event.pointerType === "mouse") {
        hovered = true;
        update();
      }
    });
    field.addEventListener("pointerleave", () => {
      hovered = false;
      update();
    });
    field.addEventListener("focusin", update);
    // Focus has moved on by the time the next task runs.
    field.addEventListener("focusout", () => setTimeout(update));
  }

  update(patch: OptionPatch): void {
    this.#store.set((state) => ({ options: { ...state.options, ...patch }, hoverOptions: null }));
  }

  #markPlaying(): void {
    [...this.#playbackOrder.children].forEach((tick, index) => tick.classList.toggle("is-playing", index === this.#orderStep));
  }

  /**
   * Spell out the frame order of the hovered (or else the selected) playback
   * mode, so the difference between the modes is visible without playing them.
   */
  #renderOrder(state: AppState): void {
    const playback = state.hoverOptions?.playback ?? state.options.playback;
    const count = state.images.length;
    // With no photos yet, show what three would do.
    const sequence = frameSequence(count || 3, playback);
    const key = `${playback}:${count}`;
    if (key === this.#orderKey) {
      return;
    }
    this.#orderKey = key;
    this.#playbackOrder.replaceChildren(
      ...sequence.map((index, i) => {
        // A photo shown twice in a row is drawn as one long tick: that's the pause at the turnaround.
        // When the sequence ends on the photo it starts with, that pause spans the loop, so both ends are marked.
        const wraps = sequence.length > 1 && sequence[0] === sequence.at(-1) && (i === 0 || i === sequence.length - 1);
        const hold = sequence[i - 1] === index ? "end" : sequence[i + 1] === index ? "start" : wraps ? "wrap" : undefined;
        return h("span", { className: "frame-tick", "data-hold": hold }, String(index + 1));
      }),
    );
    this.#playbackOrder.setAttribute("aria-label", `Frame order: ${sequence.map((index) => index + 1).join(", ")}`);
    this.#playbackHint.textContent =
      playback !== "loop" && count > 0 && count < 3 ? "Needs at least 3 photos to go back and forth. Until then it plays as a loop." : PLAYBACK_HINTS[playback];
    // Start each newly shown order from its first frame.
    if (this.#orderStep !== null) {
      this.#orderStep = 0;
    }
    this.#markPlaying();
  }

  /** The current output frame and the area it may cover, or null when there's no valid layout. */
  #frameGeometry(): FrameGeometry | null {
    const { images, options } = this.#store.state;
    const { plan } = tryPlan(images, options);
    return plan ? frameGeometry(plan.layout, options.edges, parseAspectRatio(options.aspect) ?? null) : null;
  }

  /** Map a radio button to the options it represents. */
  #patchFor(option: string, value: string): OptionPatch {
    switch (option) {
      case "playback":
        return { playback: parsePlayback(value) };
      case "edges":
        return { edges: value === "layer" ? "layer" : "crop" };
      case "aspect":
        return { aspect: value };
      case "maxEdge":
        return { maxEdge: value === "original" ? null : Number(value) };
      case "stillFormat":
        return { stillFormat: parseStillFormat(value) };
      default:
        return {};
    }
  }

  #buildChips(): void {
    for (const delay of DELAY_PRESETS) {
      const chip = h("button", { className: "chip", type: "button", "data-delay": delay, "aria-pressed": "false" }, `${delay}`);
      this.#delayPresets.append(chip);
    }
    for (const preset of ASPECT_PRESETS) {
      this.#aspectPresets.append(h("button", { className: "chip", type: "button", role: "radio", "data-value": preset.value }, preset.label));
    }
    for (const preset of MAX_EDGE_PRESETS) {
      this.#sizePresets.append(
        h("button", { className: "chip", type: "button", role: "radio", "data-value": preset.value === null ? "original" : preset.value }, preset.label),
      );
    }
    ANCHOR_POINTS.forEach((point, index) => {
      this.#anchorGrid.append(
        h("button", { type: "button", "aria-label": ANCHOR_NAMES[index], "data-x": point.x, "data-y": point.y, "data-name": ANCHOR_NAMES[index] }),
      );
    });
  }

  /** Temporarily preview a patch while the pointer or keyboard focus is on a control. */
  #previewOnHover(element: HTMLElement, patch: () => OptionPatch | null): void {
    const show = () => {
      const value = patch();
      if (value) {
        this.#store.set({ hoverOptions: value });
      }
    };
    const hide = () => this.#store.set({ hoverOptions: null });
    element.addEventListener("pointerenter", (event) => event.pointerType === "mouse" && show());
    element.addEventListener("pointerleave", hide);
    element.addEventListener("focus", show);
    element.addEventListener("blur", hide);
  }

  #bind(): void {
    for (const group of document.querySelectorAll<HTMLElement>("[data-option]")) {
      const option = group.dataset.option ?? "";
      for (const button of group.querySelectorAll<HTMLButtonElement>("[role=radio]")) {
        const value = button.dataset.value ?? "";
        button.addEventListener("click", () => this.update(this.#patchFor(option, value)));
        // The stills format has nothing to show in the preview.
        if (option !== "stillFormat") {
          this.#previewOnHover(button, () => this.#patchFor(option, value));
        }
      }
      // Arrow keys move between radio options.
      group.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
          return;
        }
        const radios = [...group.querySelectorAll<HTMLButtonElement>("[role=radio]")];
        const index = radios.indexOf(document.activeElement as HTMLButtonElement);
        if (index < 0) {
          return;
        }
        event.preventDefault();
        const step = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
        const next = radios[(index + step + radios.length) % radios.length];
        next?.focus();
        next?.click();
      });
    }

    const setDelay = (value: number) => {
      if (Number.isFinite(value)) {
        this.update({ frameDelay: Math.round(Math.min(FRAME_DELAY_MAX, Math.max(FRAME_DELAY_MIN, value))) });
      }
    };
    this.#delayRange.addEventListener("input", () => setDelay(Number(this.#delayRange.value)));
    this.#delayInput.addEventListener("change", () => setDelay(Number(this.#delayInput.value)));
    for (const chip of this.#delayPresets.querySelectorAll<HTMLButtonElement>("[data-delay]")) {
      const delay = Number(chip.dataset.delay);
      chip.addEventListener("click", () => setDelay(delay));
      this.#previewOnHover(chip, () => ({ frameDelay: delay }));
    }

    this.#aspectCustom.addEventListener("input", () => {
      const text = this.#aspectCustom.value;
      const ratio = parseAspectRatio(text);
      this.#aspectCustom.setAttribute("aria-invalid", String(ratio === undefined && text.trim() !== ""));
      if (ratio !== undefined && text.trim() !== "") {
        this.update({ aspect: text.trim() });
      }
    });

    for (const button of this.#anchorGrid.querySelectorAll<HTMLButtonElement>("button")) {
      const anchor = { x: Number(button.dataset.x), y: Number(button.dataset.y) };
      button.addEventListener("click", () => this.update({ anchor }));
      this.#previewOnHover(button, () => ({ anchor }));
    }
    // Width and height resize the frame about the subject, the same way dragging an edge does.
    const setSize = (size: { width?: number; height?: number }) => {
      const geometry = this.#frameGeometry();
      if (geometry) {
        this.update(framingOf(setFrameSize(geometry, size)));
      }
    };
    this.#frameWidth.addEventListener("input", () => setSize({ width: Number(this.#frameWidth.value) }));
    this.#frameHeight.addEventListener("input", () => setSize({ height: Number(this.#frameHeight.value) }));

    // Back to the largest frame the photos allow, with the subject as close to centre as it can be.
    this.#fillFrame.addEventListener("click", () => this.update({ anchor: null, frameSize: null }));
    this.#previewOnHover(this.#fillFrame, () => ({ anchor: null, frameSize: null }));

    this.#quality.addEventListener("input", () => this.update({ quality: Number(this.#quality.value) / 100 }));
    byId("resetOptionsBtn", HTMLButtonElement).addEventListener("click", () => {
      this.#aspectCustom.value = "";
      this.update({ ...DEFAULT_OPTIONS });
    });
  }

  /** Show the frame's size on the W/H sliders, with ranges for how far it can grow or shrink. */
  #renderFrameSize(): void {
    // With a fixed aspect ratio, width and height move together: show them linked.
    const { aspect } = this.#store.state.options;
    const locked = (parseAspectRatio(aspect) ?? null) !== null;
    this.#frameSize.dataset.locked = String(locked);
    this.#frameSizeLock.querySelector(".icon")?.classList.toggle("i-link", locked);
    this.#frameSizeLock.querySelector(".icon")?.classList.toggle("i-unlink", !locked);
    const label = locked
      ? `Width and height are locked to the ${aspect} aspect ratio`
      : "Width and height change independently. Choose an aspect ratio to lock them together.";
    this.#frameSizeLock.setAttribute("aria-label", label);
    this.#frameSizeLock.title = label;

    const geometry = this.#frameGeometry();
    const sliders = [
      [this.#frameWidth, this.#frameWidthOut, "width"],
      [this.#frameHeight, this.#frameHeightOut, "height"],
    ] as const;
    const limits = geometry ? frameSizeLimits(geometry) : null;
    for (const [input, output, key] of sliders) {
      input.disabled = !geometry || !limits;
      if (!geometry || !limits) {
        setRange(input, 0);
        output.textContent = "–";
        continue;
      }
      const [low, high] = limits[key];
      input.min = String(Math.floor(low));
      input.max = String(Math.floor(high));
      const value = geometry.frame[key];
      // Leave a slider alone while it's being dragged, so its range doesn't shift under the pointer.
      if (document.activeElement !== input) {
        setRange(input, Math.round(value));
      } else {
        syncRangeFill(input);
      }
      output.textContent = `${Math.round(value)} px`;
    }
  }

  #render(state: AppState): void {
    const { options } = state;
    const sizeValue = options.maxEdge === null ? "original" : String(options.maxEdge);
    const presetAspect = ASPECT_PRESETS.some((preset) => preset.value === options.aspect);

    for (const group of document.querySelectorAll<HTMLElement>("[data-option]")) {
      const option = group.dataset.option;
      const selected =
        option === "playback" ? options.playback
        : option === "edges" ? options.edges
        : option === "aspect" ? options.aspect
        : option === "maxEdge" ? sizeValue
        : option === "stillFormat" ? options.stillFormat
        : undefined;
      for (const button of group.querySelectorAll<HTMLButtonElement>("[role=radio]")) {
        const checked = button.dataset.value === selected;
        button.setAttribute("aria-checked", String(checked));
        button.tabIndex = checked || (option === "aspect" && !presetAspect && button === group.firstElementChild) ? 0 : -1;
      }
    }
    if (!presetAspect && document.activeElement !== this.#aspectCustom) {
      this.#aspectCustom.value = options.aspect;
    } else if (presetAspect && document.activeElement !== this.#aspectCustom) {
      this.#aspectCustom.value = "";
    }

    setRange(this.#delayRange, Math.min(Number(this.#delayRange.max), options.frameDelay));
    if (document.activeElement !== this.#delayInput) {
      this.#delayInput.value = String(options.frameDelay);
    }
    for (const chip of this.#delayPresets.querySelectorAll<HTMLButtonElement>("[data-delay]")) {
      chip.setAttribute("aria-pressed", String(Number(chip.dataset.delay) === options.frameDelay));
    }
    this.#renderOrder(state);
    const loopLength = frameSequence(Math.max(2, state.images.length), options.playback).length * options.frameDelay;
    this.#delayHint.textContent = `${formatFps(options.frameDelay)} · ${formatMilliseconds(loopLength)} per loop`;

    // With no position or size set, the frame is already as large as it can be.
    const filled = options.anchor === null;
    this.#fillFrame.disabled = filled;
    this.#fillFrame.title = filled ? "The frame already fills the available space" : "Make the frame as large as the photos allow";
    this.#renderFrameSize();
    for (const button of this.#anchorGrid.querySelectorAll<HTMLButtonElement>("button")) {
      const pressed = options.anchor !== null && Number(button.dataset.x) === options.anchor.x && Number(button.dataset.y) === options.anchor.y;
      button.setAttribute("aria-pressed", String(pressed));
      button.title = `Place the subject on the ${(button.dataset.name ?? "").toLowerCase()}`;
    }

    setRange(this.#quality, Math.round(options.quality * 100));
    this.#qualityOut.textContent = `${Math.round(options.quality * 100)}%`;
    syncRangeFill(this.#quality);
  }
}
