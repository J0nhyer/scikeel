import { useTranslation } from "react-i18next";
import type { ResearchDelivery } from "@/lib/collaboration";

export function ResearchDeliveryStatus({ delivery }: { delivery: ResearchDelivery }) {
  const { t } = useTranslation("session");
  if (delivery.status === "pending") return null;
  return (
    <div role="status" className="rounded-lg border border-border bg-surface px-3 py-2 text-xs [overflow-wrap:anywhere]">
      <p className={delivery.status === "failed" ? "text-danger" : "text-text"}>
        {delivery.status === "completed" ? t("collaboration.deliveryCompleted") : t("collaboration.deliveryFailed")}
      </p>
      {delivery.issue && <p className="mt-1 text-muted">{t(`collaboration.deliveryIssues.${delivery.issue}`)}</p>}
      {delivery.status === "failed" && delivery.attempts >= 3 && <p className="mt-1 text-muted">{t("collaboration.deliveryRepairLimit")}</p>}
      {delivery.report?.limitations && <p className="mt-1 whitespace-pre-wrap text-muted">{delivery.report.limitations}</p>}
      <p className="mt-1 text-muted">{t("collaboration.deliverySelfCheck")}</p>
    </div>
  );
}
