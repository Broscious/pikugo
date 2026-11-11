import { formatAspect, formatBytes, formatFps, formatMilliseconds, formatPercent } from "../core/format";
import { PLAYBACK_LABELS } from "../core/options";
import { byId, h } from "./dom";
import { signatureOf, tryPlan, type AppState, type AppStore } from "./state";

function entry(term: string, value: string, detail?: string, warning = false): HTMLDivElement {
  const description = h("dd", {}, value);
  if (detail) {
    description.append(" ", h("small", {}, detail));
  }
  return h("div", { className: warning ? "is-warning" : "" }, h("dt", {}, term), description);
}

/** Output summary under the preview and the Create button state. */
export class Summary {
  readonly #summary = byId("summary", HTMLDListElement);
  readonly #generate = byId("generateBtn", HTMLButtonElement);
  readonly #generateLabel = byId("generateLabel", HTMLSpanElement);
  readonly #stills = byId("stillsBtn", HTMLButtonElement);
  readonly #stillsLabel = byId("stillsLabel", HTMLSpanElement);
  readonly #progress = byId("progress", HTMLDivElement);
  readonly #progressBar = byId("progressBar", HTMLDivElement);
  readonly #progressText = byId("progressText", HTMLSpanElement);

  constructor(store: AppStore) {
    store.subscribe((state, previous) => {
      if (state.images !== previous.images || state.options !== previous.options || state.encoding !== previous.encoding) {
        this.#render(state);
      }
    });
    this.#render(store.state);
  }

  #render(state: AppState): void {
    const { plan } = tryPlan(state.images, state.options);
    if (plan) {
      const empty = Math.max(0, ...plan.layout.emptyFraction);
      const entries = [
        entry("Output", `${plan.output.width} × ${plan.output.height}`, formatAspect(plan.output.width, plan.output.height)),
        entry("Frames", String(plan.sequence.length), PLAYBACK_LABELS[state.options.playback].toLowerCase()),
        entry("Loop", formatMilliseconds(plan.durationMs), formatFps(state.options.frameDelay)),
      ];
      if (state.options.edges === "layer") {
        entries.push(entry("Transparent", `up to ${formatPercent(empty)}`, "per frame", empty > 0.25));
      } else {
        const smallest = Math.min(...state.images.map((image) => (plan.layout.width * plan.layout.height) / (image.width * image.height)));
        entries.push(entry("Kept", `≥ ${formatPercent(Math.min(1, smallest))}`, "of each photo", smallest < 0.5));
      }
      this.#summary.replaceChildren(...entries);
    } else {
      this.#summary.replaceChildren();
    }

    const encoding = state.encoding;
    this.#generate.disabled = !plan || encoding !== null;
    this.#generateLabel.textContent =
      encoding?.task === "animation" ? "Encoding…" : state.images.length > 1 ? "Create animated WebP" : "Create WebP";
    this.#stills.disabled = !plan || encoding !== null;
    this.#stillsLabel.textContent = encoding?.task === "stills" ? "Exporting…" : state.images.length > 1 ? "Export stills" : "Export still";
    this.#stills.title =
      state.images.length > 1
        ? "Download each photo as a PNG, aligned and framed exactly as in the animation (.zip)"
        : "Download the framed photo as a PNG";
    this.#progress.hidden = encoding === null;
    if (encoding) {
      const fraction = encoding.total > 0 ? encoding.done / encoding.total : 0;
      this.#progressBar.style.width = `${fraction * 100}%`;
      this.#progressText.textContent = `${encoding.task === "stills" ? "Still" : "Frame"} ${Math.min(encoding.done + 1, encoding.total)} of ${encoding.total}`;
    }
  }
}

type StepState = "todo" | "active" | "done";

/** The four-step progress indicator in the header. */
export class Stepper {
  readonly #root = byId("stepper", HTMLOListElement);

  constructor(store: AppStore) {
    store.subscribe((state) => this.#render(state));
    this.#render(store.state);
  }

  #set(step: string, value: StepState, detail = ""): void {
    const item = this.#root.querySelector<HTMLElement>(`[data-step="${step}"]`);
    if (!item) {
      return;
    }
    item.dataset.state = value;
    const label = item.querySelector(".step-detail");
    if (label) {
      label.textContent = detail;
    }
    item.querySelector("a")?.setAttribute("aria-current", value === "active" ? "step" : "false");
  }

  #render(state: AppState): void {
    const count = state.images.length;
    const focused = state.images.filter((image) => image.focusSet).length;
    const hasPhotos = count >= 2;
    const allFocused = count > 0 && focused === count;
    const exported = state.result !== null && state.result.signature === signatureOf(state);
    this.#set("photos", hasPhotos ? "done" : "active", count ? `${count}` : "");
    this.#set("focus", !hasPhotos ? "todo" : allFocused ? "done" : "active", count ? `${focused}/${count}` : "");
    this.#set("frame", !hasPhotos ? "todo" : exported ? "done" : allFocused ? "active" : "todo");
    this.#set("export", exported ? "done" : hasPhotos && allFocused ? "active" : "todo");
  }
}

/** The generated animation, its stats and the download link. */
export class ResultView {
  readonly #panel = byId("result", HTMLElement);
  readonly #image = byId("resultImage", HTMLImageElement);
  readonly #stats = byId("resultStats", HTMLDListElement);
  readonly #download = byId("downloadBtn", HTMLAnchorElement);
  readonly #stale = byId("staleBadge", HTMLSpanElement);

  constructor(store: AppStore) {
    store.subscribe((state, previous) => {
      if (state.result !== previous.result || state.images !== previous.images || state.options !== previous.options) {
        this.#render(state);
      }
    });
    this.#render(store.state);
  }

  #render(state: AppState): void {
    const result = state.result;
    this.#panel.hidden = result === null;
    if (!result) {
      this.#image.removeAttribute("src");
      return;
    }
    if (this.#image.getAttribute("src") !== result.url) {
      this.#image.src = result.url;
      this.#image.width = result.width;
      this.#image.height = result.height;
    }
    this.#download.href = result.url;
    this.#download.download = result.filename;
    this.#stale.hidden = result.signature === signatureOf(state);
    this.#stats.replaceChildren(
      ...[
        ["Size", formatBytes(result.bytes)],
        ["Dimensions", `${result.width} × ${result.height}`],
        ["Frames", String(result.frameCount)],
        ["Duration", formatMilliseconds(result.durationMs)],
        ["Encoded in", formatMilliseconds(result.elapsedMs)],
        ["Engine", result.engine === "worker" ? "Web Worker" : "Main thread"],
      ].map(([term, value]) => h("div", {}, h("dt", {}, term ?? ""), h("dd", {}, value ?? ""))),
    );
  }
}
