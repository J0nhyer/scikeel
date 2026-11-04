import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { useToastStore } from "@/lib/toast";
import { Toaster } from "@/components/ui/Toaster";
import { ManagedRuntimeModelsCard } from "./ManagedRuntimeModelsCard";

describe("ManagedRuntimeModelsCard", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    useToastStore.getState().reset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useToastStore.getState().reset();
  });

  it("saves the administrator-managed Codex catalog", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          managedRuntimes: {
            claude: { models: ["sonnet", "opus"], defaultModel: "sonnet" },
            codex: { models: ["gpt-fast"], defaultModel: "gpt-fast" },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<ManagedRuntimeModelsCard />);
    const models = await screen.findByLabelText("Codex enabled models");
    await user.clear(models);
    await user.type(models, "gpt-fast\ngpt-deep");
    await user.selectOptions(screen.getByLabelText("Codex default model"), "gpt-deep");
    await user.click(screen.getByRole("button", { name: "Save Codex models" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/admin/runtime"),
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            runtime: "codex",
            models: ["gpt-fast", "gpt-deep"],
            defaultModel: "gpt-deep",
          }),
        }),
      ),
    );
  });

  it("shows a load failure in the global card", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: "fixture load failure" }),
      { status: 500, headers: { "content-type": "application/json" } },
    )));
    render(<><ManagedRuntimeModelsCard /><Toaster /></>);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save Managed CLI models: fixture load failure");
    expect(screen.getByRole("alert")).toHaveAttribute("data-error-card", "true");
  });

  it("shows a save failure in the global card", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ error: "fixture save failure" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        managedRuntimes: { codex: { models: ["gpt-fast"], defaultModel: "gpt-fast" } },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<><ManagedRuntimeModelsCard /><Toaster /></>);
    await screen.findByLabelText("Codex enabled models");
    await user.click(screen.getByRole("button", { name: "Save Codex models" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save Codex models: fixture save failure");
    expect(screen.getByRole("alert")).toHaveAttribute("data-error-card", "true");
  });
});
