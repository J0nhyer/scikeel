import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { isApiStatus, type ProjectEnvironmentApproval, type ProjectEnvironmentInfo } from "@ai4s/sdk";
import { getClient } from "@/lib/runtime";

export function ProjectEnvironmentPanel({ sessionId, running, visible }: { sessionId: string; running: boolean; visible: boolean }) {
  const { t } = useTranslation("session");
  const [info, setInfo] = useState<ProjectEnvironmentInfo | null>(null);
  const [approval, setApproval] = useState<ProjectEnvironmentApproval | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!visible) return;
    let current = true;
    setInfo(null); setApproval(null); setError(false); setExpanded(false);
    const client = getClient();
    if (client) void client.describeProjectEnvironment(sessionId).then(value => { if (current) setInfo(value); })
      .catch(reason => { if (current && !isApiStatus(reason, 404)) setError(true); });
    return () => { current = false; };
  }, [sessionId, visible]);
  if (!info) return null;
  async function request() {
    const client = getClient(); if (!client) return;
    setBusy(true); setError(false);
    try { setApproval(await client.requestProjectEnvironment(sessionId)); }
    catch { setError(true); }
    finally { setBusy(false); }
  }
  async function install() {
    const client = getClient(); if (!client || !approval) return;
    setBusy(true); setError(false);
    try {
      await client.approveProjectEnvironment(sessionId, approval.id);
      setApproval(null); setInfo(await client.describeProjectEnvironment(sessionId));
    } catch { setApproval(null); setError(true); }
    finally { setBusy(false); }
  }
  return <section className="shrink-0 border-b border-faint px-3 py-1 text-xs" aria-label={t("environment.title")}>
    <button type="button" className="flex w-full items-center justify-between gap-2 text-muted" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      <span>{t("environment.title")}</span><span>{t(`environment.${info.venvState}`)}</span>
    </button>
    {expanded && <div className="space-y-2 py-2 text-text">
      <p>{t("environment.explanation")}</p>
      {!info.inputHash && <p>{t("environment.lockRequired")}</p>}
      {error && <p role="alert">{t("environment.failed")}</p>}
      {running && <p>{t("environment.stopFirst")}</p>}
      {approval ? <>
        <p>{t("environment.confirm")}</p>
        <p className="break-words">{approval.patterns.join(", ")}</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={busy || running} onClick={() => void install()} className="rounded border border-faint px-2 py-1 disabled:opacity-50">{t(busy ? "environment.installing" : "environment.approve")}</button>
          <button type="button" disabled={busy} onClick={() => setApproval(null)} className="rounded px-2 py-1">{t("environment.cancel")}</button>
        </div>
      </> : <button type="button" disabled={busy || running || !info.inputHash} onClick={() => void request()} className="rounded border border-faint px-2 py-1 disabled:opacity-50">{t(busy ? "environment.loading" : "environment.prepare")}</button>}
    </div>}
  </section>;
}
