import { describe, expect, it } from "vitest";
import { normalizeAppearance, readAppearance, resolveAppearance } from "./appearance";

describe("appearance preferences", () => {
  it("follows the system only for the System choice", () => {
    expect(resolveAppearance("system", true)).toBe("dark");
    expect(resolveAppearance("system", false)).toBe("light");
    expect(resolveAppearance("cdut", true)).toBe("cdut");
  });
  it("retains legacy Warm without treating it as campus appearance", () => {
    expect(normalizeAppearance("warm")).toBe("warm");
    expect(readAppearance((key) => key === "ai4s.theme" ? "light" : null)).toBe("warm");
  });
  it("uses System for missing, invalid, or inaccessible preferences", () => {
    expect(normalizeAppearance("unknown")).toBeNull();
    expect(readAppearance(() => null)).toBe("system");
    expect(readAppearance(() => "invalid")).toBe("system");
    expect(readAppearance(() => { throw new Error("Storage blocked"); })).toBe("system");
  });
});
