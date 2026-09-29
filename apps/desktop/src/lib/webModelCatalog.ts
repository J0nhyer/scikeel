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
