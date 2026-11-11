import { act, render, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ThemeProvider } from "./ThemeProvider";
import { useUiStore } from "@/lib/store";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it("reacts to system changes, keeps CDUT light, and releases its listener", () => {
  let change: (() => void) | undefined;
  const media = { matches: false, addEventListener: vi.fn((_event, fn) => { change = fn; }), removeEventListener: vi.fn() };
  vi.spyOn(window, "matchMedia").mockReturnValue(media as unknown as MediaQueryList);
  useUiStore.setState({ theme: "system", systemDark: false });
  const { unmount } = render(<ThemeProvider><div /></ThemeProvider>);
  expect(document.documentElement.dataset.theme).toBe("light");
  act(() => { media.matches = true; change?.(); });
  expect(document.documentElement.dataset.theme).toBe("dark");
  act(() => useUiStore.getState().setTheme("cdut"));
  act(() => { media.matches = false; change?.(); });
  expect(document.documentElement.dataset.theme).toBe("cdut");
  unmount();
  expect(media.removeEventListener).toHaveBeenCalledWith("change", change);
});
