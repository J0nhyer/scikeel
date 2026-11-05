import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_LOCALE,
  detectInitialLocale,
  LOCALE_KEY,
  LOCALES,
  localeMeta,
  resolveLocale,
  shippedLocales,
} from "./config";

describe("locale registry", () => {
  it("ships exactly the 7 first-batch locales, in order", () => {
    expect(shippedLocales().map((l) => l.code)).toEqual([
      "en", "zh-Hans", "ja", "es", "de", "fr", "ko",
    ]);
  });

  it("registers pt-BR and ar but does not ship them", () => {
    expect(localeMeta("pt-BR")?.shipped).toBe(false);
    expect(localeMeta("ar")?.shipped).toBe(false);
  });

  it("marks ar as right-to-left and the rest left-to-right", () => {
    expect(localeMeta("ar")?.dir).toBe("rtl");
    for (const l of LOCALES.filter((x) => x.code !== "ar")) {
      expect(l.dir).toBe("ltr");
    }
  });

  it("has a native name for every locale", () => {
    for (const l of LOCALES) expect(l.nativeName.length).toBeGreaterThan(0);
  });
});

describe("resolveLocale", () => {
  it("returns an exact shipped match (case-insensitive)", () => {
    expect(resolveLocale("ja")).toBe("ja");
    expect(resolveLocale("JA")).toBe("ja");
    expect(resolveLocale("zh-Hans")).toBe("zh-Hans");
  });

  it("falls back to a base-language match", () => {
    expect(resolveLocale("en-GB")).toBe("en");
    expect(resolveLocale("zh-CN")).toBe("zh-Hans");
    expect(resolveLocale("fr-CA")).toBe("fr");
  });

  it("never resolves to an unshipped locale", () => {
    expect(resolveLocale("pt-BR")).toBe(DEFAULT_LOCALE);
    expect(resolveLocale("ar")).toBe(DEFAULT_LOCALE);
  });

  it("falls back to the default for unknown or empty input", () => {
    expect(resolveLocale("xx")).toBe(DEFAULT_LOCALE);
    expect(resolveLocale(null)).toBe(DEFAULT_LOCALE);
    expect(resolveLocale(undefined)).toBe(DEFAULT_LOCALE);
  });
});


describe("initial platform locale", () => {
  afterEach(() => {
    localStorage.removeItem(LOCALE_KEY);
    delete (window as Window & { __OS_PLATFORM__?: boolean }).__OS_PLATFORM__;
  });

  it("matches the Chinese login default even with an English browser", () => {
    localStorage.removeItem(LOCALE_KEY);
    (window as Window & { __OS_PLATFORM__?: boolean }).__OS_PLATFORM__ = true;
    expect(detectInitialLocale()).toBe("zh-Hans");
  });

  it("keeps the user's explicit language across refreshes", () => {
    (window as Window & { __OS_PLATFORM__?: boolean }).__OS_PLATFORM__ = true;
    localStorage.setItem(LOCALE_KEY, "en");
    expect(detectInitialLocale()).toBe("en");
  });
});
