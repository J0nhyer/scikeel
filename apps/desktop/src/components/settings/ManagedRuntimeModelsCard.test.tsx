import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { ManagedRuntimeModelsCard } from "./ManagedRuntimeModelsCard";

describe("ManagedRuntimeModelsCard", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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
});
