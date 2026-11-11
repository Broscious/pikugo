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
  parseAspectRatio,
  type AnimationOptions,
} from "../core/options";
import { byId, h, setRange, syncRangeFill } from "./dom";
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

/** The options sidebar. Every control previews its effect on hover. */
export class OptionsPanel {
  readonly #store: AppStore;
  readonly #delayRange = byId("delayRange", HTMLInputElement);
  readonly #delayInput = byId("delayInput", HTMLInputElement);
  readonly #delayHint = byId("delayHint", HTMLParagraphElement);
  readonly #delayPresets = byId("delayPresets", HTMLDivElement);
  readonly #aspectPresets = byId("aspectPresets", HTMLDivElement);
  readonly #aspectCustom = byId("aspectCustom", HTMLInputElement);
  readonly #anchorControls = byId("anchorControls", HTMLDivElement);
  readonly #anchorGrid = byId("anchorGrid", HTMLDivElement);
  readonly #anchorX = byId("anchorX", HTMLInputElement);
  readonly #anchorY = byId("anchorY", HTMLInputElement);
  readonly #anchorXOut = byId("anchorXOut", HTMLOutputElement);
  readonly #anchorYOut = byId("anchorYOut", HTMLOutputElement);
  readonly #sizePresets = byId("sizePresets", HTMLDivElement);
  readonly #quality = byId("qualityRange", HTMLInputElement);
  readonly #qualityOut = byId("qualityOut", HTMLOutputElement);
  /** Last fixed anchor, restored when switching back from Auto. */
  #lastAnchor: Point = { x: 0.5, y: 0.5 };

  constructor(store: AppStore) {
    this.#store = store;
    this.#buildChips();
    this.#bind();
    store.subscribe((state, previous) => {
      if (state.options !== previous.options || state.images !== previous.images) {
        this.#render(state);
      }
    });
    this.#render(store.state);
  }

  update(patch: OptionPatch): void {
    if (patch.anchor) {
      this.#lastAnchor = patch.anchor;
    }
    this.#store.set((state) => ({ options: { ...state.options, ...patch }, hoverOptions: null }));
  }

  /** Anchor matching the current automatic layout, so switching to Fixed doesn't jump. */
  #currentAnchor(): Point {
    const { images, options } = this.#store.state;
    const { plan } = tryPlan(images, options);
    if (!plan) {
      return this.#lastAnchor;
    }
    const { focus, width, height } = plan.layout;
    return { x: Math.round((focus.x / width) * 100) / 100, y: Math.round((focus.y / height) * 100) / 100 };
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
      case "anchorMode":
        return { anchor: value === "fixed" ? (this.#store.state.options.anchor ?? this.#currentAnchor()) : null };
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
        h("button", { type: "button", "aria-label": ANCHOR_NAMES[index], title: ANCHOR_NAMES[index], "data-x": point.x, "data-y": point.y }),
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
        this.#previewOnHover(button, () => this.#patchFor(option, value));
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
    const setAnchorFromSliders = () =>
      this.update({ anchor: { x: Number(this.#anchorX.value) / 100, y: Number(this.#anchorY.value) / 100 } });
    this.#anchorX.addEventListener("input", setAnchorFromSliders);
    this.#anchorY.addEventListener("input", setAnchorFromSliders);

    this.#quality.addEventListener("input", () => this.update({ quality: Number(this.#quality.value) / 100 }));
    byId("resetOptionsBtn", HTMLButtonElement).addEventListener("click", () => {
      this.#aspectCustom.value = "";
      this.update({ ...DEFAULT_OPTIONS });
    });
  }

  #render(state: AppState): void {
    const { options } = state;
    const anchorMode = options.anchor ? "fixed" : "auto";
    const sizeValue = options.maxEdge === null ? "original" : String(options.maxEdge);
    const presetAspect = ASPECT_PRESETS.some((preset) => preset.value === options.aspect);

    for (const group of document.querySelectorAll<HTMLElement>("[data-option]")) {
      const option = group.dataset.option;
      const selected =
        option === "playback" ? options.playback
        : option === "edges" ? options.edges
        : option === "aspect" ? options.aspect
        : option === "maxEdge" ? sizeValue
        : option === "anchorMode" ? anchorMode
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
    const loopLength = frameSequence(Math.max(2, state.images.length), options.playback).length * options.frameDelay;
    this.#delayHint.textContent = `${formatFps(options.frameDelay)} · ${formatMilliseconds(loopLength)} per loop`;

    const anchor = options.anchor ?? this.#lastAnchor;
    this.#anchorControls.dataset.disabled = String(options.anchor === null);
    setRange(this.#anchorX, Math.round(anchor.x * 100));
    setRange(this.#anchorY, Math.round(anchor.y * 100));
    this.#anchorXOut.textContent = `${Math.round(anchor.x * 100)}%`;
    this.#anchorYOut.textContent = `${Math.round(anchor.y * 100)}%`;
    for (const button of this.#anchorGrid.querySelectorAll<HTMLButtonElement>("button")) {
      const pressed = options.anchor !== null && Number(button.dataset.x) === options.anchor.x && Number(button.dataset.y) === options.anchor.y;
      button.setAttribute("aria-pressed", String(pressed));
    }

    setRange(this.#quality, Math.round(options.quality * 100));
    this.#qualityOut.textContent = `${Math.round(options.quality * 100)}%`;
    syncRangeFill(this.#quality);
  }
}
