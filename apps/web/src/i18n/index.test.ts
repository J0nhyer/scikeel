import { describe, expect, it } from "vitest";
import i18n, { NAMESPACES } from "./index";

describe("i18n instance", () => {
  it("initializes with English and the full namespace set", () => {
    expect(i18n.language).toBe("en");
    expect(NAMESPACES).toContain("common");
    expect(NAMESPACES.length).toBe(8);
  });

  it("resolves a seeded key", () => {
    expect(i18n.t("common:actions.save")).toBe("Save");
  });

  it("falls back to Chinese for an unsupported language", async () => {
    await i18n.changeLanguage("pt-BR");
    // pt-BR has no bundled resources → i18next falls back to the default locale.
    expect(i18n.t("common:actions.save")).toBe("保存");
    await i18n.changeLanguage("en");
  });
});
