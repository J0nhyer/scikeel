import { toast } from "@/lib/toast";
import { StateNotice } from "../ui/StateNotice";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Row, Section } from "./Section";
import { useRuntimeStore, type GatewayRuntimeId } from "@/lib/runtime";
import { gatewayOrigin } from "@/lib/webMode";

type Selection = { runtime: GatewayRuntimeId; expectedRevision: number; operationId: string };
type Message = "managedAgents.failed" | "managedAgents.busy" | "managedAgents.unavailable" | "managedAgents.pending" | "managedAgents.loadFailed";
type Policy = { activeRuntime: GatewayRuntimeId; revision: number; recoveryRequired: boolean;
  available: { runtime: GatewayRuntimeId; status?: string; models: string[]; defaultModel?: string | null }[];
  operation: { operationId: string; state: "pending" | "unknown" | "committed";
    result?: { activeRuntime: GatewayRuntimeId; revision: number; operationId: string } } | null };
const AGENTS = [{ id: "opencode", label: "OpenCode" }, { id: "claude", label: "Claude Code" }, { id: "codex", label: "Codex" }] as const;
const runtime = (value: unknown): value is GatewayRuntimeId => AGENTS.some(agent => agent.id === value);
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const storageKey = (account: string) => `scikeel.assistant-selection.v1:${account}`;

function storedSelection(account: string): Selection | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(storageKey(account)) ?? "null") as Selection | null;
    if (value && Object.keys(value).sort().join(",") === "expectedRevision,operationId,runtime" && runtime(value.runtime) &&
        positive(value.expectedRevision) && typeof value.operationId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value.operationId)) return value;
  } catch { /* The server remains authoritative when browser storage is unavailable. */ }
  return null;
}
async function readPolicy(response: Response): Promise<Policy> {
  if (!response.ok) throw Error("Assistant selection unavailable");
  const value = await response.json() as Policy | null;
  if (!value || !runtime(value.activeRuntime) || !positive(value.revision) || typeof value.recoveryRequired !== "boolean" ||
      !Array.isArray(value.available) || value.available.length !== AGENTS.length ||
      new Set(value.available.map(option => option?.runtime)).size !== AGENTS.length ||
      value.available.some(option => !option || !runtime(option.runtime) || !Array.isArray(option.models) ||
        option.models.length > 1000 || option.models.some(model => typeof model !== "string")) ||
      value.operation !== null && (!value.operation || typeof value.operation.operationId !== "string" ||
        !["pending", "unknown", "committed"].includes(value.operation.state))) throw Error("Invalid assistant policy");
  return value;
}

