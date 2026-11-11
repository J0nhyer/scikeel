import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCALE,
  LOCALES,
  localeMeta,
  resolveLocale,
  shippedLocales,
} from "./config";

describe("locale registry", () => {
  it("ships exactly Chinese and English, in switcher order", () => {
    expect(shippedLocales().map((l) => l.code)).toEqual(["zh-Hans", "en"]);
  });

  it("defaults to Simplified Chinese", () => {
    expect(DEFAULT_LOCALE).toBe("zh-Hans");
  });

  it("marks every locale as left-to-right", () => {
    for (const l of LOCALES) expect(l.dir).toBe("ltr");
  });

  it("has a native name for every locale", () => {
    for (const l of LOCALES) expect(l.nativeName.length).toBeGreaterThan(0);
  });

  it("no longer registers removed locales", () => {
    for (const code of ["ja", "es", "de", "fr", "ko", "pt-BR", "ar"]) {
      expect(localeMeta(code)).toBeUndefined();
    }
  });
});

describe("resolveLocale", () => {
  it("returns an exact shipped match (case-insensitive)", () => {
    expect(resolveLocale("en")).toBe("en");
    expect(resolveLocale("EN")).toBe("en");
    expect(resolveLocale("zh-Hans")).toBe("zh-Hans");
  });

  it("falls back to a base-language match", () => {
    expect(resolveLocale("en-GB")).toBe("en");
    expect(resolveLocale("zh-CN")).toBe("zh-Hans");
    expect(resolveLocale("zh")).toBe("zh-Hans");
  });

  it("falls back to Chinese for removed or unknown locales", () => {
    expect(resolveLocale("ja")).toBe(DEFAULT_LOCALE);
    expect(resolveLocale("fr-CA")).toBe(DEFAULT_LOCALE);
    expect(resolveLocale("pt-BR")).toBe(DEFAULT_LOCALE);
    expect(resolveLocale("ar")).toBe(DEFAULT_LOCALE);
  });

  it("falls back to the default for unknown or empty input", () => {
    expect(resolveLocale("xx")).toBe(DEFAULT_LOCALE);
    expect(resolveLocale(null)).toBe(DEFAULT_LOCALE);
    expect(resolveLocale(undefined)).toBe(DEFAULT_LOCALE);
  });
});
