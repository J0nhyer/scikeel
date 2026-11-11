import { describe, expect, it } from "vitest";
import { webModelChoices, webReasoningEffort } from "./webModelCatalog";
import type { GatewayRuntimeOption } from "./runtime";

const runtimes = [
  { runtime: "opencode", kind: "opencode", managed: false, label: "OpenCode", enabled: true, models: [], defaultModel: null, selectedModel: null },
  { runtime: "claude", kind: "server", managed: true, label: "Claude Code", enabled: true, models: ["sonnet"], defaultModel: "sonnet", selectedModel: "sonnet" },
  { runtime: "codex", kind: "server", managed: true, label: "Codex", enabled: true, models: ["gpt-fast", "gpt-deep"], defaultModel: "gpt-fast", selectedModel: "gpt-fast" },
] satisfies GatewayRuntimeOption[];

describe("webModelChoices", () => {
  it("isolates managed models by AI assistant", () => {
    expect(webModelChoices("codex", [], runtimes).map((model) => model.key)).toEqual([
      "codex/gpt-fast", "codex/gpt-deep",
    ]);
    expect(webModelChoices("claude", [], runtimes).map((model) => model.key)).toEqual(["claude/sonnet"]);
  });

  it("keeps OpenCode providers separate from managed catalogs", () => {
    const providers = [{ id: "openai", name: "OpenAI", models: [{ id: "gpt-one", name: "GPT One" }] }];
    expect(webModelChoices("opencode", providers, runtimes).map((model) => model.key)).toEqual(["openai/gpt-one"]);
    expect(webModelChoices("codex", providers, runtimes).map((model) => model.key)).toEqual([
      "codex/gpt-fast", "codex/gpt-deep",
    ]);
  });

  it("returns no choices for an unavailable assistant", () => {
    expect(webModelChoices("claude", [], runtimes.map((runtime) => runtime.runtime === "claude" ? { ...runtime, enabled: false } : runtime))).toEqual([]);
  });
});

describe("webReasoningEffort", () => {
  it.each([
    [["high", "low", "medium"], "low"],
    [["high", "minimal", "low"], "minimal"],
    [["enabled", "disabled"], "disabled"],
    [["max", "none", "low"], "none"],
  ])("uses the lowest supported level regardless of catalog order: %j", (variants, expected) => {
    expect(webReasoningEffort(variants as string[], null)).toBe(expected);
    expect(webReasoningEffort(variants as string[], "unsupported")).toBe(expected);
  });
  it("preserves a supported selection and omits effort for unsupported models", () => {
    expect(webReasoningEffort(["low", "high"], "high")).toBe("high");
    expect(webReasoningEffort([], "high")).toBeUndefined();
  });
});
