import { SlidersHorizontal } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useRuntimeStore } from "@/lib/runtime";
import { webModelChoices } from "@/lib/webModelCatalog";
import { WebChoiceMenu } from "./WebChoiceMenu";

// Variant names are provider tokens, using the same labels as ModelPicker.
function labelVariant(variant: string): string {
  return variant === "xhigh" ? "X-High" : variant.charAt(0).toLocaleUpperCase() + variant.slice(1);
}

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
  const sessionVariant = useRuntimeStore((s) => sessionId ? s.sessionVariants[sessionId] : undefined);
  const globalVariant = useRuntimeStore((s) => s.reasoningVariant);
  const defaultModel = useRuntimeStore((s) => s.defaultModel);
  const setSession = useRuntimeStore((s) => s.setSessionModel);
  const setVariant = useRuntimeStore((s) => s.setSessionVariant);
  const setDefault = useRuntimeStore((s) => s.setDefaultModel);
  const choices = webModelChoices(runtime, providers, runtimes);
  const selected = defaultMode ? defaultModel : sessionModel ?? defaultModel;
  const value = choices.some((model) => model.key === selected) && state !== "unavailable"
    ? selected ?? "" : "";
  const separator = value.indexOf("/");
  const variants = providers.find((provider) => provider.id === value.slice(0, separator))
    ?.models.find((model) => model.id === value.slice(separator + 1))?.variants ?? [];
  const effort = sessionVariant !== undefined ? sessionVariant : globalVariant;
  const effortValue = effort && variants.includes(effort) ? effort : "";
  const busy = changing || modelChanging || state === "loading" || state === "unavailable";
  return <div className={compact
    ? "flex min-w-[8rem] max-w-[10rem] items-center gap-1"
    : "flex min-w-[8rem] max-w-full items-center gap-1"}>
    <div className="min-w-[5rem] max-w-full flex-1">
      <WebChoiceMenu label={t("composer.runtime.modelLabel")} value={value || t("composer.model.unavailable")}
        compact={compact} busy={busy || choices.length === 0}
        choices={choices.map((model) => ({ key: model.key, label: model.label }))}
        onSelect={(key) => defaultMode ? setDefault(key) : sessionId ? setSession(sessionId, key) : undefined} />
    </div>
    {!defaultMode && sessionId && value && variants.length > 0 && <div className="shrink-0">
      <WebChoiceMenu label={t("composer.model.reasoning")} value={effortValue}
        triggerIcon={<SlidersHorizontal size={15} aria-hidden={true} />} busy={busy}
        choices={[{ key: "", label: t("composer.model.reasoningDefault") }, ...variants.map((variant) => ({
          key: variant,
          label: labelVariant(variant),
        }))]}
        onSelect={(key) => setVariant(sessionId, key || null)} />
    </div>}
  </div>;
}
