import { isTauri } from "./tauri";

/** Copy from a browser click when the modern clipboard API is unavailable. */
function copyWithSelection(text: string): void {
  const active = document.activeElement;
  const inputSelection = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
    ? { start: active.selectionStart, end: active.selectionEnd, direction: active.selectionDirection }
    : null;
  const selection = window.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  textarea.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;font-size:16px";
  // Keep the selection inside any open modal focus trap.
  (active?.closest('[role="dialog"], dialog') ?? document.body).appendChild(textarea);
  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    if (!document.execCommand("copy")) throw new Error("Clipboard copy was rejected");
  } finally {
    textarea.remove();
    if (active instanceof HTMLElement) active.focus({ preventScroll: true });
    if (inputSelection && (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) && inputSelection.start !== null) {
      active.setSelectionRange(inputSelection.start, inputSelection.end, inputSelection.direction ?? undefined);
    }
    if (selection) {
      selection.removeAllRanges();
      ranges.forEach((range) => selection.addRange(range));
    }
  }
}

/** Use the native desktop clipboard, or browser APIs with an HTTP-compatible fallback. */
export async function copyText(text: string): Promise<void> {
  if (isTauri) {
    const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
    await writeText(text);
    return;
  }
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // A browser may expose the API but reject it through its permission policy.
    }
  }
  copyWithSelection(text);
}
