import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderAt } from "@/test/render";
import { useUiStore } from "@/lib/store";
import { shippedLocales } from "@/i18n/config";

describe("Settings language selector", () => {
  it("shows a Language select with one option per shipped locale", async () => {
    renderAt("/settings/appearance");
    const select = await screen.findByRole("combobox", { name: "Language" });
    expect(within(select).getAllByRole("option")).toHaveLength(shippedLocales().length);
  });

  it("updates the store locale on change", async () => {
    renderAt("/settings/appearance");
    const select = await screen.findByRole("combobox", { name: "Language" });
    await userEvent.selectOptions(select, "zh-Hans");
    expect(useUiStore.getState().locale).toBe("zh-Hans");
    useUiStore.getState().setLocale("en");
  });
});

describe("Settings page (Web surfaces)", () => {
  it("renders General with the review and stall-guard controls", async () => {
    renderAt("/settings");
    expect(await screen.findByRole("heading", { level: 1, name: "General" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Review" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Stall guard" })).toBeInTheDocument();
    expect(
      screen.getByRole("switch", { name: "Review after every turn that changes files" }),
    ).toBeInTheDocument();
  });

  it("resolves a removed desktop section to General", async () => {
    renderAt("/settings/runtime");
    expect(await screen.findByRole("heading", { level: 1, name: "General" })).toBeInTheDocument();
    expect(screen.queryByText("Agent runtime")).not.toBeInTheDocument();
  });

  it("renders the gateway model surface", async () => {
    renderAt("/settings/models");
    expect(await screen.findByRole("region", { name: "Models" })).toBeInTheDocument();
  });

  it("renders appearance and privacy", async () => {
    const appearance = renderAt("/settings/appearance");
    expect(await screen.findByRole("heading", { level: 1, name: "Appearance" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Language" })).toBeInTheDocument();
    appearance.unmount();

    renderAt("/settings/privacy");
    expect(await screen.findByRole("heading", { level: 1, name: "Privacy" })).toBeInTheDocument();
  });
});
