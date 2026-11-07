import type { Inspector, PdfDoc, PdfSection, Session, ThreadBlock } from "@ai4s/shared";
import litCaptured from "./examples/captured/lit-review-citations.json";
import litFinal from "./examples/captured/lit-review-citations.final.json";
import dataCaptured from "./examples/captured/data-analysis-figures.json";
import auditCaptured from "./examples/captured/report-traceability-audit.json";
import mlCaptured from "./examples/captured/ml-student-performance.json";
import { dataLifeExpGdp, dataSlopeR2, mlConfusionMatrix, mlFeatureImportance } from "./examples/assets";
import { redactExampleText } from "./examples/capture";

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

/** Menu copy. Every session body below is captured from a real local run. */
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

const dataTable: ThreadBlock = {
  kind: "table",
  columns: ["年份", "横截面斜率（每 log GDP）", "95% CI", "R²"],
  rows: [
    ["1952", "8.83", "7.52–10.14", "0.559"],
    ["1977", "7.55", "6.65–8.45", "0.662"],
    ["2007", "7.20", "6.33–8.08", "0.654"],
  ],
  caption: "逐年横截面 OLS：lifeExp ~ log(gdpPercap)，每年 142 个国家。来源 outputs/results.json。",
};

const dataFigure1: ThreadBlock = {
  kind: "figure",
  title: "fig1_lifeexp_gdp_by_year.png",
  src: dataLifeExpGdp,
  caption: "1952、1977、2007 年的预期寿命与人均 GDP（对数）；黑线为当年 OLS 拟合。",
};

const dataFigure2: ThreadBlock = {
  kind: "figure",
  title: "fig2_slope_r2_over_time.png",
  src: dataSlopeR2,
  caption: "横截面斜率与 R² 随年份变化：斜率缓慢下降，解释力先升后降。",
};

const mlTable: ThreadBlock = {
  kind: "table",
  columns: ["Model", "Accuracy", "Precision", "Recall", "F1", "ROC-AUC"],
  rows: [
    ["LogisticRegression", "0.658", "0.717", "0.811", "0.761", "0.589"],
    ["RandomForest", "0.633", "0.682", "0.849", "0.756", "0.621"],
  ],
  caption: "留出测试集 n=79；正类 = G3 ≥ 10。来源 metrics.json。",
};

const mlFigure1: ThreadBlock = {
  kind: "figure",
  title: "confusion_matrix.png",
  src: mlConfusionMatrix,
  caption: "留出测试集混淆矩阵（行 = 真实，列 = 预测；0 = Fail，1 = Pass）。",
};

const mlFigure2: ThreadBlock = {
  kind: "figure",
  title: "feature_importance.png",
  src: mlFeatureImportance,
  caption: "随机森林特征重要性前 15；failures、absences 居前。",
};

function insertBeforeReview(blocks: ThreadBlock[], artifacts: ThreadBlock[]): ThreadBlock[] {
  const reviewIndex = blocks.findIndex((block) => block.kind === "reviewer");
  if (reviewIndex < 0) return [...blocks, ...artifacts];
  return [...blocks.slice(0, reviewIndex), ...artifacts, ...blocks.slice(reviewIndex)];
}

const litFinalContent = litFinal as Record<string, string>;

function reviewDoc(): PdfDoc {
  const lines = redactExampleText(litFinalContent["examples/lit-review/review.md"] ?? "").split("\n");
  const title = lines.find((line) => line.startsWith("# "))?.slice(2).trim() ?? "文献综述";
  const sections: PdfSection[] = [];
  let current: { heading: string; body: string[] } | null = null;
  for (const line of lines) {
    if (line.startsWith("## ")) {
      if (current) sections.push({ heading: current.heading, body: current.body.join("\n").trim() });
      current = { heading: line.slice(3).trim(), body: [] };
    } else if (current) current.body.push(line);
  }
  if (current) sections.push({ heading: current.heading, body: current.body.join("\n").trim() });
  return {
    title,
    subtitle: "文献综述 · 10 条 OpenAlex 记录 · 离线语料回退",
    summaryTable: {
      kind: "table",
      columns: ["记录", "年份", "证据层级", "检索方式"],
      rows: [["10", "2017–2026", "abstract-only", "OpenAlex 离线语料"]],
    },
    sections: sections.filter((section) => section.body),
  };
}

const litInspector: Inspector = { variant: "pdf", title: "review.pdf", doc: reviewDoc() };

const litBlocks = (litCaptured as unknown as ThreadBlock[]).map((block) => {
  if (block.kind !== "artifact") return block;
  const content = litFinalContent[block.path];
  return content ? { ...block, content: redactExampleText(content) } : block;
});

const capturedById: Record<ExampleId, { blocks: ThreadBlock[]; inspector?: Inspector }> = {
  "lit-review-citations": {
    blocks: litBlocks,
    inspector: litInspector,
  },
  "data-analysis-figures": {
    blocks: insertBeforeReview(dataCaptured as unknown as ThreadBlock[], [dataTable, dataFigure1, dataFigure2]),
  },
  "report-traceability-audit": {
    blocks: auditCaptured as unknown as ThreadBlock[],
  },
  "ml-student-performance": {
    blocks: insertBeforeReview(mlCaptured as unknown as ThreadBlock[], [mlTable, mlFigure1, mlFigure2]),
  },
};

export const exampleSessions: Session[] = EXAMPLE_META.map((example) => ({
  id: example.id,
  projectId: "examples",
  title: example.title,
  group: "Examples",
  status: "done",
  blocks: capturedById[example.id].blocks,
  inspector: capturedById[example.id].inspector,
}));

const sessionsById = new Map(exampleSessions.map((session) => [session.id, session]));

export function findExampleSession(id: string): Session | undefined {
  return sessionsById.get(id);
}
