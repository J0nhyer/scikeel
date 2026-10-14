import { StateNotice } from "../ui/StateNotice";
import { useTranslation } from "react-i18next";
import { RuntimePicker } from "@/components/thread/RuntimePicker";
import { WebModelPicker } from "@/components/thread/WebModelPicker";
import { useRuntimeStore } from "@/lib/runtime";
import { ManagedAgentsCard } from "./ManagedAgentsCard";

export function GatewayModelsPanel() {
  const { t } = useTranslation(["settings", "common"]);
  const runtime = useRuntimeStore((s) => s.gatewayRuntime);
  const state = useRuntimeStore((s) => s.gatewayCatalogState);
  const modelError = useRuntimeStore((s) => s.modelSwitchError);
  const role = useRuntimeStore((s) => s.gatewayUserRole);
  return <section className="space-y-5" aria-label={t("nav.models")}>
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
      <span className="text-sm font-medium text-text">{t("runtime.platformSelect")}</span>
      <RuntimePicker />
    </div>
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
      <span className="text-sm font-medium text-text">{t("model.defaultTitle")}</span>
      {runtime && <WebModelPicker defaultMode />}
    </div>
    <p className="text-xs text-muted">{t("model.defaultDescription")}</p>
    {modelError && <StateNotice issueId={`default-model:${runtime}:${modelError}`}
      summary={t("model.defaultSaveProblem")} detail={modelError} />}
    {state === "limited" && <StateNotice issueId={`catalog:${runtime}:limited`} summary={t("model.title")} detail={t("model.catalogLimited")} />}
    {state === "unavailable" && <StateNotice issueId={`catalog:${runtime}:unavailable`} summary={t("common:notification.problem")} detail={t("model.catalogUnavailable")} action={{ label: t("common:notification.retry"), run: () => useRuntimeStore.getState().refreshGatewayRuntimes() }} />}
    {role === "admin" && <ManagedAgentsCard />}
  </section>;
}
