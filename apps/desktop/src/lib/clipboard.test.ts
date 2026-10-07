import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard";

vi.mock("./tauri", () => ({ isTauri: false }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
  window.getSelection()?.removeAllRanges();
});

describe("browser clipboard", () => {
  it("uses the modern API when available", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await copyText("selected passage");
    expect(writeText).toHaveBeenCalledWith("selected passage");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it.each([false, true])("copies the exact passage without modern API access (rejected: %s)", async (rejected) => {
    const writeText = vi.fn(async () => { throw new DOMException("Blocked", "NotAllowedError"); });
    vi.stubGlobal("navigator", rejected ? { clipboard: { writeText } } : {});
    const paragraph = document.createElement("p");
    paragraph.textContent = "original selected text";
    document.body.append(paragraph);
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    window.getSelection()!.addRange(range);
    const execute = vi.fn(() => {
      expect(document.activeElement).toBeInstanceOf(HTMLTextAreaElement);
      expect((document.activeElement as HTMLTextAreaElement).value).toBe("一小段内容\nsecond line");
      return true;
    });
    vi.stubGlobal("document", document);
    Object.defineProperty(document, "execCommand", { configurable: true, value: execute });
    await copyText("一小段内容\nsecond line");
    expect(execute).toHaveBeenCalledWith("copy");
    expect(window.getSelection()!.toString()).toBe("original selected text");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("restores an input's focus and selection even when copying fails", async () => {
    vi.stubGlobal("navigator", {});
    Object.defineProperty(document, "execCommand", { configurable: true, value: vi.fn(() => false) });
    const input = document.createElement("textarea");
    input.value = "unfinished draft";
    document.body.append(input);
    input.focus();
    input.setSelectionRange(2, 6, "backward");
    await expect(copyText("passage")).rejects.toThrow("Clipboard copy was rejected");
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd, input.selectionDirection]).toEqual([2, 6, "backward"]);
    expect(document.querySelectorAll("textarea")).toHaveLength(1);
  });
});
