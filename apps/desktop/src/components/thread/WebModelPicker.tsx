import { useTranslation } from "react-i18next";
import { useRuntimeStore } from "@/lib/runtime";
import { webModelChoices } from "@/lib/webModelCatalog";
import { WebChoiceMenu } from "./WebChoiceMenu";

export function WebModelPicker({ sessionId, compact = false, defaultMode = false }: {
  sessionId?: string; compact?: boolean; defaultMode?: boolean;
}) {
  const { t } = useTranslation("session");
  const runtime = useRuntimeStore((s) => s.gatewayRuntime);
  const runtimes = useRuntimeStore((s) => s.gatewayRuntimes);
  const providers = useRuntimeStore((s) => s.providers);
  const state = useRuntimeStore((s) => s.gatewayCatalogState);
  const changing = useRuntimeStore((s) => s.gatewayRuntimeSwitching);
  const modelChanging = useRuntimeStore((s) => s.modelSwitching);
  const sessionModel = useRuntimeStore((s) => sessionId ? s.sessionModels[sessionId] : undefined);
  const defaultModel = useRuntimeStore((s) => s.defaultModel);
  const setSession = useRuntimeStore((s) => s.setSessionModel);
  const setDefault = useRuntimeStore((s) => s.setDefaultModel);
  const choices = webModelChoices(runtime, providers, runtimes);
  const selected = defaultMode ? defaultModel : sessionModel ?? defaultModel;
  const value = choices.some((model) => model.key === selected) && state !== "unavailable"
    ? selected ?? "" : "";
  return <WebChoiceMenu label={t("composer.runtime.modelLabel")} value={value || t("composer.model.unavailable")}
    compact={compact} busy={changing || modelChanging || state === "loading" || state === "unavailable" || choices.length === 0}
    choices={choices.map((model) => ({ key: model.key, label: model.label }))}
    onSelect={(key) => defaultMode ? setDefault(key) : sessionId ? setSession(sessionId, key) : undefined} />;
}
