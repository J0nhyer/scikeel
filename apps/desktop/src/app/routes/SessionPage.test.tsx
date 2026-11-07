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

  it("renders the literature citation finding and the review PDF", () => {
    renderAt(`${base}/lit-review-citations`);
    expect(screen.getByText("DOI 指向另一篇文献")).toBeInTheDocument();
    expect(screen.getByText("review.pdf")).toBeInTheDocument();
  });

  it("renders the data figure and results table", () => {
    renderAt(`${base}/data-analysis-figures`);
    expect(screen.getAllByText("fig1_lifeexp_gdp_by_year.png").length).toBeGreaterThan(0);
    expect(screen.getByText(/逐年横截面 OLS/)).toBeInTheDocument();
  });

  it("renders the audit warning finding", () => {
    renderAt(`${base}/report-traceability-audit`);
    expect(screen.getByText("20.1 年无输出文件支撑")).toBeInTheDocument();
  });

  it("renders the ML metrics table and figure", () => {
    renderAt(`${base}/ml-student-performance`);
    expect(screen.getAllByText("LogisticRegression").length).toBeGreaterThan(0);
    expect(screen.getAllByText("confusion_matrix.png").length).toBeGreaterThan(0);
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
