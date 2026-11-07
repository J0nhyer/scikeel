import type { Session } from "@ai4s/shared";

export type ExampleId =
  | "lit-review-citations"
  | "data-analysis-figures"
  | "report-traceability-audit"
  | "ml-student-performance";

export interface ExampleMeta {
  id: ExampleId;
  title: string;
  summary: string;
}

export const EXAMPLE_IDS: ExampleId[] = [
  "lit-review-citations",
  "data-analysis-figures",
  "report-traceability-audit",
  "ml-student-performance",
];

/** Menu copy. The session bodies are captured from real runs in Task 5; these
 *  titles and summaries stay stable so links and the menu agree. */
export const EXAMPLE_META: ExampleMeta[] = [
  {
    id: "lit-review-citations",
    title: "文献综述与引用核查",
    summary: "检索核心文献、写出综述，并逐条核对引用",
  },
  {
    id: "data-analysis-figures",
    title: "数据分析与发表级出图",
    summary: "从一份真实公开数据出发，完成分析、统计检查和发表级图表",
  },
  {
    id: "report-traceability-audit",
    title: "报告可追溯审查",
    summary: "审查一份中文报告：引用、无来源数字、图表与代码是否对得上",
  },
  {
    id: "ml-student-performance",
    title: "机器学习：学生成绩预测",
    summary: "用真实公开数据训练并比较模型，出指标、混淆矩阵和特征重要性",
  },
];

/** Phase A placeholders: replaced by captured real runs before publication. */
export const exampleSessions: Session[] = EXAMPLE_META.map((example) => ({
  id: example.id,
  projectId: "examples",
  title: example.title,
  group: "Examples",
  status: "done",
  blocks: [{ kind: "agent", markdown: "示例内容生成中…" }],
}));

const sessionsById = new Map(exampleSessions.map((session) => [session.id, session]));

export function findExampleSession(id: string): Session | undefined {
  return sessionsById.get(id);
}
