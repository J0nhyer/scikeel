import { useEffect, useRef } from "react";
import { AlertCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useToastStore } from "@/lib/toast";

export interface ErrorNoticeProps {
  issueId: string;
  summary: string;
  detail?: string;
  action?: { label: string; run: () => void | Promise<void> };
  onDismiss?: () => void;
}

/** Registers a state-derived error in the global card and leaves an icon-only
 *  reopen control after dismissal. The state that produced the error stays
 *  owned by the caller; closing the card never resolves it. */
export function ErrorNotice({ issueId, summary, detail, action, onDismiss }: ErrorNoticeProps) {
  const { t } = useTranslation("common");
  const account = useToastStore((s) => s.accountId);
  const identity = JSON.stringify([account, issueId]);
  const dismissed = useToastStore((s) => s.dismissedIssues.includes(identity));
  const pushError = useToastStore((s) => s.pushError);
  const dismissIssueCard = useToastStore((s) => s.dismissIssueCard);
  const showIssue = useToastStore((s) => s.showIssue);
  const actionRef = useRef(action);
  actionRef.current = action;
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  const message = detail ? `${summary}\n${detail}` : summary;

  useEffect(() => {
    if (dismissed) {
      dismissIssueCard(issueId);
      return;
    }
    pushError(message, {
      accountId: account,
      issueId,
      action: actionRef.current,
      onDismiss: () => dismissRef.current?.(),
    });
    return () => dismissIssueCard(issueId);
  }, [account, dismissed, issueId, message, pushError, dismissIssueCard]);

  if (!dismissed) return null;
  return (
    <button
      type="button"
      aria-label={t("notification.show")}
      title={t("notification.show")}
      className="grid min-h-11 min-w-11 place-items-center rounded text-error hover:bg-surface-2"
      onClick={() => showIssue(identity)}
    >
      <AlertCircle size={14} />
    </button>
  );
}
