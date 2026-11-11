import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useIsMobile } from "@/lib/useIsMobile";

const setWidth = (px: number) => {
  Object.defineProperty(window, "innerWidth", { value: px, configurable: true });
};

afterEach(() => {
  setWidth(1024); // jsdom's default
});

describe("useIsMobile", () => {
  it("is mobile only below the breakpoint", () => {
    setWidth(1200);
    expect(renderHook(() => useIsMobile()).result.current).toBe(false);
    setWidth(700);
    expect(renderHook(() => useIsMobile()).result.current).toBe(true);
    // Exactly at the breakpoint counts as mobile, matching `max-width: 768px`.
    setWidth(768);
    expect(renderHook(() => useIsMobile()).result.current).toBe(true);
  });
});
