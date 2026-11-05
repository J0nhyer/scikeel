import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Row, Section, Switch } from "./Section";
import { useRuntimeStore } from "@/lib/runtime";
import { gatewayOrigin } from "@/lib/webMode";

type ManagedAgent = "claude" | "codex";
type Access = Record<ManagedAgent, boolean>;

const AGENTS = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
] as const;

async function readAccess(response: Response): Promise<Access> {
  if (!response.ok) throw new Error("Agent access request failed");
  const payload = await response.json() as { assistantEnabled?: Partial<Access> } | null;
  const access = payload?.assistantEnabled;
  if (typeof access?.claude !== "boolean" || typeof access.codex !== "boolean") {
    throw new Error("Agent access response is invalid");
  }
  return { claude: access.claude, codex: access.codex };
}

export function ManagedAgentsCard() {
  const { t } = useTranslation("settings");
  const refresh = useRuntimeStore((state) => state.refreshGatewayRuntimes);
  const [access, setAccess] = useState<Access | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [saving, setSaving] = useState<ManagedAgent | null>(null);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError(false);
    void fetch(`${gatewayOrigin()}/api/admin/runtime`, {
      credentials: "same-origin",
      signal: AbortSignal.timeout(15000),
    }).then(readAccess).then((value) => {
      if (active) setAccess(value);
    }).catch(() => {
      if (active) setLoadError(true);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [revision]);

  const save = async (id: ManagedAgent, label: string, enabled: boolean) => {
    if (!access || loading || loadError || saving) return;
    const previous = access;
    setSaving(id);
    setMessage(null);
    setAccess({ ...access, [id]: enabled });
    try {
      const response = await fetch(`${gatewayOrigin()}/api/admin/runtime`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runtime: id, enabled }),
        signal: AbortSignal.timeout(15000),
      });
      setAccess(await readAccess(response));
      setMessage({ error: false, text: t("managedAgents.saved", { runtime: label }) });
      // Catalog refresh failure must not roll back an already persisted setting.
      void refresh().catch(() => {});
    } catch {
      setAccess(previous);
      setMessage({ error: true, text: t("managedAgents.failed", { runtime: label }) });
    } finally {
      setSaving(null);
    }
  };

  return <Section title={t("managedAgents.title")} hint={t("managedAgents.hint")} flush>
    {AGENTS.map(({ id, label }) => <Row key={id} title={label} control={
      <Switch label={t("managedAgents.allow", { runtime: label })} checked={access?.[id] ?? false}
        disabled={loading || loadError || !access || saving !== null}
        onChange={(value) => { void save(id, label, value); }} />
    } />)}
    {loadError && <div className="px-4 pb-3 text-xs">
      <p role="alert" className="text-error">{t("managedAgents.loadFailed")}</p>
      <button type="button" className="mt-2 rounded-input border border-border px-3 py-2 text-text"
        onClick={() => setRevision((value) => value + 1)}>{t("managedAgents.retry")}</button>
    </div>}
    {(saving || message) && <p className={`px-4 pb-3 text-xs ${message?.error ? "text-error" : "text-muted"}`}
      role={message?.error ? "alert" : "status"}>
      {saving ? t("managedAgents.saving") : message?.text}
    </p>}
  </Section>;
}
