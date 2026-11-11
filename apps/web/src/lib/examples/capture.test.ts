import type { ThreadBlock } from "@ai4s/shared";
import { describe, expect, it } from "vitest";
import { redactExampleText, trimBlocks } from "./capture";

describe("capture", () => {
  it("redacts the worker workspace prefix to a workspace-relative path", () => {
    expect(
      redactExampleText("/srv/scikeel/data/workers/usr_abc/workspace/demo/report.md"),
    ).toBe("demo/report.md");
  });

  it("drops reasoning blocks and keeps the visible answer", () => {
    const blocks: ThreadBlock[] = [
      { kind: "reasoning", text: "internal thinking" },
      { kind: "agent", markdown: "ok" },
    ];
    expect(trimBlocks(blocks)).toEqual([{ kind: "agent", markdown: "ok" }]);
  });
});
