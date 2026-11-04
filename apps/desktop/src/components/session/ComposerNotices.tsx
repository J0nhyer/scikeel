import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import type { ResearchDecision } from "@/lib/collaboration";
import { ErrorNotice } from "../ui/ErrorNotice";
import { StateNotice } from "../ui/StateNotice";
import { ResearchDecisionCard } from "../thread/ResearchDecisionCard";

interface Props {
  decisionInputError: string | null;
  collaborationError: string | null;
  collaborationErrorScope: string;
  pendingDecision: ResearchDecision | null;
  paused: boolean;
  pausedKey: string;
  busy: boolean;
  onDismissDecisionInputError: () => void;
  onRetryCollaboration: () => void | Promise<void>;
  onAnswerDecision: (answer: string) => unknown;
  onPauseDecision: () => unknown;
  onDiscardDecision?: () => unknown;
}

const closeButtonClass = "grid min-h-11 min-w-11 shrink-0 place-items-center rounded text-muted hover:bg-surface-2 hover:text-text";

/** Blocking and informational notices shown above the composer. Closing a
 *  blocking card performs its safe resolution action; it never hides the
 *  request while leaving the runtime blocked. */
export function ComposerNotices({
  decisionInputError,
  collaborationError,
  collaborationErrorScope,
  pendingDecision,
  paused,
  pausedKey,
  busy,
  onDismissDecisionInputError,
  onRetryCollaboration,
  onAnswerDecision,
  onPauseDecision,
  onDiscardDecision,
}: Props) {
  const { t } = useTranslation(["session", "common"]);
  const [pausedDismissed, setPausedDismissed] = useState(false);
  const [errorAttempt, setErrorAttempt] = useState(0);
  const wasBusy = useRef(false);
  const pausedWithoutDecision = paused && !pendingDecision;

  useEffect(() => {
    if (!pausedWithoutDecision) setPausedDismissed(false);
  }, [pausedWithoutDecision]);

  useEffect(() => {
    setPausedDismissed(false);
  }, [pausedKey]);

  useEffect(() => {
    if (wasBusy.current && !busy && collaborationError) setErrorAttempt((n) => n + 1);
    wasBusy.current = busy;
  }, [busy, collaborationError]);

  useEffect(() => {
    if (!pendingDecision && decisionInputError) onDismissDecisionInputError();
  }, [pendingDecision, decisionInputError, onDismissDecisionInputError]);

  return (
    <>
      {decisionInputError && pendingDecision && (
        <ErrorNotice
          issueId={`decision-input:${decisionInputError}`}
          summary={decisionInputError}
          onDismiss={onDismissDecisionInputError}
        />
      )}
      {collaborationError && (
        <StateNotice
          issueId={`collaboration:${collaborationErrorScope}:${errorAttempt}:${collaborationError}`}
          summary={t("collaboration.syncFailed")}
          detail={collaborationError}
          action={{ label: t("collaboration.retry"), run: onRetryCollaboration }}
        />
      )}
      {pendingDecision && (
        <ResearchDecisionCard
          key={pendingDecision.id}
          decision={pendingDecision}
          paused={paused}
          busy={busy}
          onAnswer={onAnswerDecision}
          onPause={onPauseDecision}
          onDiscard={onDiscardDecision}
        />
      )}
      {pausedWithoutDecision && !pausedDismissed && (
        <div className="flex min-w-0 items-start gap-2 text-xs text-muted">
          <span className="min-w-0 flex-1 break-words">{t("collaboration.paused")}</span>
          <button
            type="button"
            aria-label={t("common:notification.close")}
            title={t("common:notification.close")}
            className={closeButtonClass}
            onClick={() => setPausedDismissed(true)}
          >
            <X size={14} />
          </button>
        </div>
      )}
    </>
  );
}
