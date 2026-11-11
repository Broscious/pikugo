import { describe, expect, it, vi } from "vitest";
import { Store } from "../../src/ui/store";

describe("Store", () => {
  it("merges patches and notifies listeners with the previous state", () => {
    const store = new Store({ count: 1, label: "a" });
    const listener = vi.fn();
    store.subscribe(listener);
    store.set({ count: 2 });
    expect(store.state).toEqual({ count: 2, label: "a" });
    expect(listener).toHaveBeenCalledWith({ count: 2, label: "a" }, { count: 1, label: "a" });
  });

  it("accepts updater functions", () => {
    const store = new Store({ count: 1 });
    store.set((s) => ({ count: s.count + 1 }));
    expect(store.state.count).toBe(2);
  });

  it("skips no-op updates", () => {
    const store = new Store({ count: 1 });
    const listener = vi.fn();
    store.subscribe(listener);
    store.set({ count: 1 });
    expect(listener).not.toHaveBeenCalled();
  });

  it("unsubscribes", () => {
    const store = new Store({ count: 1 });
    const listener = vi.fn();
    const off = store.subscribe(listener);
    off();
    store.set({ count: 2 });
    expect(listener).not.toHaveBeenCalled();
  });
});
