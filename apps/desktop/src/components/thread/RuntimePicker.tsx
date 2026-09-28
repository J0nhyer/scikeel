import { ChevronDown, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useRuntimeStore, type GatewayRuntimeId } from "@/lib/runtime";
import { cn } from "@/lib/cn";

/** The authenticated Web platform's CLI selector, kept beside the model picker
 *  so a user can choose both parts of the next turn without leaving the chat. */
export function RuntimePicker({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation("session");
  const runtime = useRuntimeStore((s) => s.gatewayRuntime);
  const runtimes = useRuntimeStore((s) => s.gatewayRuntimes);
  const switching = useRuntimeStore((s) => s.gatewayRuntimeSwitching);
  const selectRuntime = useRuntimeStore((s) => s.selectGatewayRuntime);

  if (!runtime || runtimes.length === 0) return null;

  return (
    <div className="relative flex h-7 min-w-0 items-center">
      {switching && (
        <Loader2
          size={12}
          className="pointer-events-none absolute left-2 z-10 animate-spin text-muted"
        />
      )}
      <select
        value={runtime}
        onChange={(event) => void selectRuntime(event.target.value as GatewayRuntimeId)}
        disabled={switching}
        aria-label={t("composer.runtime.aria")}
        title={t("composer.runtime.title")}
        className={cn(
          "h-7 min-w-0 appearance-none truncate rounded-full border border-border bg-surface py-0 pr-6 text-xs text-text outline-none hover:bg-surface-2 focus:border-accent disabled:cursor-wait disabled:opacity-60",
          compact ? "max-w-24 pl-2" : "max-w-32 pl-2.5",
          switching && "pl-7",
        )}
      >
        {runtimes.map((option) => (
          <option key={option.runtime} value={option.runtime} disabled={!option.enabled}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown
        size={11}
        className="pointer-events-none absolute right-2 text-muted"
        aria-hidden
      />
    </div>
  );
}
