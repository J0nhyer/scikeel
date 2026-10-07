import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("loads on HTTP browsers without randomUUID and assigns each page a random lease identifier", async () => {
  const browserCrypto = globalThis.crypto;
  vi.stubGlobal("crypto", { getRandomValues: browserCrypto.getRandomValues.bind(browserCrypto) });
  vi.resetModules();
  const first = await import("./research");
  expect(first.researchPageId).toMatch(/^page-[A-Za-z0-9_-]+$/);
  vi.resetModules();
  const second = await import("./research");
  expect(second.researchPageId).not.toBe(first.researchPageId);
});
