import { useTranslation } from "react-i18next";
import { FileSearch, FlaskConical, Lightbulb, LineChart } from "lucide-react";
import { resolveLocale } from "@/i18n/config";
import zhWorkflowPrompts from "@/i18n/locales/zh-Hans/workflow-prompts.json";

export type WorkflowStarterId = "research-idea" | "demo" | "analyze" | "audit";

export interface WorkflowStarter {
  id: WorkflowStarterId;
  icon: React.ReactNode;
  /** Default English agent prompt. Chinese prompts live in the Chinese locale. */
  prompt: string;
}

/** Conversation starters that open a complete research workflow. */
export const WORKFLOW_STARTERS: WorkflowStarter[] = [
  {
    id: "research-idea",
    icon: <Lightbulb size={13} strokeWidth={1.75} />,
    prompt:
      "Help me start a research project from an idea, whether for an undergraduate thesis or a possible paper. " +
      "Begin with a short welcome and at most three conversational questions about my discipline, any ideas I have, " +
      "and the materials or resources available to me. Use anything I have already told you instead of asking again, " +
      "then wait for my answers. If I have no topic yet, help me compare two or three feasible directions after " +
      "learning my situation. Explain how an interest becomes a research question, suggest a manageable plan " +
      "and one concrete next step, and discuss the plan with me. Do not ask me to fill out a form or specify output " +
      "filenames before we know what to do. When I have data, connect the next step to Analyze my data; when I " +
      "have a draft, connect it to Audit a report for traceability. Select relevant available Skills when needed " +
      "and explain their purpose. Do not invent data, citations, results, or claims of novelty.",
  },
  {
    id: "demo",
    icon: <FlaskConical size={13} strokeWidth={1.75} />,
    prompt:
      "Run a complete demo analysis end to end: simulate a small dose–response dataset in Python, " +
      "analyze it (fit + summary statistics), save one publication-quality figure as demo_analysis/figure1.png, " +
      "and write demo_analysis/report.md summarizing the findings — every number in the report must come from " +
      "the code you ran. Keep all files in the workspace.",
  },
  {
    id: "analyze",
    icon: <LineChart size={13} strokeWidth={1.75} />,
    prompt:
      "Analyze the data file I added to the workspace end to end: explore it, run the analysis in code, " +
      "save at least one figure as a PNG, and write report.md with the findings — every number traced to " +
      "the code that produced it. Ask me which file to use if there is more than one candidate.",
  },
  {
    id: "audit",
    icon: <FileSearch size={13} strokeWidth={1.75} />,
    prompt:
      "Use the traceability-review skill to audit the report or manuscript in my workspace: resolve every " +
      "citation, flag numbers with no traceable source, and check figures against the code that generated them. " +
      "Ask me which document to audit if there is more than one candidate.",
  },
];

/** The three actions the empty session shows, in display order. */
export const HOME_STARTER_IDS = ["analyze", "research-idea", "demo"] as const;

/** Keep starter chips and command-palette actions on the same locale-aware prompt. */
export function workflowStarterPrompt(id: WorkflowStarterId, locale: string): string {
  const starter = WORKFLOW_STARTERS.find((item) => item.id === id);
  if (!starter) return "";
  if (resolveLocale(locale) !== "zh-Hans") return starter.prompt;
  return `${zhWorkflowPrompts.interaction}\n\n${zhWorkflowPrompts.starters[id]}`;
}

/** The empty conversation's single question, centered in the open canvas. */
export function WorkflowStarters({ bottomInset = 0 }: { bottomInset?: number }) {
  const { t } = useTranslation("session");
  return (
    <div
      style={{ bottom: bottomInset }}
      className="pointer-events-none absolute inset-0 flex items-center justify-center px-8"
    >
      <h2 className="text-center font-serif text-[28px] leading-tight text-text sm:text-[34px]">
        {t("starters.heading")}
      </h2>
    </div>
  );
}

/** The three starter actions, shown directly above the composer. */
export function WorkflowStarterChips({ onPick }: { onPick: (prompt: string) => void }) {
  const { t, i18n } = useTranslation(["session", "common"]);
  const chipCopy: Record<string, string> = {
    analyze: t("starters.chips.analyze"),
    "research-idea": t("starters.chips.research-idea"),
    demo: t("starters.chips.demo"),
  };

  return (
    <div className="flex w-full flex-wrap items-center justify-center gap-2">
      {HOME_STARTER_IDS.map((id) => {
        const starter = WORKFLOW_STARTERS.find((item) => item.id === id);
        if (!starter) return null;
        return (
          <button
            key={id}
            type="button"
            onClick={() => onPick(workflowStarterPrompt(id, i18n.language))}
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3.5 py-2 text-[12px] font-medium text-text shadow-sm transition-colors hover:border-accent hover:text-accent"
          >
            <span className="text-accent" aria-hidden="true">
              {starter.icon}
            </span>
            {chipCopy[id]}
          </button>
        );
      })}
    </div>
  );
}
