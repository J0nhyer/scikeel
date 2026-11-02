import { useTranslation } from "react-i18next";
import { useToastStore } from "@/lib/toast";
import { X } from "lucide-react";
export interface StateNoticeProps {
  issueId: string;
  summary: string;
  detail?: string;
  action?: { label: string; run: () => void | Promise<void> };
  /** Close the whole notice, including a recovery action that would otherwise
   *  remain as a lone button. Use when the caller retries on its own. */
  dismissFully?: boolean;
}
/** Closing the notice removes it for this issue; the state that produced it is
 *  still owned by the page around it, so the close control never pretends to
 *  fix anything. */
export function StateNotice({ issueId, summary, detail, action, dismissFully }: StateNoticeProps) {
  const { t } = useTranslation("common");
  const account = useToastStore(s => s.accountId);
  const identity = JSON.stringify([account, issueId]);
  const dismissed = useToastStore(s => s.dismissedIssues.includes(identity));
  const dismiss = useToastStore(s => s.dismissIssue);
  if (dismissed) {
    // Keep a recovery control that has no other home on the page (a failed
    // directory listing, a failed assistant selection); a notice with no
    // action is feedback only and goes away entirely. A caller whose recovery
    // is automatic passes dismissFully so nothing is left behind.
    if (dismissFully) return null;
    return action
      ? <button type="button" className="min-h-11 min-w-11 text-xs text-accent underline" onClick={() => { void action.run(); }}>{action.label}</button>
      : null;
  }
  return <div data-state-notice className="min-w-0 text-xs text-muted">
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <span className="min-w-0 break-words">{summary}</span>
      {action && <button type="button" className="min-h-11 min-w-11 text-accent underline" onClick={() => { void action.run(); }}>{action.label}</button>}
      <button type="button" aria-label={t("notification.close")} className="ml-auto grid min-h-11 min-w-11 place-items-center rounded hover:bg-surface-2" onClick={() => dismiss(identity)}><X size={14} /></button>
    </div>
    {detail && <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{detail}</p>}
  </div>;
}
