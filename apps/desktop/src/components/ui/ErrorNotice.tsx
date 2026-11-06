import { useEffect, useRef } from "react";
import { useToastStore } from "@/lib/toast";

export interface ErrorNoticeProps {
  issueId: string;
  summary: string;
  detail?: string;
  action?: { label: string; run: () => void | Promise<void> };
  onDismiss?: () => void;
  /** Remove the notice entirely when dismissed, including its action. Use when
   *  recovery is automatic or another control on the page retries. */
  dismissFully?: boolean;
}

/** Registers a state-derived error in the global card. Closing the card removes
 *  the notice; a recovery action with no other home stays as a labeled control
 *  unless the caller passes dismissFully. The state that produced the error
 *  stays owned by the caller; closing the card never resolves it. */
export function ErrorNotice({ issueId, summary, detail, action, onDismiss, dismissFully = false }: ErrorNoticeProps) {
  const account = useToastStore((s) => s.accountId);
  const identity = JSON.stringify([account, issueId]);
  const dismissed = useToastStore((s) => s.dismissedIssues.includes(identity));
  const pushError = useToastStore((s) => s.pushError);
  const dismissIssueCard = useToastStore((s) => s.dismissIssueCard);
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

  if (!dismissed || dismissFully || !action) return null;
  return (
    <button type="button" className="min-h-11 min-w-11 text-xs text-accent underline"
      onClick={() => { void action.run(); }}>
      {action.label}
    </button>
  );
}
