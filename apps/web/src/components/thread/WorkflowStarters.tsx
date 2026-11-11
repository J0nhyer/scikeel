import { useTranslation } from "react-i18next";
import { BookOpen, FileSearch, Lightbulb, LineChart } from "lucide-react";
import { resolveLocale } from "@/i18n/config";
import zhWorkflowPrompts from "@/i18n/locales/zh-Hans/workflow-prompts.json";

export type WorkflowStarterId = "research-idea" | "literature" | "analyze" | "audit";

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
      "I have a rough research idea and want to turn it into a real plan. Ask me up to three easy questions " +
      "about my field, what I already have in mind, and the materials I can use, then wait for my answers. " +
      "If I have no topic yet, help me compare two or three workable directions. Once we choose one, use the " +
      "research-workflow skill to write `plan.md` with the research question, method, data needs, deliverables, " +
      "and risks, and confirm it with me before doing more. Do not invent data, citations, or results.",
  },
  {
    id: "literature",
    icon: <BookOpen size={13} strokeWidth={1.75} />,
    prompt:
      "I want a literature review. Ask me for the topic, scope, and intended use (course paper, thesis proposal, " +
      "or submission) if I haven't said. Use the literature-review skill to search public scholarly sources and " +
      "organize the key papers, and the citation-reviewer skill to verify every reference. Produce `review.md`, " +
      "`references.csv`, and `search_log.md`. Mark papers you cannot access or verify instead of inventing them; " +
      "ask me before expanding a very broad scope.",
  },
  {
    id: "analyze",
    icon: <LineChart size={13} strokeWidth={1.75} />,
    prompt:
      "I want to analyze data in my workspace. First ask me what question I want to answer and which file to use " +
      "if there are several. Use the large-file skill to inspect large data before reading it, run the analysis " +
      "in code, use the publication-figures skill for the final figure, and use the stats-integrity and " +
      "domain-check skills where the analysis warrants them. Produce `analysis.py`, at least one PNG figure, and " +
      "`report.md`; every number in the report must trace to the code that produced it. Tell me the assumptions " +
      "and limitations.",
  },
  {
    id: "audit",
    icon: <FileSearch size={13} strokeWidth={1.75} />,
    prompt:
      "Audit the report or manuscript in my workspace for traceability. If there are several candidates, ask me " +
      "which one. Use the traceability-review skill to resolve every citation, flag numbers with no traceable " +
      "source, and check figures against the code that generated them. Produce a structured review with findings " +
      "and a correction checklist. Do not claim the document is error-free.",
  },
];
/** The four actions the empty session shows, in display order. */
export const HOME_STARTER_IDS = ["research-idea", "literature", "analyze", "audit"] as const;

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

/** The four starter actions, shown directly above the composer. */
export function WorkflowStarterChips({ onPick }: { onPick: (prompt: string) => void }) {
  const { t, i18n } = useTranslation(["session", "common"]);
  const chipCopy: Record<WorkflowStarterId, string> = {
    "research-idea": t("starters.chips.research-idea"),
    literature: t("starters.chips.literature"),
    analyze: t("starters.chips.analyze"),
    audit: t("starters.chips.audit"),
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
