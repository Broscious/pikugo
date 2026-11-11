/** Look up a required element by id, checking its type. */
export function byId<T extends HTMLElement>(id: string, type: new () => T, root: Document = document): T {
  const element = root.getElementById(id);
  if (!(element instanceof type)) {
    throw new Error(`Expected #${id} to be a ${type.name}`);
  }
  return element;
}

type Attributes = Record<string, string | number | boolean | undefined>;

/** Create an element with attributes and children. `false`/`undefined` attributes are skipped. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Attributes = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === false) {
      continue;
    }
    if (name === "className") {
      element.className = String(value);
    } else {
      element.setAttribute(name, value === true ? "" : String(value));
    }
  }
  element.append(...children);
  return element;
}

export function icon(name: string): HTMLSpanElement {
  return h("span", { className: `icon i-${name}`, "aria-hidden": "true" });
}

/** Set a range input's value and update the filled-track CSS variable. */
export function setRange(input: HTMLInputElement, value: number): void {
  input.value = String(value);
  syncRangeFill(input);
}

export function syncRangeFill(input: HTMLInputElement): void {
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  const fraction = max > min ? (Number(input.value) - min) / (max - min) : 0;
  input.style.setProperty("--fill", `${Math.min(1, Math.max(0, fraction)) * 100}%`);
}

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}
