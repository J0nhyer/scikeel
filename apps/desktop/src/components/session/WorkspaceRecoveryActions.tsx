import * as Dialog from "@radix-ui/react-dialog";
import { RefreshCw, RotateCcw } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { WorkspaceContext, WorkspaceReport } from "@ai4s/sdk";
import { useRuntimeStore } from "@/lib/runtime";
import { isPlatformWeb } from "@/lib/webMode";
import { GatewaySignOut } from "@/components/sidebar/GatewaySignOut";

export function WorkspaceRecoveryActions({ report }: { report: WorkspaceReport | null }) {
  const { t } = useTranslation("session");
  const retry = useRuntimeStore(state => state.connectRetry);
  const restart = useRuntimeStore(state => state.restartGatewayWorkspace);
  const pending = useRuntimeStore(state => state.gatewayRestartPending);
  const [captured, setCaptured] = useState<WorkspaceContext | null>(null);
  const [retrying, setRetrying] = useState(false);
  if (!isPlatformWeb) return null;
  const canRestart = report?.state === "unresponsive" && report.canRestart && report.context &&
    report.activity !== "maintenance" && report.retryAfterMs === 0;
  return <section aria-label={t("live.recovery.title")} className="w-full min-w-0 border-y border-border py-4">
    <p role="status" className="text-sm text-text">{t(`live.recovery.states.${report?.state ?? "unknown"}`)}</p>
    {Boolean(report?.retryAfterMs) && <p className="mt-1 text-xs text-muted">{t("live.recovery.cooldown", { seconds: Math.ceil((report?.retryAfterMs ?? 0) / 1000) })}</p>}
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <button disabled={pending || retrying} onClick={() => {
        setRetrying(true); void retry().finally(() => setRetrying(false));
      }} className="flex min-h-11 items-center gap-2 rounded-input border border-border px-3 text-sm disabled:opacity-50">
        <RefreshCw size={15} aria-hidden />{t("live.recovery.retry")}
      </button>
      {canRestart && <button disabled={pending || retrying} onClick={() => setCaptured({ ...report.context! })}
        className="flex min-h-11 items-center gap-2 rounded-input border border-border px-3 text-sm disabled:opacity-50">
        <RotateCcw size={15} aria-hidden />{t("live.recovery.restart")}
      </button>}
      <GatewaySignOut />
    </div>
    <Dialog.Root open={captured !== null} onOpenChange={open => { if (!open) setCaptured(null); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/30" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[360px] max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-card border border-border bg-surface p-4 shadow-card">
          <Dialog.Title className="text-sm font-medium text-text">{t("live.recovery.restart")}</Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-muted">
            {t("live.recovery.sharedImpact")} {t("live.recovery.interruptWarning")}
          </Dialog.Description>
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <button disabled={pending} className="min-h-11 rounded-input bg-error px-3 text-sm text-white disabled:opacity-50" onClick={() => {
              const context = captured; setCaptured(null); if (context) void restart(context);
            }}>{t("live.recovery.confirmRestart")}</button>
            <Dialog.Close autoFocus className="min-h-11 rounded-input border border-border px-3 text-sm text-text">{t("live.recovery.cancel")}</Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </section>;
}
