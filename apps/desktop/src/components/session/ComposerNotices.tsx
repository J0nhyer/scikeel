import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
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
  busy: boolean;
  onDismissDecisionInputError: () => void;
  onRetryCollaboration: () => void | Promise<void>;
  onAnswerDecision: (answer: string) => unknown;
  onPauseDecision: () => unknown;
  onDiscardDecision?: () => unknown;
}

/** Blocking and informational notices shown above the composer. Closing a
 *  blocking card performs its safe resolution action; it never hides the
 *  request while leaving the runtime blocked. */
export function ComposerNotices({
  decisionInputError,
  collaborationError,
  collaborationErrorScope,
  pendingDecision,
  paused,
  busy,
  onDismissDecisionInputError,
  onRetryCollaboration,
  onAnswerDecision,
  onPauseDecision,
  onDiscardDecision,
}: Props) {
  const { t } = useTranslation(["session", "common"]);
  const [errorAttempt, setErrorAttempt] = useState(0);
  const wasBusy = useRef(false);

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
          dismissFully
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
    </>
  );
}