export function ManagedAgentsCard() {
  const { t } = useTranslation(["settings", "common"]);
  const account = useRuntimeStore(state => state.gatewayUser?.id);
  const role = useRuntimeStore(state => state.gatewayUser?.role);
  const refresh = useRuntimeStore(state => state.refreshGatewayRuntimes);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [pending, setPending] = useState<Selection | null>(null);
  const [loading, setLoading] = useState(true);
  const [resolving, setResolving] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const pendingRef = useRef<Selection | null>(null);
  const epochRef = useRef(0);
  const resolvingRef = useRef(false);
  const current = useCallback((epoch: number) => epochRef.current === epoch &&
    useRuntimeStore.getState().gatewayUser?.id === account && useRuntimeStore.getState().gatewayUser?.role === "admin", [account]);

  const check = useCallback(async (selection: Selection | null, options: { epoch: number; post?: boolean; retry?: boolean; returnFocus?: HTMLElement }) => {
    if (!account || !current(options.epoch)) return;
    resolvingRef.current = true; setResolving(true); setMessage(null);
    let post = options.post === true, retry = options.retry === true;
    try {
      // At most one POST per explicit action. A retry first reads the receipt
      // and, only if absent and still at its original revision, reuses its ID.
      for (let attempt = 0; attempt < 2; attempt++) {
        let definitive = false;
        let failureKey: Message = "managedAgents.failed";
        if (post && selection) {
          try {
            const result = await fetch(`${gatewayOrigin()}/api/admin/runtime`, { method: "POST", credentials: "same-origin",
              headers: { "Content-Type": "application/json" }, body: JSON.stringify(selection), signal: AbortSignal.timeout(15000) });
            if (!result.ok) {
              definitive = [400, 403, 409].includes(result.status);
              const body = await result.json().catch(() => null) as { code?: string } | null;
              if (body?.code === "assistant_busy") failureKey = "managedAgents.busy";
              if (body?.code === "assistant_unavailable") failureKey = "managedAgents.unavailable";
            } else await result.body?.cancel();
          } catch { /* A lost HTTP acknowledgement does not prove rejection. */ }
        }
        if (!current(options.epoch)) return;
        const query = selection ? `?operationId=${encodeURIComponent(selection.operationId)}` : "";
        const next = await readPolicy(await fetch(`${gatewayOrigin()}/api/admin/runtime${query}`, {
          credentials: "same-origin", signal: AbortSignal.timeout(15000),
        }));
        if (!current(options.epoch)) return;
        setPolicy(next);
        const clear = () => {
          pendingRef.current = null; setPending(null);
          try { sessionStorage.removeItem(storageKey(account)); } catch { /* A later load can reconcile the same receipt. */ }
        };
        if (!selection) { setMessage(next.recoveryRequired ? "managedAgents.pending" : null); return; }
        const operation = next.operation;
        if (operation?.operationId !== selection.operationId) throw Error("Mismatched assistant receipt");
        if (operation.state === "committed") {
          const result = operation.result;
          if (!result || result.operationId !== selection.operationId || result.activeRuntime !== selection.runtime ||
              result.revision !== selection.expectedRevision + 1 || next.revision < result.revision) throw Error("Invalid assistant receipt");
          clear();
          toast.success(t("managedAgents.saved", { runtime: AGENTS.find(agent => agent.id === selection.runtime)!.label }),
            { accountId: account, eventId: selection.operationId, returnFocus: options.returnFocus });
          void refresh().catch(() => {});
          return;
        }
        if (operation.state === "unknown" && !next.recoveryRequired && (definitive || next.revision > selection.expectedRevision)) {
          clear(); setMessage(failureKey); return;
        }
        if (operation.state === "unknown" && !next.recoveryRequired && next.revision === selection.expectedRevision && retry) {
          post = true; retry = false; continue;
        }
        setMessage("managedAgents.pending"); return;
      }
    } catch {
      if (current(options.epoch)) setMessage(selection ? "managedAgents.pending" : "managedAgents.loadFailed");
    } finally {
      if (current(options.epoch)) { resolvingRef.current = false; setResolving(false); setLoading(false); }
    }
  }, [account, current, refresh, t]);

  useEffect(() => {
    const epoch = ++epochRef.current;
    setPolicy(null); setLoading(true); setMessage(null); resolvingRef.current = false;
    if (account && role === "admin") {
      const selection = storedSelection(account); pendingRef.current = selection; setPending(selection);
      void check(selection, { epoch });
    }
    return () => { epochRef.current = epoch + 1; };
  }, [account, role, check]);

  const save = (id: GatewayRuntimeId, returnFocus?: HTMLElement) => {
    if (!account || !policy || loading || resolvingRef.current || pendingRef.current || policy.recoveryRequired || id === policy.activeRuntime) return;
    const selection = { runtime: id, expectedRevision: policy.revision, operationId: crypto.randomUUID() };
    try { sessionStorage.setItem(storageKey(account), JSON.stringify(selection)); }
    catch { setMessage("managedAgents.failed"); return; }
    pendingRef.current = selection; setPending(selection);
    void check(selection, { epoch: epochRef.current, post: true, returnFocus });
  };
  if (role !== "admin") return null;
  const blocked = loading || resolving || !policy || Boolean(pending) || policy.recoveryRequired;
  const retryable = Boolean(pending) || !policy || policy.recoveryRequired;
  const detail = message ? t(message) : null;
  return <Section title={t("runtime.platformSelect")} flush>
    <div role="radiogroup" aria-label={t("runtime.platformSelect")}>
      {AGENTS.map(({ id, label }) => {
        const option = policy?.available.find(candidate => candidate.runtime === id);
        const available = id === "opencode" || option?.status === "ready" && Boolean(option.defaultModel && option.models.includes(option.defaultModel));
        return <Row key={id} title={label} hint={policy && !available ? t("managedAgents.unavailable") : undefined} control={
          <label className="grid min-h-11 min-w-11 place-items-center"><input type="radio" name="deployment-assistant" aria-label={label} checked={policy?.activeRuntime === id}
            disabled={blocked || !available} className="h-4 w-4 shrink-0 accent-accent"
            onChange={() => save(id, document.activeElement instanceof HTMLElement ? document.activeElement : undefined)} /></label>
        } />;
      })}
    </div>
    {resolving && <p className="px-4 pb-3 text-xs text-muted" role="status">{t("managedAgents.saving")}</p>}
    {detail && <div role="alert" className="px-4 pb-3"><StateNotice issueId={`assistant-selection:${pending?.operationId ?? policy?.revision ?? 0}:${message}`}
      summary={t("common:notification.problem")} detail={detail}
      action={retryable ? { label: t("managedAgents.retry"), run: () => {
        if (!resolvingRef.current) void check(pendingRef.current, { epoch: epochRef.current, retry: true });
      } } : undefined} /></div>}
  </Section>;
}
