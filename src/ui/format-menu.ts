import { h } from "./dom";

export interface FormatChoice<T extends string> {
  value: T;
  label: string;
  description: string;
}

interface FormatMenuOptions<T extends string> {
  /** The ▾ button that opens the menu. */
  toggle: HTMLButtonElement;
  /** The (initially hidden) menu element. */
  menu: HTMLElement;
  choices: readonly FormatChoice<T>[];
  /** Called when a format is picked. */
  onChoose: (value: T) => void;
}

/**
 * The format picker on a split button: a menu of radio items, each with a
 * short description. Picking one sets the format; the main button then uses it.
 */
export class FormatMenu<T extends string> {
  readonly #toggle: HTMLButtonElement;
  readonly #menu: HTMLElement;
  readonly #items: HTMLButtonElement[];
  readonly #onChoose: (value: T) => void;

  constructor({ toggle, menu, choices, onChoose }: FormatMenuOptions<T>) {
    this.#toggle = toggle;
    this.#menu = menu;
    this.#onChoose = onChoose;
    this.#items = choices.map((choice) =>
      h(
        "button",
        { type: "button", role: "menuitemradio", "aria-checked": "false", "data-value": choice.value, tabindex: -1 },
        h("span", { className: "icon i-check menu-check", "aria-hidden": "true" }),
        h("span", { className: "menu-label" }, choice.label),
        h("span", { className: "menu-description" }, choice.description),
      ),
    );
    menu.replaceChildren(...this.#items);
    toggle.setAttribute("aria-haspopup", "menu");
    toggle.setAttribute("aria-expanded", "false");
    this.#bind();
  }

  /** Mark the current format. */
  setValue(value: T): void {
    for (const item of this.#items) {
      item.setAttribute("aria-checked", String(item.dataset.value === value));
    }
  }

  get #open(): boolean {
    return !this.#menu.hidden;
  }

  #show(focus: "checked" | "first" | "last" = "checked"): void {
    this.#menu.hidden = false;
    this.#toggle.setAttribute("aria-expanded", "true");
    const checked = this.#items.find((item) => item.getAttribute("aria-checked") === "true");
    const target = focus === "first" ? this.#items[0] : focus === "last" ? this.#items.at(-1) : (checked ?? this.#items[0]);
    target?.focus();
  }

  #hide(returnFocus: boolean): void {
    if (!this.#open) {
      return;
    }
    this.#menu.hidden = true;
    this.#toggle.setAttribute("aria-expanded", "false");
    if (returnFocus) {
      this.#toggle.focus();
    }
  }

  #bind(): void {
    this.#toggle.addEventListener("click", () => (this.#open ? this.#hide(false) : this.#show()));
    this.#toggle.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        this.#show(event.key === "ArrowDown" ? "first" : "last");
      }
    });
    for (const item of this.#items) {
      item.addEventListener("click", () => {
        this.#onChoose(item.dataset.value as T);
        this.#hide(true);
      });
    }
    this.#menu.addEventListener("keydown", (event) => {
      const index = this.#items.indexOf(document.activeElement as HTMLButtonElement);
      const move = (to: number) => {
        event.preventDefault();
        this.#items[(to + this.#items.length) % this.#items.length]?.focus();
      };
      switch (event.key) {
        case "ArrowDown":
          move(index + 1);
          break;
        case "ArrowUp":
          move(index - 1);
          break;
        case "Home":
          move(0);
          break;
        case "End":
          move(this.#items.length - 1);
          break;
        case "Escape":
          event.preventDefault();
          this.#hide(true);
          break;
        case "Tab":
          this.#hide(false);
          break;
      }
    });
    // Close when clicking anywhere else.
    document.addEventListener("pointerdown", (event) => {
      const target = event.target as Node;
      if (this.#open && !this.#menu.contains(target) && !this.#toggle.contains(target)) {
        this.#hide(false);
      }
    });
  }
}
