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
});
