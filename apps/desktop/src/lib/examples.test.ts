import { describe, expect, it } from "vitest";
import { EXAMPLE_IDS, EXAMPLE_META, exampleSessions, findExampleSession } from "./examples";

describe("examples", () => {
  it("ships four examples in display order", () => {
    expect(EXAMPLE_IDS).toEqual([
      "lit-review-citations",
      "data-analysis-figures",
      "report-traceability-audit",
      "ml-student-performance",
    ]);
    expect(EXAMPLE_META.map((item) => item.id)).toEqual(EXAMPLE_IDS);
    expect(exampleSessions.map((session) => session.id)).toEqual(EXAMPLE_IDS);
  });

  it("resolves an example and rejects an unknown id", () => {
    expect(findExampleSession("lit-review-citations")?.title).toBe("文献综述与引用核查");
    expect(findExampleSession("ml-student-performance")?.title).toBe("机器学习：学生成绩预测");
    expect(findExampleSession("lit-review")).toBeUndefined();
  });

  it("ships the real literature run with a citation finding and the PDF facsimile", () => {
    const session = findExampleSession("lit-review-citations")!;
    expect(session.blocks.some((block) => block.kind === "user" && block.text.includes("AI 辅助学习"))).toBe(true);
    expect(session.blocks.some((block) =>
      block.kind === "reviewer" && block.findings.some((finding) => finding.check === "citation"))).toBe(true);
    expect(session.inspector?.variant).toBe("pdf");
    if (session.inspector?.variant === "pdf") expect(session.inspector.title).toBe("review.pdf");
  });

  it("ships the real data run with a figure and a results table", () => {
    const session = findExampleSession("data-analysis-figures")!;
    expect(session.blocks.some((block) => block.kind === "figure")).toBe(true);
    expect(session.blocks.some((block) => block.kind === "table")).toBe(true);
  });

  it("ships the real audit run with a warning finding", () => {
    const session = findExampleSession("report-traceability-audit")!;
    expect(session.blocks.some((block) =>
      block.kind === "reviewer" && block.findings.some((finding) => finding.level === "warn"))).toBe(true);
  });

  it("ships the real ML run with a metrics table and figures", () => {
    const session = findExampleSession("ml-student-performance")!;
    expect(session.blocks.some((block) => block.kind === "table")).toBe(true);
    expect(session.blocks.some((block) => block.kind === "figure")).toBe(true);
  });

  it("ships no worker paths, account ids, or instance ids", () => {
    expect(JSON.stringify(exampleSessions)).not.toMatch(/\/srv\/scikeel|usr_[a-f0-9]+|instanceId/);
  });
});
