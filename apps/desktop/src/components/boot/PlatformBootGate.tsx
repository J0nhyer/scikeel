import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { isWorkspaceReport } from "@ai4s/sdk";
import { useRuntimeStore } from "@/lib/runtime";
import { isPlatformWeb } from "@/lib/webMode";
import { WorkspaceRecoveryActions } from "@/components/session/WorkspaceRecoveryActions";
import { LoadingSurface } from "./LoadingSurface";

const BOOT_TIMEOUT_MS = 90_000;

/** One neutral wait surface for the managed Web workspace. The application
 *  mounts underneath so AppShell can run bootstrap; this gate only covers it
 *  until the first usable state, then never covers it again. */
export function PlatformBootGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation("session");
  const status = useRuntimeStore(state => state.status);
  const gatewayWorkspaceReport = useRuntimeStore(state => state.gatewayWorkspaceReport);
  const sessionListReady = useRuntimeStore(state => state.sessionListReady);
  const gatewayCatalogState = useRuntimeStore(state => state.gatewayCatalogState);
  const ready = status === "ready" && sessionListReady &&
    (gatewayCatalogState === "ready" || gatewayCatalogState === "limited");
  // Sticky readiness must be derived during render: a passive effect would
  // commit one extra full-screen surface after the server overlay is gone.
  const firstReadyRef = useRef(ready);
  if (ready) firstReadyRef.current = true;
  const firstReady = firstReadyRef.current;
  const [timedOut, setTimedOut] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const loginPreparing = typeof document !== "undefined" &&
    document.documentElement.hasAttribute("data-scikeel-login-preparing");
  const admin = typeof window !== "undefined" && window.location.pathname === "/admin/agent-analytics";
  const enabled = isPlatformWeb && !admin && !loginPreparing;

  useEffect(() => {
    if (!enabled || firstReady) return;
    setTimedOut(false);
    const timer = setTimeout(() => setTimedOut(true), BOOT_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [enabled, firstReady, attempt]);

  if (!enabled || firstReady) return <>{children}</>;

  const failed = (status === "error" || timedOut) && !retrying;
  const retry = async () => {
    if (retrying) return;
    setRetrying(true);
    setTimedOut(false);
    setAttempt(value => value + 1);
    try {
      await useRuntimeStore.getState().connectRetry(360);
    } finally {
      setRetrying(false);
    }
  };

  const recovery = isWorkspaceReport(gatewayWorkspaceReport) && gatewayWorkspaceReport.state !== "healthy";
  if (failed) {
    return (
      <>
        {children}
        <div className="loading-surface fixed inset-0 z-[100] flex items-center justify-center bg-bg p-4 text-text">
          {recovery ? (
            <div className="w-full max-w-md rounded-card border border-border bg-surface p-4 shadow-card">
              <WorkspaceRecoveryActions report={gatewayWorkspaceReport}
                waiting={gatewayWorkspaceReport.state === "capacity" && status !== "error"} />
            </div>
          ) : (
            <div role="alert" className="flex max-w-sm flex-col items-center gap-4 text-center">
              <p className="text-sm text-muted">{t("live.boot.busy")}</p>
              <button
                type="button"
                disabled={retrying}
                onClick={() => void retry()}
                className="min-h-10 rounded-input border border-border px-4 text-sm disabled:opacity-50"
              >
                {t("live.boot.retry")}
              </button>
            </div>
          )}
        </div>
      </>
    );
  }

  return (
    <>
      {children}
      <LoadingSurface />
    </>
  );
}
