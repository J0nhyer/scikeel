import { useTranslation } from "react-i18next";
import { AlertTriangle, X } from "lucide-react";
import type { ResearchDelivery } from "@/lib/collaboration";

/** Unresolved delivery failures remain inspectable; completion uses a toast only. */
export function ResearchDeliveryStatus({ delivery }: { delivery: ResearchDelivery }) {
  const { t } = useTranslation(["session", "common"]);
  if (delivery.status !== "failed") return null;
  const label = t("collaboration.deliveryFailed");
  return <details className="relative shrink-0 text-xs">
    <summary aria-label={label} title={label} className="grid min-h-11 min-w-11 cursor-pointer list-none place-items-center rounded text-muted hover:bg-surface-2 [&::-webkit-details-marker]:hidden">
      <AlertTriangle size={15} className="text-warn" />
    </summary>
    <div role="status" className="absolute right-0 top-full z-30 w-[min(280px,calc(100vw-24px))] max-h-[50vh] overflow-auto rounded-lg border border-border bg-surface p-3 shadow-card [overflow-wrap:anywhere]">
      <div className="flex items-center gap-2"><p className={delivery.status === "failed" ? "text-danger" : "text-text"}>{label}</p>
        <button type="button" aria-label={t("common:notification.closeDetails")} className="ml-auto grid min-h-11 min-w-11 shrink-0 place-items-center" onClick={event => { event.currentTarget.closest("details")?.removeAttribute("open"); }}><X size={14} /></button>
      </div>
      {delivery.issue && <p className="mt-1 text-muted">{t(`collaboration.deliveryIssues.${delivery.issue}`)}</p>}
      {delivery.status === "failed" && delivery.attempts >= 3 && <p className="mt-1 text-muted">{t("collaboration.deliveryRepairLimit")}</p>}
      {delivery.report?.limitations && <p className="mt-1 whitespace-pre-wrap text-muted">{delivery.report.limitations}</p>}
      <p className="mt-1 text-muted">{t("collaboration.deliverySelfCheck")}</p>
    </div>
  </details>;
}
