import { clamp, type Point } from "../core/geometry";
import { byId } from "./dom";
import type { AppState, AppStore, SourceImage } from "./state";

const pct = (value: number, size: number) => `${size > 0 ? (value / size) * 100 : 50}%`;

/** Main photo viewer where the user clicks to place each photo's focal point. */
export class FocusEditor {
  readonly #store: AppStore;
  readonly #container = byId("viewerContainer", HTMLDivElement);
  readonly #stage = byId("imageStage", HTMLDivElement);
  readonly #image = byId("selectedImage", HTMLImageElement);
  readonly #onion = byId("onionImage", HTMLImageElement);
  readonly #marker = byId("selectionMarker", HTMLSpanElement);
  readonly #counter = byId("imageCounter", HTMLSpanElement);
  readonly #prev = byId("prevBtn", HTMLButtonElement);
  readonly #next = byId("nextBtn", HTMLButtonElement);
  readonly #magnifyToggle = byId("magnifyToggle", HTMLButtonElement);
  readonly #onionToggle = byId("onionToggle", HTMLButtonElement);
  readonly #centerButton = byId("centerFocusBtn", HTMLButtonElement);

  #magnify = true;
  #onionSkin = false;
  #hover: Point | null = null;

  constructor(store: AppStore) {
    this.#store = store;
    store.subscribe((state, previous) => {
      if (state.images !== previous.images || state.active !== previous.active) {
        this.#render(state);
      }
    });
    this.#bind();
    this.#render(store.state);
  }

  get #current(): SourceImage | undefined {
    const { images, active } = this.#store.state;
    return images[active];
  }

  /** The photo shown as the onion skin: the previous frame, wrapping around. */
  get #reference(): SourceImage | undefined {
    const { images, active } = this.#store.state;
    if (images.length < 2) {
      return undefined;
    }
    return images[(active - 1 + images.length) % images.length];
  }

  select(index: number): void {
    const { images } = this.#store.state;
    if (index >= 0 && index < images.length) {
      this.#store.set({ active: index });
    }
  }

  setFocus(point: Point): void {
    const current = this.#current;
    if (!current) {
      return;
    }
    const focus = { x: clamp(Math.round(point.x), 0, current.width), y: clamp(Math.round(point.y), 0, current.height) };
    this.#store.set((state) => ({
      images: state.images.map((image) => (image === current ? { ...image, focus, focusSet: true } : image)),
    }));
  }

  #bind(): void {
    this.#prev.addEventListener("click", () => this.select(this.#store.state.active - 1));
    this.#next.addEventListener("click", () => this.select(this.#store.state.active + 1));

    this.#magnifyToggle.addEventListener("click", () => {
      this.#magnify = !this.#magnify;
      this.#magnifyToggle.setAttribute("aria-pressed", String(this.#magnify));
      if (!this.#magnify) {
        this.#zoom(null);
      }
    });
    this.#onionToggle.addEventListener("click", () => {
      this.#onionSkin = !this.#onionSkin;
      this.#onionToggle.setAttribute("aria-pressed", String(this.#onionSkin));
      this.#renderOnion();
    });
    this.#centerButton.addEventListener("click", () => {
      const current = this.#current;
      if (current) {
        this.setFocus({ x: current.width / 2, y: current.height / 2 });
      }
    });

    this.#container.addEventListener("pointermove", (event) => {
      if (event.pointerType === "touch") {
        return;
      }
      const point = this.#pointAt(event);
      this.#hover = point;
      if (this.#magnify && point) {
        this.#zoom(point);
      }
      this.#renderOnion();
    });
    this.#container.addEventListener("pointerleave", () => {
      this.#hover = null;
      this.#zoom(null);
      this.#renderOnion();
    });
    this.#image.addEventListener("click", (event) => {
      const point = this.#pointAt(event);
      if (point) {
        this.setFocus(point);
      }
    });

    this.#container.addEventListener("keydown", (event) => {
      const current = this.#current;
      if (!current) {
        return;
      }
      const moves: Record<string, Point> = {
        ArrowLeft: { x: -1, y: 0 },
        ArrowRight: { x: 1, y: 0 },
        ArrowUp: { x: 0, y: -1 },
        ArrowDown: { x: 0, y: 1 },
      };
      const move = moves[event.key];
      if (!move) {
        return;
      }
      event.preventDefault();
      if (event.shiftKey) {
        const step = event.altKey ? 10 : Math.max(1, Math.round(Math.max(current.width, current.height) / 200));
        this.setFocus({ x: current.focus.x + move.x * step, y: current.focus.y + move.y * step });
      } else if (move.x !== 0) {
        this.select(this.#store.state.active + move.x);
      }
    });
  }

  /** Convert a pointer position to source-image pixels. */
  #pointAt(event: MouseEvent): Point | null {
    const current = this.#current;
    const rect = this.#image.getBoundingClientRect();
    if (!current || rect.width === 0 || rect.height === 0) {
      return null;
    }
    const x = ((event.clientX - rect.left) / rect.width) * current.width;
    const y = ((event.clientY - rect.top) / rect.height) * current.height;
    if (x < 0 || y < 0 || x > current.width || y > current.height) {
      return null;
    }
    return { x, y };
  }

  #zoom(point: Point | null): void {
    const current = this.#current;
    if (point && current) {
      this.#stage.style.transformOrigin = `${pct(point.x, current.width)} ${pct(point.y, current.height)}`;
      this.#stage.classList.add("zoomed");
    } else {
      this.#stage.classList.remove("zoomed");
    }
  }

  #render(state: AppState): void {
    const current = state.images[state.active];
    if (!current) {
      this.#image.removeAttribute("src");
      this.#counter.textContent = "";
      return;
    }
    if (this.#image.getAttribute("src") !== current.url) {
      this.#image.src = current.url;
    }
    this.#image.alt = `${current.name}, photo ${state.active + 1} of ${state.images.length}`;
    this.#marker.style.left = pct(current.focus.x, current.width);
    this.#marker.style.top = pct(current.focus.y, current.height);
    this.#counter.textContent = `${state.active + 1} / ${state.images.length}`;
    this.#prev.disabled = state.active <= 0;
    this.#next.disabled = state.active >= state.images.length - 1;
    this.#onionToggle.disabled = state.images.length < 2;
    this.#renderOnion();
  }

  /**
   * Show the previous photo semi-transparently, positioned so its focal point
   * sits under the cursor (or under this photo's focal point when not hovering).
   * Lining up the two images makes it easy to click the matching spot.
   */
  #renderOnion(): void {
    const current = this.#current;
    const reference = this.#reference;
    if (!this.#onionSkin || !current || !reference) {
      this.#onion.hidden = true;
      return;
    }
    const anchor = this.#hover ?? current.focus;
    if (this.#onion.getAttribute("src") !== reference.url) {
      this.#onion.src = reference.url;
    }
    this.#onion.style.left = pct(anchor.x - reference.focus.x, current.width);
    this.#onion.style.top = pct(anchor.y - reference.focus.y, current.height);
    this.#onion.style.width = pct(reference.width, current.width);
    this.#onion.style.height = pct(reference.height, current.height);
    this.#onion.hidden = false;
  }
}
