import { useTranslation } from "react-i18next";
import { useRuntimeStore, type GatewayRuntimeId } from "@/lib/runtime";
import { WebChoiceMenu } from "./WebChoiceMenu";
import { isPlatformWeb } from "@/lib/webMode";

/** Legacy gateway selector; authenticated platform selection belongs to Admin Models. */
export function RuntimePicker({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation("session");
  const runtime = useRuntimeStore((s) => s.gatewayRuntime);
  const runtimes = useRuntimeStore((s) => s.gatewayRuntimes);
  const switching = useRuntimeStore((s) => s.gatewayRuntimeSwitching);
  const selectRuntime = useRuntimeStore((s) => s.selectGatewayRuntime);
  const role = useRuntimeStore((s) => s.gatewayUserRole);

  if (isPlatformWeb || role !== null || !runtime || runtimes.length === 0) return null;

  const available = runtimes.filter((option) => option.enabled);
  const value = available.some((option) => option.runtime === runtime) ? runtime : t("composer.runtime.select");
  return <WebChoiceMenu label={t("composer.runtime.aria")} value={value} compact={compact} busy={switching || available.length === 0}
    choices={available.map((option) => ({ key: option.runtime, label: option.label }))}
    onSelect={(key) => selectRuntime(key as GatewayRuntimeId)} />;
}
