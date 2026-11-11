import type { ProviderInfo } from "@ai4s/sdk";
import { flattenModelOptions, selectableModelOptions } from "@/components/settings/modelCatalog";
import type { GatewayRuntimeId, GatewayRuntimeOption } from "./runtime";

export interface WebModelChoice {
  key: string;
  modelId: string;
  label: string;
}

export function webModelChoices(
  assistant: GatewayRuntimeId | null,
  providers: ProviderInfo[],
  runtimes: GatewayRuntimeOption[],
): WebModelChoice[] {
  if (!assistant) return [];
  if (assistant === "opencode") return selectableModelOptions(flattenModelOptions(providers))
    .map((model) => ({ key: model.key, modelId: model.modelID, label: model.modelName }));
  const selected = runtimes.find((option) => option.runtime === assistant);
  if (!selected?.enabled) return [];
  return selected.models.map((modelId) => ({ key: `${assistant}/${modelId}`, modelId, label: modelId }));
}

/** Resolve a supported effort, falling back to the lowest known provider level. */
export function webReasoningEffort(variants: string[], selected?: string | null): string | undefined {
  if (selected && variants.includes(selected)) return selected;
  const levels = ["none", "disabled", "minimal", "min", "low", "medium", "high", "xhigh", "max", "ultra", "enabled"];
  return levels.find((level) => variants.includes(level)) ?? variants[0];
}

export function webModelEffort(providers: ProviderInfo[], model: string | null, selected?: string | null): string | undefined {
  if (!model) return undefined;
  const separator = model.indexOf("/");
  const variants = providers.find((provider) => provider.id === model.slice(0, separator))
    ?.models.find((entry) => entry.id === model.slice(separator + 1))?.variants ?? [];
  return webReasoningEffort(variants, selected);
}
