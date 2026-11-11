import type { Point, Rect } from "../core/geometry";
import { PLAYBACK_LABELS, type AnimationOptions } from "../core/options";
import { byId, prefersReducedMotion } from "./dom";
import { effectiveOptions, tryPlan, type AppState, type AppStore, type PlanResult } from "./state";

interface Theme {
  accent: string;
  success: string;
  faint: string;
  stage: string;
  checkerA: string;
  checkerB: string;
}

interface View {
  scale: number;
  offsetX: number;
  offsetY: number;
}

interface Drag {
  pointerId: number;
  start: Point;
  startAnchor: Point;
  frameWidth: number;
  frameHeight: number;
  scale: number;
}

const SNAP_POINTS = [0, 1 / 3, 0.5, 2 / 3, 1];
const SNAP_DISTANCE = 0.015;

function lerpRect(from: Rect, to: Rect, t: number): Rect {
  return {
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
    width: from.width + (to.width - from.width) * t,
    height: from.height + (to.height - from.height) * t,
  };
}

function rectsClose(a: Rect, b: Rect, epsilon: number): boolean {
  return (
    Math.abs(a.x - b.x) < epsilon &&
    Math.abs(a.y - b.y) < epsilon &&
    Math.abs(a.width - b.width) < epsilon &&
    Math.abs(a.height - b.height) < epsilon
  );
}

