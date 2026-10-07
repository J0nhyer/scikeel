import { useTranslation } from "react-i18next";
import { ChevronRight, FileSearch, FlaskConical, Globe2, Lightbulb, LineChart } from "lucide-react";
import { resolveLocale } from "@/i18n/config";
import zhWorkflowPrompts from "@/i18n/locales/zh-Hans/workflow-prompts.json";
import { installExample, isTauri } from "@/lib/tauri";
import { toast } from "@/lib/toast";
import { isGatewayWeb } from "@/lib/webMode";

export type WorkflowStarterId = "research-idea" | "demo" | "analyze" | "audit" | "example-climate";

export interface WorkflowStarter {
  id: WorkflowStarterId;
  icon: React.ReactNode;
  /** Default English agent prompt. Chinese prompts live in the Chinese locale. */
  prompt: string;
  /** Side effect to run before sending the prompt (e.g. install example files). */
  prepare?: () => Promise<void>;
  webOnly?: boolean;
}

/** Conversation starters for research guidance, analysis, and traceability. */
export const WORKFLOW_STARTERS: WorkflowStarter[] = [
  {
    id: "research-idea",
    icon: <Lightbulb size={17} strokeWidth={1.75} />,
    webOnly: true,
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
    icon: <FlaskConical size={17} strokeWidth={1.75} />,
    prompt:
      "Run a complete demo analysis end to end: simulate a small dose–response dataset in Python, " +
      "analyze it (fit + summary statistics), save one publication-quality figure as demo_analysis/figure1.png, " +
      "and write demo_analysis/report.md summarizing the findings — every number in the report must come from " +
      "the code you ran. Keep all files in the workspace.",
  },
  {
    id: "analyze",
    icon: <LineChart size={17} strokeWidth={1.75} />,
    prompt:
      "Analyze the data file I added to the workspace end to end: explore it, run the analysis in code, " +
      "save at least one figure as a PNG, and write report.md with the findings — every number traced to " +
      "the code that produced it. Ask me which file to use if there is more than one candidate.",
  },
  {
    id: "audit",
    icon: <FileSearch size={17} strokeWidth={1.75} />,
    prompt:
      "Use the traceability-review skill to audit the report or manuscript in my workspace: resolve every " +
      "citation, flag numbers with no traceable source, and check figures against the code that generated them. " +
      "Ask me which document to audit if there is more than one candidate.",
  },
  {
    id: "example-climate",
    icon: <Globe2 size={17} strokeWidth={1.75} />,
    prompt:
      "Analyze the real climate dataset at climate-trends/data/gistemp_global_means.csv " +
      "(NASA GISTEMP v4 global land–ocean temperature anomalies in °C vs the 1951–1980 mean; " +
      "the header is on line 2 and missing values are `***` — see climate-trends/README.md). " +
      "Load the annual J-D series, quantify the warming rate (°C/decade) over the full record and " +
      "over 1975–present, compare decadal means, save one publication-quality figure as " +
      "climate-trends/warming_trend.png, and write climate-trends/report.md citing the dataset " +
      "source — every number must come from the code you ran.",
    prepare: async () => {
      if (isTauri) await installExample("climate-trends");
    },
  },
];

/** Keep starter cards and command-palette actions on the same locale-aware prompt. */
export function workflowStarterPrompt(id: WorkflowStarterId, locale: string): string {
  const starter = WORKFLOW_STARTERS.find((item) => item.id === id);
  if (!starter) return "";
  if (resolveLocale(locale) !== "zh-Hans") return starter.prompt;
  return `${zhWorkflowPrompts.interaction}\n\n${zhWorkflowPrompts.starters[id]}`;
}

/**
 * Empty-session welcome: a quiet, centered composition in the app's paper
 * aesthetic. The conversation is the point, so the copy invites a message
 * first; the starters below are an optional on-ramp, not a dashboard.
 */
export function WorkflowStarters({ onPick }: { onPick: (prompt: string) => void }) {
  const { t, i18n } = useTranslation(["session", "common"]);
  // Display copy per starter id — t()'s generated key type rejects a dynamic
  // `starters.${id}.title` template, so each card's copy is looked up by id
  // from this literal-keyed map instead.
  const starterCopy: Record<string, { title: string; description: string }> = {
    "research-idea": { title: t("starters.research-idea.title"), description: t("starters.research-idea.description") },
    demo: { title: t("starters.demo.title"), description: t("starters.demo.description") },
    analyze: { title: t("starters.analyze.title"), description: t("starters.analyze.description") },
    audit: { title: t("starters.audit.title"), description: t("starters.audit.description") },
    "example-climate": {
      title: t("starters.example-climate.title"),
      description: t("starters.example-climate.description"),
    },
  };
  return (
    <div className="flex min-h-[62vh] flex-col items-center justify-center">
      <div className="w-full max-w-[500px]">
        <div className="text-center">
          <div className="text-[10.5px] font-medium uppercase tracking-[0.2em] text-muted">
            {t("starters.newSession")}
          </div>
          <h2 className="mt-2.5 font-serif text-[26px] leading-tight text-text">
            {t("starters.heading")}
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-muted">{t("starters.subheading")}</p>
        </div>

        <div className="mt-7 overflow-hidden rounded-card border border-border bg-surface shadow-card">
          {WORKFLOW_STARTERS.filter((s) => !s.webOnly || isGatewayWeb).map((s) => (
            <button
              key={s.id}
              onClick={() => {
                void (async () => {
                  try {
                    await s.prepare?.();
                  } catch (e) {
                    toast.error(
                      t("starters.error.setup", {
                        message: e instanceof Error ? e.message : String(e),
                      }),
                    );
                    return;
                  }
                  onPick(workflowStarterPrompt(s.id, i18n.language));
                })();
              }}
              className="group flex w-full items-center gap-3.5 border-t border-border px-4 py-3.5 text-left transition-colors first:border-t-0 hover:bg-surface-2"
            >
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-surface-2 text-accent ring-1 ring-border transition-colors group-hover:bg-surface">
                {s.icon}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13.5px] font-medium text-text">
                  {starterCopy[s.id]?.title}
                </span>
                <span className="mt-0.5 block text-xs leading-snug text-muted">
                  {starterCopy[s.id]?.description}
                </span>
              </span>
              <ChevronRight
                size={16}
                className="shrink-0 text-muted/60 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-muted"
              />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
