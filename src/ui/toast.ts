import { h, icon } from "./dom";

type ToastKind = "info" | "success" | "error";

const ICONS: Record<ToastKind, string> = { info: "info", success: "check", error: "alert" };

/** Show a short dismissible notification. */
export function toast(message: string, kind: ToastKind = "info", timeoutMs = kind === "error" ? 8000 : 4000): void {
  const region = document.getElementById("toasts");
  if (!region) {
    return;
  }
  const close = h("button", { type: "button", "aria-label": "Dismiss" }, icon("close"));
  const element = h("div", { className: `toast toast-${kind}`, role: kind === "error" ? "alert" : "status" }, icon(ICONS[kind]), h("p", {}, message), close);
  const dismiss = () => element.remove();
  close.addEventListener("click", dismiss);
  region.append(element);
  setTimeout(dismiss, timeoutMs);
}
