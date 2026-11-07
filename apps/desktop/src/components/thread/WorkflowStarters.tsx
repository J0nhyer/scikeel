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
      "I have a rough research idea and want to turn it into a real plan — could we talk it through? " +
      "It could end as an undergraduate thesis or a paper, I don't know yet. Ask me a few easy questions (max three) " +
      "about my major, what I already have in mind, and what materials I can use, then wait for my answers. " +
      "If I'm still missing a topic, help me compare two or three workable directions. Once we settle on one, " +
      "let's map out a plan I can actually follow — and point me to Analyze my data next if I get data, or to " +
      "Audit a report for traceability if I have a draft. Please don't invent data or citations.",
  },
  {
    id: "demo",
    icon: <FlaskConical size={13} strokeWidth={1.75} />,
    prompt:
      "Show me what a full research run looks like — use simulated data so I don't have to prepare anything. " +
      "In Python: generate a small dose-response dataset, fit a model and get the summary stats, save one " +
      "publication-quality figure as demo_analysis/figure1.png, and write demo_analysis/report.md. " +
      "Every number in the report should come from the code you actually ran. Keep everything in the workspace.",
  },
  {
    id: "analyze",
    icon: <LineChart size={13} strokeWidth={1.75} />,
    prompt:
      "Please analyze the data file I added to this workspace for me. Explore it, run the analysis in code, " +
      "save at least one PNG figure of the key result, and write report.md with the findings — every number " +
      "should trace back to the code that produced it. If there are several candidates, ask me which one first.",
  },
  {
    id: "audit",
    icon: <FileSearch size={13} strokeWidth={1.75} />,
    prompt:
      "Please audit the report or manuscript in my workspace for traceability with the traceability-review skill: " +
      "check every citation, flag numbers that have no traceable source, and verify the figures match the code " +
      "that generated them. If there are several candidates, ask me which one to audit.",
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
