export type Listener<T> = (state: T, previous: T) => void;

/** A tiny observable state container. State is treated as immutable. */
export class Store<T extends object> {
  #state: T;
  readonly #listeners = new Set<Listener<T>>();

  constructor(initial: T) {
    this.#state = initial;
  }

  get state(): T {
    return this.#state;
  }

  set(patch: Partial<T> | ((state: T) => Partial<T>)): void {
    const previous = this.#state;
    const changes = typeof patch === "function" ? patch(previous) : patch;
    const keys = Object.keys(changes) as (keyof T)[];
    if (keys.every((key) => Object.is(changes[key], previous[key]))) {
      return;
    }
    this.#state = { ...previous, ...changes };
    for (const listener of this.#listeners) {
      listener(this.#state, previous);
    }
  }

  subscribe(listener: Listener<T>): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
