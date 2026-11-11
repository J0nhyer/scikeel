import { afterEach, describe, expect, it } from "vitest";
import i18n from "./index";
import { formatDate, formatNumber } from "./format";

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("formatNumber", () => {
  it("groups by the active locale", async () => {
    await i18n.changeLanguage("en");
    expect(formatNumber(1234567)).toBe("1,234,567");
    await i18n.changeLanguage("zh-Hans");
    expect(formatNumber(1234567)).toBe("1,234,567");
  });
});

describe("formatDate", () => {
  it("uses the active locale's date order", async () => {
    const date = new Date(2026, 10, 11);
    await i18n.changeLanguage("en");
    expect(formatDate(date)).toBe("11/11/2026");
    await i18n.changeLanguage("zh-Hans");
    expect(formatDate(date)).toBe("2026/11/11");
  });
});
