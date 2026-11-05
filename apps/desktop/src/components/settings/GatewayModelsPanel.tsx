import { useTranslation } from "react-i18next";
import { RuntimePicker } from "@/components/thread/RuntimePicker";
import { WebModelPicker } from "@/components/thread/WebModelPicker";
import { useRuntimeStore } from "@/lib/runtime";
import { ManagedAgentsCard } from "./ManagedAgentsCard";

export function GatewayModelsPanel() {
  const { t } = useTranslation("settings");
  const runtime = useRuntimeStore((s) => s.gatewayRuntime);
  const state = useRuntimeStore((s) => s.gatewayCatalogState);
  const role = useRuntimeStore((s) => s.gatewayUserRole);
  return <section className="space-y-5" aria-label={t("nav.models")}>
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
      <span className="text-sm font-medium text-text">{t("runtime.platformSelect")}</span>
      <RuntimePicker />
    </div>
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
      <span className="text-sm font-medium text-text">{t("model.title")}</span>
      {runtime && <WebModelPicker defaultMode />}
    </div>
    {state === "limited" && <p role="status" className="text-xs text-muted">{t("model.catalogLimited")}</p>}
    {state === "unavailable" && <p role="status" className="text-xs text-muted">{t("model.catalogUnavailable")}</p>}
    {role === "admin" && <ManagedAgentsCard />}
  </section>;
}
