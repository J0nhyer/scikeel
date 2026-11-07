import { screen } from "@testing-library/react";
import { describe, expect, it, beforeEach } from "vitest";
import { useUiStore } from "@/lib/store";
import { renderAt } from "@/test/render";

const base = "/example";

const examples = [
  ["lit-review-citations", "文献综述与引用核查"],
  ["data-analysis-figures", "数据分析与发表级出图"],
  ["report-traceability-audit", "报告可追溯审查"],
  ["ml-student-performance", "机器学习：学生成绩预测"],
] as const;

describe("SessionPage", () => {
  beforeEach(() => useUiStore.setState({ inspectorOpen: true }));

  it.each(examples)("renders %s", (id, title) => {
    renderAt(`${base}/${id}`);
    expect(screen.getAllByText(title).length).toBeGreaterThan(0);
  });

  it("shows a not-found state for an unknown session", () => {
    renderAt(`${base}/nope`);
    expect(screen.getByText("Session not found")).toBeInTheDocument();
  });

  it("does not resolve a removed example id", () => {
    renderAt(`${base}/lit-review`);
    expect(screen.getByText("Session not found")).toBeInTheDocument();
  });
});
