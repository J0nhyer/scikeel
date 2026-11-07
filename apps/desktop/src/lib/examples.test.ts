import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactBlock } from "@ai4s/shared";
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

  it("ships no worker paths, account ids, instance ids, or internal URLs", () => {
    const dir = join(process.cwd(), "src/lib/examples/captured");
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
      const text = readFileSync(join(dir, file), "utf8");
      expect(text, file).not.toMatch(
        /\/srv\/|\/opt\/|\/Users\/|\busr_[A-Za-z0-9]+|\bses_[A-Za-z0-9]+|instanceId|localhost|127\.0\.0\.1|https?:\/\/172\.|https?:\/\/10\.|broker|\.scikeel\b/,
      );
    }
  });

  it("keeps one artifact card per path and the literature deliverables' final content", () => {
    for (const id of EXAMPLE_IDS) {
      const session = findExampleSession(id)!;
      const artifacts = session.blocks.filter((block): block is ArtifactBlock => block.kind === "artifact");
      expect(new Set(artifacts.map((artifact) => artifact.path)).size, id).toBe(artifacts.length);
      expect(artifacts.every((artifact) => !artifact.path.includes(".scikeel")), id).toBe(true);
    }
    const lit = findExampleSession("lit-review-citations")!;
    const artifacts = lit.blocks.filter((block): block is ArtifactBlock => block.kind === "artifact");
    const references = artifacts.find((artifact) => artifact.path.endsWith("references.csv"));
    expect(references?.content?.trim().split("\n").length ?? 0).toBeGreaterThanOrEqual(11);
    const searchLog = artifacts.find((artifact) => artifact.path.endsWith("search_log.md"));
    expect(searchLog?.content).toContain("staged corpus fallback");
  });

  it("keeps the review conclusion and limitations in the PDF facsimile", () => {
    const lit = findExampleSession("lit-review-citations")!;
    expect(lit.inspector?.variant).toBe("pdf");
    if (lit.inspector?.variant === "pdf") {
      const headings = lit.inspector.doc.sections.map((section) => section.heading);
      expect(headings.some((heading) => heading.includes("结论"))).toBe(true);
      expect(headings.some((heading) => heading.includes("局限"))).toBe(true);
    }
  });
});
