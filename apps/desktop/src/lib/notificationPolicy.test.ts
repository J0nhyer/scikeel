import { describe, expect, it } from "vitest";
import { appendConsumed, defaultToastMs, expiryAt } from "./notificationPolicy";
describe("notification deadline policy", () => {
  it("caps every deadline independently of reading pauses", () => {
    expect(defaultToastMs("success")).toBe(5000); expect(defaultToastMs("warning")).toBe(10_000);
    expect(expiryAt(29_000, 0, 5000)).toBe(30_000);
  });
  it("bounds and deduplicates consumed event IDs", () => {
    const ids = Array.from({ length: 200 }, (_, i) => String(i));
    expect(appendConsumed(ids, "new")).toHaveLength(200);
    expect(appendConsumed(ids, "199")).toEqual(ids);
  });
});
