import { useTranslation } from "react-i18next";
import { useToastStore } from "@/lib/toast";
import { X } from "lucide-react";
export interface StateNoticeProps {
  issueId: string;
  summary: string;
  detail?: string;
  action?: { label: string; run: () => void | Promise<void> };
}
/** Closing explanatory copy leaves the real state and recovery control intact. */
export function StateNotice({ issueId, summary, detail, action }: StateNoticeProps) {
  const { t } = useTranslation("common");
  const account = useToastStore(s => s.accountId);
  const identity = JSON.stringify([account, issueId]);
  const dismissed = useToastStore(s => s.dismissedIssues.includes(identity));
  const dismiss = useToastStore(s => s.dismissIssue);
  return <div className="min-w-0 text-xs text-muted">
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <span className="min-w-0 break-words">{summary}</span>
      {action && <button type="button" className="min-h-11 min-w-11 text-accent underline" onClick={() => { void action.run(); }}>{action.label}</button>}
      {detail && !dismissed && <button type="button" aria-label={t("notification.closeDetails")} className="ml-auto grid min-h-11 min-w-11 place-items-center rounded hover:bg-surface-2" onClick={() => dismiss(identity)}><X size={14} /></button>}
    </div>
    {detail && !dismissed && <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{detail}</p>}
    {detail && dismissed && <details><summary className="min-h-11 cursor-pointer py-3">{t("notification.details")}</summary><p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{detail}</p></details>}
  </div>;
}
