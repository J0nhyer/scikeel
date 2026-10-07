import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ResearchDecision } from "@/lib/collaboration";
export function ResearchDecisionCard({
  decision,
  paused,
  busy,
  onAnswer,
  onPause,
}: {
  decision: ResearchDecision;
  paused: boolean;
  busy: boolean;
  onAnswer: (answer: string) => unknown | Promise<unknown>;
  onPause: () => unknown | Promise<unknown>;
}) {
  const { t } = useTranslation("session");
  const [answer, setAnswer] = useState("");
  const label = t(decision.kind === "step" ? "collaboration.stepConfirmation" : "collaboration.confirmation");
  return (
    <section
      className="min-w-0 rounded-card border border-accent/40 bg-surface p-4"
      aria-label={label}
    >
      <p className="text-sm font-medium text-text">
        {label}
      </p>
      <div className="max-h-[35dvh] overflow-y-auto [overflow-wrap:anywhere]">
      <p className="my-2 whitespace-pre-wrap text-sm text-text">
        {decision.question}
      </p>
      <p className="mb-2 whitespace-pre-wrap text-sm text-muted">
        {t("collaboration.suggestion")}: {decision.suggestedAnswer}
      </p>
      </div>
      {paused && (
        <p className="mb-2 text-xs text-muted">{t("collaboration.paused")}</p>
      )}
      <input
        maxLength={12000}
        aria-label={t("collaboration.answer")}
        placeholder={t("collaboration.answer")}
        value={answer}
        onChange={(e) => setAnswer(e.target.value)}
        className="mb-3 w-full min-w-0 rounded-input border border-border bg-surface-2 p-2 text-sm text-text"
      />
      <div className="flex flex-wrap gap-2">
        <button
          disabled={busy}
          onClick={() =>
            void onAnswer(answer.trim() || decision.suggestedAnswer)
          }
          className="rounded-input bg-accent px-3 py-2 text-sm text-accent-fg disabled:opacity-50"
        >
          {answer.trim()
            ? t("collaboration.submit")
            : t("collaboration.continue")}
        </button>
        <button
          disabled={busy || paused}
          onClick={() => void onPause()}
          className="rounded-input border border-border px-3 py-2 text-sm text-text disabled:opacity-50"
        >
          {t("collaboration.pause")}
        </button>
      </div>
    </section>
  );
}
