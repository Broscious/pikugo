import { byId, h, icon } from "./dom";
import type { AppState, AppStore, SourceImage } from "./state";

export interface FilmstripActions {
  addFiles(): void;
  remove(id: string): void;
  move(id: string, offset: number): void;
  clear(): void;
}

/** Thumbnail strip: select, reorder and remove frames. */
export class Filmstrip {
  readonly #store: AppStore;
  readonly #list = byId("filmstrip", HTMLOListElement);
  readonly #count = byId("frameCount", HTMLSpanElement);
  readonly #actions: FilmstripActions;
  readonly #items = new Map<string, HTMLLIElement>();

  constructor(store: AppStore, actions: FilmstripActions) {
    this.#store = store;
    this.#actions = actions;
    byId("clearBtn", HTMLButtonElement).addEventListener("click", () => actions.clear());
    store.subscribe((state, previous) => {
      if (state.images !== previous.images || state.active !== previous.active) {
        this.#render(state);
      }
    });
    this.#render(store.state);
  }

  #createItem(image: SourceImage): HTMLLIElement {
    const thumb = h("img", { src: image.url, alt: "", loading: "lazy", draggable: "false" });
    const dot = h("span", { className: "film-dot" });
    const button = h("button", { className: "film-thumb", type: "button" }, thumb, dot, h("span", { className: "film-index" }));
    button.addEventListener("click", () => {
      const index = this.#store.state.images.findIndex((candidate) => candidate.id === image.id);
      this.#store.set({ active: index });
    });

    const left = h("button", { className: "film-action is-left", type: "button", "aria-label": "Move earlier" }, icon("chevron-left"));
    const right = h("button", { className: "film-action is-right", type: "button", "aria-label": "Move later" }, icon("chevron-right"));
    const remove = h("button", { className: "film-action is-remove", type: "button", "aria-label": `Remove ${image.name}` }, icon("close"));
    left.addEventListener("click", () => this.#actions.move(image.id, -1));
    right.addEventListener("click", () => this.#actions.move(image.id, 1));
    remove.addEventListener("click", () => this.#actions.remove(image.id));

    return h(
      "li",
      { className: "film-item", "data-id": image.id },
      button,
      h("div", { className: "film-actions" }, left, right, remove),
      h("span", { className: "film-name", title: image.name }, image.name),
    );
  }

  #render(state: AppState): void {
    const live = new Set(state.images.map((image) => image.id));
    for (const [id, item] of this.#items) {
      if (!live.has(id)) {
        item.remove();
        this.#items.delete(id);
      }
    }

    const nodes: HTMLElement[] = state.images.map((image, index) => {
      let item = this.#items.get(image.id);
      if (!item) {
        item = this.#createItem(image);
        this.#items.set(image.id, item);
      }
      const current = index === state.active;
      item.setAttribute("aria-current", String(current));
      item.dataset.focusSet = String(image.focusSet);
      const dot = item.querySelector<HTMLElement>(".film-dot");
      const thumb = item.querySelector<HTMLImageElement>(".film-thumb img");
      if (dot && thumb) {
        // Thumbnails use object-fit: cover, so map the focus through the cover crop.
        const scale = Math.max(1 / image.width, 1 / image.height);
        const offsetX = (1 - image.width * scale) / 2;
        const offsetY = (1 - image.height * scale) / 2;
        dot.style.left = `${(offsetX + image.focus.x * scale) * 100}%`;
        dot.style.top = `${(offsetY + image.focus.y * scale) * 100}%`;
        dot.hidden = offsetX + image.focus.x * scale < 0 || offsetX + image.focus.x * scale > 1 || offsetY + image.focus.y * scale < 0 || offsetY + image.focus.y * scale > 1;
      }
      const label = item.querySelector(".film-index");
      if (label) {
        label.textContent = String(index + 1);
      }
      const thumbButton = item.querySelector<HTMLButtonElement>(".film-thumb");
      thumbButton?.setAttribute(
        "aria-label",
        `Frame ${index + 1}: ${image.name}${image.focusSet ? "" : " (focus not set)"}${current ? ", selected" : ""}`,
      );
      item.querySelector<HTMLButtonElement>(".is-left")!.disabled = index === 0;
      item.querySelector<HTMLButtonElement>(".is-right")!.disabled = index === state.images.length - 1;
      return item;
    });

    const add = h("button", { className: "film-add", type: "button" }, icon("upload"), "Add photos");
    add.addEventListener("click", () => this.#actions.addFiles());
    this.#list.replaceChildren(...nodes, h("li", { className: "film-item" }, add));
    this.#count.textContent = String(state.images.length);
    this.#list.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
}
