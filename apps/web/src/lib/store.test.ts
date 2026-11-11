import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUiStore } from "./store";

describe("uiStore theme", () => {
  it("keeps appearance changes usable when browser storage is blocked", () => {
    const write = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => { throw Error("Storage blocked"); });
    try {
      useUiStore.getState().setTheme("cdut");
      useUiStore.getState().setCampusDecoration(false);
      expect(useUiStore.getState().theme).toBe("cdut");
      expect(useUiStore.getState().campusDecoration).toBe(false);
    } finally { write.mockRestore(); }
  });
  beforeEach(() => {
    window.localStorage.clear();
    useUiStore.setState({ theme: "warm" });
  });

  it("cycles theme and persists to localStorage", () => {
    useUiStore.getState().toggleTheme();
    expect(useUiStore.getState().theme).toBe("light");
    expect(window.localStorage.getItem("ai4s.theme.v2")).toBe("light");

    useUiStore.getState().toggleTheme();
    expect(useUiStore.getState().theme).toBe("dark");
    expect(window.localStorage.getItem("ai4s.theme.v2")).toBe("dark");

    useUiStore.getState().toggleTheme();
    expect(useUiStore.getState().theme).toBe("system");
    expect(window.localStorage.getItem("ai4s.theme.v2")).toBe("system");
    useUiStore.getState().toggleTheme();
    expect(useUiStore.getState().theme).toBe("cdut");
    useUiStore.getState().toggleTheme();
    expect(useUiStore.getState().theme).toBe("light");
  });
});