function boundsOf(rects: Rect[]): Rect {
  const left = Math.min(...rects.map((r) => r.x));
  const top = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.width));
  const bottom = Math.max(...rects.map((r) => r.y + r.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function snap(value: number): number {
  const target = SNAP_POINTS.find((point) => Math.abs(point - value) < SNAP_DISTANCE);
  return target ?? value;
}

export function describePreview(patch: Partial<AnimationOptions>): string {
  if (patch.edges) {
    return patch.edges === "crop" ? "Crop to overlap" : "Layer with transparency";
  }
  if (patch.aspect !== undefined) {
    return patch.aspect === "free" ? "Free aspect ratio" : `Aspect ${patch.aspect}`;
  }
  if ("anchor" in patch) {
    return patch.anchor ? `Focus at ${Math.round(patch.anchor.x * 100)}%, ${Math.round(patch.anchor.y * 100)}%` : "Automatic focus position";
  }
  if (patch.frameDelay !== undefined) {
    return `${patch.frameDelay} ms per frame`;
  }
  if (patch.playback) {
    return `${PLAYBACK_LABELS[patch.playback]} playback`;
  }
  if ("maxEdge" in patch) {
    return patch.maxEdge === null ? "Original size" : `Longest edge ${patch.maxEdge}px`;
  }
  return "Preview";
}

/**
 * Interactive, animated preview of the framing. Everything is drawn in "focus
 * space" (the shared focal point is the origin), so each photo stays put while
 * the output frame animates between options.
 */
export class Preview {
  readonly #store: AppStore;
  readonly #onAnchor: (anchor: Point) => void;
  readonly #stage = byId("previewStage", HTMLDivElement);
  readonly #canvas = byId("previewCanvas", HTMLCanvasElement);
  readonly #badge = byId("previewBadge", HTMLSpanElement);
  readonly #error = byId("previewError", HTMLParagraphElement);
  readonly #playToggle = byId("playToggle", HTMLButtonElement);
  readonly #stepButton = byId("stepBtn", HTMLButtonElement);
  readonly #guidesToggle = byId("guidesToggle", HTMLButtonElement);
  readonly #ghostToggle = byId("ghostToggle", HTMLButtonElement);
  readonly #context: CanvasRenderingContext2D | null;

  #playing = !prefersReducedMotion();
  #guides = true;
  #ghost = true;
  #step = 0;
  #lastSwitch = 0;
  #lastTick = 0;
  #dirty = true;
  #planKey: unknown[] = [];
  #planResult: PlanResult | null = null;
  #frame: Rect | null = null;
  #world: Rect | null = null;
  #view: View = { scale: 1, offsetX: 0, offsetY: 0 };
  #drag: Drag | null = null;
  #theme: Theme | null = null;
  #checker: CanvasPattern | null = null;
  #raf = 0;

  constructor(store: AppStore, onAnchor: (anchor: Point) => void) {
    this.#store = store;
    this.#onAnchor = onAnchor;
    this.#context = this.#canvas.getContext("2d");
    this.#canvas.tabIndex = 0;
    store.subscribe((state, previous) => {
      if (state.images !== previous.images || state.options !== previous.options || state.hoverOptions !== previous.hoverOptions) {
        this.#dirty = true;
        this.#renderChrome(state);
      }
    });
    this.#bind();
    this.#renderChrome(store.state);
    this.#syncToggles();
    this.#raf = requestAnimationFrame(this.#tick);
  }

  destroy(): void {
    cancelAnimationFrame(this.#raf);
  }

  get #plan(): PlanResult {
    const state = this.#store.state;
    const key = [state.images, state.options, state.hoverOptions];
    if (!this.#planResult || key.some((value, index) => value !== this.#planKey[index])) {
      this.#planKey = key;
      this.#planResult = tryPlan(state.images, effectiveOptions(state));
    }
    return this.#planResult;
  }

  #bind(): void {
    this.#playToggle.addEventListener("click", () => {
      this.#playing = !this.#playing;
      this.#syncToggles();
    });
    this.#stepButton.addEventListener("click", () => {
      this.#playing = false;
      this.#step += 1;
      this.#dirty = true;
      this.#syncToggles();
    });
    this.#guidesToggle.addEventListener("click", () => {
      this.#guides = !this.#guides;
      this.#dirty = true;
      this.#syncToggles();
    });
    this.#ghostToggle.addEventListener("click", () => {
      this.#ghost = !this.#ghost;
      this.#dirty = true;
      this.#syncToggles();
    });

    new ResizeObserver(() => {
      this.#dirty = true;
    }).observe(this.#stage);
    const refreshTheme = () => {
      this.#theme = null;
      this.#dirty = true;
    };
    new MutationObserver(refreshTheme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", refreshTheme);

    this.#canvas.addEventListener("pointerdown", this.#onPointerDown);
    this.#canvas.addEventListener("pointermove", this.#onPointerMove);
    this.#canvas.addEventListener("pointerup", this.#onPointerUp);
    this.#canvas.addEventListener("pointercancel", this.#onPointerUp);
    this.#canvas.addEventListener("pointerleave", () => {
      if (!this.#drag) {
        delete this.#stage.dataset.cursor;
      }
    });
    this.#canvas.addEventListener("keydown", (event) => {
      const moves: Record<string, Point> = { ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 }, ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 } };
      const move = moves[event.key];
      const anchor = this.#currentAnchor();
      if (!move || !anchor) {
        return;
      }
      event.preventDefault();
      const step = event.shiftKey ? 0.1 : 0.01;
      this.#onAnchor({
        x: Math.min(1, Math.max(0, Math.round((anchor.x + move.x * step) * 100) / 100)),
        y: Math.min(1, Math.max(0, Math.round((anchor.y + move.y * step) * 100) / 100)),
      });
    });
  }

  #syncToggles(): void {
    this.#playToggle.setAttribute("aria-pressed", String(this.#playing));
    this.#playToggle.setAttribute("aria-label", this.#playing ? "Pause preview" : "Play preview");
    this.#playToggle.querySelector(".icon")?.classList.toggle("i-pause", this.#playing);
    this.#playToggle.querySelector(".icon")?.classList.toggle("i-play", !this.#playing);
    this.#guidesToggle.setAttribute("aria-pressed", String(this.#guides));
    this.#ghostToggle.setAttribute("aria-pressed", String(this.#ghost));
  }

  #renderChrome(state: AppState): void {
    const { error } = this.#plan;
    this.#error.hidden = error === null || state.images.length === 0;
    this.#error.textContent = error ?? "";
    this.#badge.hidden = state.hoverOptions === null;
    this.#badge.textContent = state.hoverOptions ? `Previewing: ${describePreview(state.hoverOptions)}` : "";
  }

  /** The anchor the frame currently uses (explicit, or implied by the automatic layout). */
  #currentAnchor(): Point | null {
    const { plan } = this.#plan;
    if (!plan) {
      return null;
    }
    return this.#store.state.options.anchor ?? { x: plan.layout.focus.x / plan.layout.width, y: plan.layout.focus.y / plan.layout.height };
  }

  #toCanvas(point: Point): Point {
    return { x: this.#view.offsetX + point.x * this.#view.scale, y: this.#view.offsetY + point.y * this.#view.scale };
  }

  #canvasRect(rect: Rect): Rect {
    const origin = this.#toCanvas(rect);
    return { x: origin.x, y: origin.y, width: rect.width * this.#view.scale, height: rect.height * this.#view.scale };
  }

  #pointerOnFrame(event: PointerEvent): boolean {
    if (!this.#frame) {
      return false;
    }
    const bounds = this.#canvas.getBoundingClientRect();
    const frame = this.#canvasRect(this.#frame);
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    return x >= frame.x && y >= frame.y && x <= frame.x + frame.width && y <= frame.y + frame.height;
  }

  #onPointerDown = (event: PointerEvent) => {
    const { plan } = this.#plan;
    const anchor = this.#currentAnchor();
    if (!plan || !anchor || !this.#pointerOnFrame(event)) {
      return;
    }
    event.preventDefault();
    this.#canvas.setPointerCapture(event.pointerId);
    this.#drag = {
      pointerId: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
      startAnchor: anchor,
      frameWidth: plan.layout.width,
      frameHeight: plan.layout.height,
      scale: this.#view.scale,
    };
    this.#stage.dataset.cursor = "grabbing";
  };

  #onPointerMove = (event: PointerEvent) => {
    const drag = this.#drag;
    if (!drag || drag.pointerId !== event.pointerId) {
      if (this.#plan.plan) {
        this.#stage.dataset.cursor = this.#pointerOnFrame(event) ? "move" : "";
      }
      return;
    }
    // Moving the frame right moves the subject left within it.
    const dx = (event.clientX - drag.start.x) / drag.scale;
    const dy = (event.clientY - drag.start.y) / drag.scale;
    this.#onAnchor({
      x: snap(Math.min(1, Math.max(0, drag.startAnchor.x - dx / drag.frameWidth))),
      y: snap(Math.min(1, Math.max(0, drag.startAnchor.y - dy / drag.frameHeight))),
    });
  };

  #onPointerUp = (event: PointerEvent) => {
    if (this.#drag?.pointerId === event.pointerId) {
      this.#drag = null;
      this.#stage.dataset.cursor = "move";
    }
  };

  #readTheme(): Theme {
    if (!this.#theme) {
      const style = getComputedStyle(document.documentElement);
      const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
      this.#theme = {
        accent: read("--accent", "#6d4aff"),
        success: read("--success", "#12a37b"),
        faint: read("--text-faint", "#9a95b1"),
        stage: read("--stage-bg", "#ecebf4"),
        checkerA: read("--checker-a", "#ffffff"),
        checkerB: read("--checker-b", "#e8e5f2"),
      };
      this.#checker = null;
    }
    return this.#theme;
  }

  #checkerPattern(context: CanvasRenderingContext2D, theme: Theme): CanvasPattern | null {
    if (!this.#checker) {
      const tile = document.createElement("canvas");
      tile.width = 16;
      tile.height = 16;
      const tileContext = tile.getContext("2d");
      if (tileContext) {
        tileContext.fillStyle = theme.checkerA;
        tileContext.fillRect(0, 0, 16, 16);
        tileContext.fillStyle = theme.checkerB;
        tileContext.fillRect(0, 0, 8, 8);
        tileContext.fillRect(8, 8, 8, 8);
        this.#checker = context.createPattern(tile, "repeat");
      }
    }
    return this.#checker;
  }

  #tick = (now: number) => {
    this.#raf = requestAnimationFrame(this.#tick);
    const elapsed = this.#lastTick ? Math.min(100, now - this.#lastTick) : 16;
    this.#lastTick = now;
    const state = this.#store.state;
    const { plan } = this.#plan;
    if (!plan) {
      if (this.#dirty) {
        this.#clear();
        this.#dirty = false;
      }
      return;
    }

    const delay = effectiveOptions(state).frameDelay;
    if (this.#playing && now - this.#lastSwitch >= delay) {
      this.#step += 1;
      this.#lastSwitch = now - this.#lastSwitch < delay * 2 ? this.#lastSwitch + delay : now;
      this.#dirty = true;
    }

    // Target geometry, in focus space.
    const { layout } = plan;
    const targetFrame: Rect = { x: -layout.focus.x, y: -layout.focus.y, width: layout.width, height: layout.height };
    const union: Rect = { ...layout.union, x: layout.union.x - layout.focus.x, y: layout.union.y - layout.focus.y };
    const bounds = boundsOf([targetFrame, union]);
    const pad = Math.max(bounds.width, bounds.height) * 0.04;
    const targetWorld: Rect = { x: bounds.x - pad, y: bounds.y - pad, width: bounds.width + pad * 2, height: bounds.height + pad * 2 };

    const ease = prefersReducedMotion() || !this.#frame ? 1 : 1 - Math.exp(-elapsed / 70);
    this.#frame = this.#frame ? lerpRect(this.#frame, targetFrame, ease) : targetFrame;
    this.#world = this.#world && !this.#drag ? lerpRect(this.#world, targetWorld, ease) : targetWorld;
    const settled = rectsClose(this.#frame, targetFrame, 0.5) && rectsClose(this.#world, targetWorld, 0.5);
    if (settled) {
      this.#frame = targetFrame;
      this.#world = targetWorld;
    }
    if (this.#dirty || !settled) {
      this.#draw(state);
      this.#dirty = false;
    }
  };

  #resize(): { width: number; height: number } | null {
    const width = this.#canvas.clientWidth;
    const height = this.#canvas.clientHeight;
    if (width === 0 || height === 0) {
      return null;
    }
    const ratio = window.devicePixelRatio || 1;
    const pixelWidth = Math.round(width * ratio);
    const pixelHeight = Math.round(height * ratio);
    if (this.#canvas.width !== pixelWidth || this.#canvas.height !== pixelHeight) {
      this.#canvas.width = pixelWidth;
      this.#canvas.height = pixelHeight;
    }
    this.#context?.setTransform(ratio, 0, 0, ratio, 0, 0);
    return { width, height };
  }

  #clear(): void {
    const size = this.#resize();
    if (size && this.#context) {
      this.#context.clearRect(0, 0, size.width, size.height);
    }
  }

  #draw(state: AppState): void {
    const context = this.#context;
    const size = this.#resize();
    const { plan } = this.#plan;
    const frameRect = this.#frame;
    const world = this.#world;
    if (!context || !size || !plan || !frameRect || !world) {
      return;
    }
    const theme = this.#readTheme();
    context.clearRect(0, 0, size.width, size.height);

    const margin = 12;
    const scale = Math.min((size.width - margin * 2) / world.width, (size.height - margin * 2) / world.height);
    this.#view = {
      scale,
      offsetX: (size.width - world.width * scale) / 2 - world.x * scale,
      offsetY: (size.height - world.height * scale) / 2 - world.y * scale,
    };

    const sequence = plan.sequence;
    const index = sequence[this.#step % sequence.length] ?? 0;
    const image = state.images[index];
    const frame = this.#canvasRect(frameRect);
    const photoRect = (i: number): Rect | null => {
      const source = state.images[i];
      return source ? this.#canvasRect({ x: -source.focus.x, y: -source.focus.y, width: source.width, height: source.height }) : null;
    };

    // Transparent area of the output frame.
    const checker = this.#checkerPattern(context, theme);
    context.save();
    context.fillStyle = checker ?? theme.checkerA;
    context.fillRect(frame.x, frame.y, frame.width, frame.height);
    context.restore();

    const current = photoRect(index);
    if (image && current) {
      context.imageSmoothingQuality = "high";
      if (this.#ghost) {
        context.drawImage(image.bitmap, current.x, current.y, current.width, current.height);
        // Veil everything outside the frame.
        context.save();
        context.beginPath();
        context.rect(0, 0, size.width, size.height);
        context.rect(frame.x, frame.y, frame.width, frame.height);
        context.globalAlpha = 0.72;
        context.fillStyle = theme.stage;
        context.fill("evenodd");
        context.restore();
      } else {
        context.save();
        context.beginPath();
        context.rect(frame.x, frame.y, frame.width, frame.height);
        context.clip();
        context.drawImage(image.bitmap, current.x, current.y, current.width, current.height);
        context.restore();
      }
    }

    if (this.#guides) {
      this.#drawGuides(context, state, plan.layout.intersection, plan.layout.focus, frame, index, photoRect, theme);
    }

    // Frame outline with corner handles.
    context.save();
    context.strokeStyle = theme.accent;
    context.lineWidth = 2;
    context.strokeRect(frame.x, frame.y, frame.width, frame.height);
    context.lineWidth = 4;
    context.lineCap = "round";
    const corner = Math.min(18, frame.width / 4, frame.height / 4);
    for (const [cx, cy, dx, dy] of [
      [frame.x, frame.y, 1, 1],
      [frame.x + frame.width, frame.y, -1, 1],
      [frame.x, frame.y + frame.height, 1, -1],
      [frame.x + frame.width, frame.y + frame.height, -1, -1],
    ] as const) {
      context.beginPath();
      context.moveTo(cx + dx * corner, cy);
      context.lineTo(cx, cy);
      context.lineTo(cx, cy + dy * corner);
      context.stroke();
    }
    context.restore();

    this.#drawLabel(context, `${plan.output.width} × ${plan.output.height}`, frame.x + 8, frame.y + 8, theme.accent);
    if (sequence.length > 1) {
      this.#drawLabel(context, `Frame ${(this.#step % sequence.length) + 1}/${sequence.length}`, frame.x + 8, frame.y + frame.height - 30, "rgba(10, 8, 20, 0.7)");
    }
  }

  #drawGuides(
    context: CanvasRenderingContext2D,
    state: AppState,
    intersection: Rect,
    focus: Point,
    frame: Rect,
    currentIndex: number,
    photoRect: (index: number) => Rect | null,
    theme: Theme,
  ): void {
    context.save();
    context.lineWidth = 1.25;
    context.setLineDash([5, 5]);
    state.images.forEach((_, i) => {
      const rect = photoRect(i);
      if (!rect) {
        return;
      }
      context.strokeStyle = i === currentIndex ? "rgba(255, 255, 255, 0.9)" : theme.faint;
      context.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.width - 1, rect.height - 1);
    });

    if (state.images.length > 1) {
      const shared = this.#canvasRect({ ...intersection, x: intersection.x - focus.x, y: intersection.y - focus.y });
      context.strokeStyle = theme.success;
      context.lineWidth = 2;
      context.setLineDash([8, 5]);
      context.strokeRect(shared.x, shared.y, shared.width, shared.height);
    }

    // Rule-of-thirds lines help when pinning the subject.
    if (this.#store.state.options.anchor) {
      context.setLineDash([]);
      context.lineWidth = 1;
      context.strokeStyle = "rgba(255, 255, 255, 0.35)";
      for (const t of [1 / 3, 2 / 3]) {
        context.beginPath();
        context.moveTo(frame.x + frame.width * t, frame.y);
        context.lineTo(frame.x + frame.width * t, frame.y + frame.height);
        context.moveTo(frame.x, frame.y + frame.height * t);
        context.lineTo(frame.x + frame.width, frame.y + frame.height * t);
        context.stroke();
      }
    }
    context.restore();

    // Shared focal point.
    const origin = this.#toCanvas({ x: 0, y: 0 });
    context.save();
    context.lineWidth = 2;
    context.strokeStyle = "rgba(0, 0, 0, 0.45)";
    context.beginPath();
    context.arc(origin.x, origin.y, 10, 0, Math.PI * 2);
    context.stroke();
    context.strokeStyle = "#fff";
    context.lineWidth = 2;
    context.beginPath();
    context.arc(origin.x, origin.y, 9, 0, Math.PI * 2);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      context.moveTo(origin.x + dx * 13, origin.y + dy * 13);
      context.lineTo(origin.x + dx * 20, origin.y + dy * 20);
    }
    context.stroke();
    context.fillStyle = theme.accent;
    context.beginPath();
    context.arc(origin.x, origin.y, 3, 0, Math.PI * 2);
    context.fill();
    context.restore();
  }

  #drawLabel(context: CanvasRenderingContext2D, text: string, x: number, y: number, background: string): void {
    context.save();
    context.font = "600 12px ui-sans-serif, system-ui, sans-serif";
    const width = context.measureText(text).width + 14;
    context.fillStyle = background;
    context.beginPath();
    context.roundRect(x, y, width, 22, 11);
    context.fill();
    context.fillStyle = "#fff";
    context.textBaseline = "middle";
    context.fillText(text, x + 7, y + 11.5);
    context.restore();
  }
}
