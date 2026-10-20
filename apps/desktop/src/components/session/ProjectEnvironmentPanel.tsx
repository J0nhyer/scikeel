import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { FlaskConical, RefreshCw } from "lucide-react";
import type { ProjectEnvironmentApproval, ProjectEnvironmentInfo } from "@ai4s/sdk";
import { getClient } from "@/lib/runtime";
import { ManagementDialog } from "@/components/ui/ManagementDialog";

export function ProjectEnvironmentPanel({ sessionId, running, visible }: { sessionId: string; running: boolean; visible: boolean }) {
  const { t } = useTranslation("session");
  const [openFor, setOpenFor] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  if (!visible) return null;
  return <>
    <button ref={trigger} type="button" aria-label={t("environment.title")} title={t("environment.title")} onClick={() => setOpenFor(sessionId)} className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-text"><FlaskConical size={13}/></button>
    {openFor === sessionId && <EnvironmentDetails key={sessionId} sessionId={sessionId} running={running} onClose={() => setOpenFor(null)} returnFocusRef={trigger}/>}</>;
}

function EnvironmentDetails({ sessionId, running, onClose, returnFocusRef }: {
  sessionId: string; running: boolean; onClose: () => void; returnFocusRef: RefObject<HTMLButtonElement>;
}) {
  const { t } = useTranslation(["session", "common"]);
  const [info, setInfo] = useState<ProjectEnvironmentInfo | null>(null);
  const [approval, setApproval] = useState<ProjectEnvironmentApproval | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [readError, setReadError] = useState(false), [error, setError] = useState(false);
  const generation = useRef(0);
  const load = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true); setReadError(false);
    try {
      const client = getClient();
      if (!client) throw new Error("Runtime unavailable");
      const value = await client.describeProjectEnvironment(sessionId);
      if (current === generation.current) setInfo(value);
    } catch { if (current === generation.current) setReadError(true); }
    finally { if (current === generation.current) setLoading(false); }
  }, [sessionId]);
  useEffect(() => { void load(); return () => { generation.current++; }; }, [load]);
  async function request() {
    const client = getClient();
    if (!client || running || busy) return;
    const current = generation.current;
    setBusy(true); setError(false);
    try { const value = await client.requestProjectEnvironment(sessionId); if (current === generation.current) setApproval(value); }
    catch { if (current === generation.current) setError(true); }
    finally { if (current === generation.current) setBusy(false); }
  }
  async function install() {
    const client = getClient();
    if (!client || !approval || running || busy) return;
    const current = generation.current;
    setBusy(true); setError(false);
    try {
      await client.approveProjectEnvironment(sessionId, approval.id);
      if (current !== generation.current) return;
      setApproval(null);
      const value = await client.describeProjectEnvironment(sessionId);
      if (current === generation.current) setInfo(value);
    } catch { if (current === generation.current) { setApproval(null); setError(true); } }
    finally { if (current === generation.current) setBusy(false); }
  }
  return <ManagementDialog title={t("environment.title")} onClose={onClose} dismissible={!busy} returnFocusRef={returnFocusRef}>
    <div className="mt-3 space-y-3 text-sm">
      {loading && <p role="status" className="text-muted">{t("environment.detailsLoading")}</p>}
      {readError && <div role="alert" className="flex items-center gap-3"><p className="min-w-0 flex-1 text-error">{t("environment.loadFailed")}</p><button type="button" title={t("common:notification.retry")} aria-label={t("common:notification.retry")} className="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-border" onClick={()=>void load()}><RefreshCw size={15}/></button></div>}
      {info && <>
        <p className="font-medium">{t(`environment.${info.venvState}`)}</p>
        <p>{t("environment.explanation")}</p>
        {!info.inputHash && <p>{t("environment.lockRequired")}</p>}
        {error && <p role="alert" className="text-error">{t("environment.failed")}</p>}
        {running && <p>{t("environment.stopFirst")}</p>}
        {approval ? <>
          <p>{t("environment.confirm")}</p><p className="break-words">{approval.patterns.join(", ")}</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={busy || running} onClick={() => void install()} className="rounded border border-border px-3 py-2 disabled:opacity-50">{t(busy ? "environment.installing" : "environment.approve")}</button>
            <button type="button" disabled={busy} onClick={() => setApproval(null)} className="rounded px-3 py-2">{t("environment.cancel")}</button>
          </div>
        </> : <button type="button" disabled={busy || running || !info.inputHash} onClick={() => void request()} className="rounded border border-border px-3 py-2 disabled:opacity-50">{t(busy ? "environment.loading" : "environment.prepare")}</button>}
      </>}
    </div>
    <div className="mt-4 flex justify-end"><button type="button" disabled={busy} onClick={onClose} className="rounded border border-border px-3 py-2 text-sm disabled:opacity-50">{t("environment.close")}</button></div>
  </ManagementDialog>;
}
