import { sanitizeOptions, type AnimationOptions } from "../core/options";
import { byId } from "./dom";

const OPTIONS_KEY = "pikugo:options";
const THEME_KEY = "pikugo:theme";
const AUTO_MATCH_KEY = "pikugo:auto-match";

/** Storage can be unavailable (private mode, blocked cookies), so every access is guarded. */
function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Settings simply won't persist.
  }
}

export function loadOptions(): AnimationOptions {
  const saved = read(OPTIONS_KEY);
  if (!saved) {
    return sanitizeOptions(undefined);
  }
  try {
    return sanitizeOptions(JSON.parse(saved));
  } catch {
    return sanitizeOptions(undefined);
  }
}

export function saveOptions(options: AnimationOptions): void {
  write(OPTIONS_KEY, JSON.stringify(options));
}

type Theme = "light" | "dark";

function systemTheme(): Theme {
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Light/dark toggle in the header. Follows the system until the user picks. */
export function setupThemeToggle(): void {
  const button = byId("themeToggle", HTMLButtonElement);
  const icon = button.querySelector(".icon");
  const current = (): Theme => {
    const explicit = document.documentElement.dataset.theme;
    return explicit === "light" || explicit === "dark" ? explicit : systemTheme();
  };
  const sync = () => {
    const dark = current() === "dark";
    icon?.classList.toggle("i-sun", dark);
    icon?.classList.toggle("i-moon", !dark);
    button.setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#0d0c14" : "#6d4aff");
  };
  button.addEventListener("click", () => {
    const next: Theme = current() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    write(THEME_KEY, next);
    sync();
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", sync);
  sync();
}

/** Whether auto-matching focal points is on (defaults to on). */
export function loadAutoMatch(): boolean {
  return read(AUTO_MATCH_KEY) !== "off";
}

export function saveAutoMatch(enabled: boolean): void {
  write(AUTO_MATCH_KEY, enabled ? "on" : "off");
}
