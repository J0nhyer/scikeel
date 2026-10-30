import { toast } from "@/lib/toast";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { StateNotice } from "../ui/StateNotice";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Row, Section } from "./Section";
import { useRuntimeStore, type GatewayRuntimeId } from "@/lib/runtime";
import { gatewayOrigin } from "@/lib/webMode";

type Selection = { runtime: GatewayRuntimeId; expectedRevision: number; operationId: string };
type Message = "managedAgents.failed" | "managedAgents.busy" | "managedAgents.unavailable" | "managedAgents.recoveryUnavailable" | "managedAgents.recoveryFailed" | "managedAgents.pending" | "managedAgents.loadFailed" | "managedAgents.recoveryRequired";
type Recovery = { executionId: string; runtime: GatewayRuntimeId; generation: number; userId: string; sessionId: string;
  identity: { userId: string; instanceId: string; generation: number; conversationId: string;
    execution: number; requestId: string; policyRevision: number; runtime: GatewayRuntimeId } };
type Policy = { activeRuntime: GatewayRuntimeId; revision: number; recoveryRequired: boolean;
  recoveryReason?: "execution" | "live" | "transition" | "persistence" | "manual" | null;
  recoverable?: Recovery | null;
  available: { runtime: GatewayRuntimeId; status?: string; models: string[]; defaultModel?: string | null }[];
  operation: { operationId: string; state: "pending" | "unknown" | "committed";
    result?: { activeRuntime: GatewayRuntimeId; revision: number; operationId: string } } | null };
const AGENTS = [{ id: "opencode", label: "OpenCode" }, { id: "claude", label: "Claude Code" }, { id: "codex", label: "Codex" }] as const;
const RECOVERY_DIALOG_TONE = "default" as const;
const runtime = (value: unknown): value is GatewayRuntimeId => AGENTS.some(agent => agent.id === value);
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const storageKey = (account: string) => `scikeel.assistant-selection.v1:${account}`;
// getRandomValues works on plain-HTTP origins; randomUUID requires a secure context.
const newOperationId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)),
  byte => byte.toString(16).padStart(2, "0")).join("");

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
      value.recoveryReason !== undefined && value.recoveryReason !== null &&
        !["execution", "live", "transition", "persistence", "manual"].includes(value.recoveryReason) ||
      !Array.isArray(value.available) || value.available.length !== AGENTS.length ||
      new Set(value.available.map(option => option?.runtime)).size !== AGENTS.length ||
      value.available.some(option => !option || !runtime(option.runtime) || !Array.isArray(option.models) ||
        option.models.length > 1000 || option.models.some(model => typeof model !== "string")) ||
      value.recoverable !== undefined && value.recoverable !== null && !(
        typeof value.recoverable.executionId === "string" && value.recoverable.executionId.length > 0 &&
        runtime(value.recoverable.runtime) && positive(value.recoverable.generation) &&
        typeof value.recoverable.userId === "string" && typeof value.recoverable.sessionId === "string" &&
        value.recoverable.identity && runtime(value.recoverable.identity.runtime) &&
        positive(value.recoverable.identity.generation) && positive(value.recoverable.identity.execution) &&
        positive(value.recoverable.identity.policyRevision) &&
        [value.recoverable.identity.userId, value.recoverable.identity.instanceId,
          value.recoverable.identity.conversationId, value.recoverable.identity.requestId]
          .every(field => typeof field === "string" && field.length > 0) &&
        value.recoverable.identity.runtime === value.recoverable.runtime &&
        value.recoverable.identity.generation === value.recoverable.generation &&
        value.recoverable.identity.userId === value.recoverable.userId &&
        value.recoverable.identity.conversationId === value.recoverable.sessionId) ||
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
  const [recovering, setRecovering] = useState(false);
  const [confirming, setConfirming] = useState(false);
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
        let refusal: string | null = null;
        let failureKey: Message = "managedAgents.failed";
        if (post && selection) {
          try {
            const result = await fetch(`${gatewayOrigin()}/api/admin/runtime`, { method: "POST", credentials: "same-origin",
              headers: { "Content-Type": "application/json" }, body: JSON.stringify(selection), signal: AbortSignal.timeout(15000) });
            if (!result.ok) {
              definitive = [400, 403, 409].includes(result.status);
              const body = await result.json().catch(() => null) as { code?: string } | null;
              refusal = typeof body?.code === "string" ? body.code : null;
              if (refusal === "assistant_busy") failureKey = "managedAgents.busy";
              if (refusal === "assistant_unavailable") failureKey = "managedAgents.unavailable";
              // A refusal that needs reconciliation is not a lost acknowledgement:
              // the server holds no intent, and the administrator must be told
              // what has to be reconciled.
              if (refusal === "assistant_recovery_required" || refusal === "assistant_persistence_uncertain")
                failureKey = "managedAgents.recoveryRequired";
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
        if (!selection) {
          setMessage(next.recoveryReason === "execution" ? null
            : next.recoveryRequired ? "managedAgents.recoveryRequired" : null);
          return next;
        }
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
          return next;
        }
        if (operation.state === "unknown" && !next.recoveryRequired && (definitive || next.revision > selection.expectedRevision)) {
          clear(); setMessage(failureKey); return next;
        }
        if (operation.state === "unknown" && !next.recoveryRequired && next.revision === selection.expectedRevision) {
          // The server holds no intent for this selection. A refusal is final,
          // and the panel must not stay fenced by a request that was never
          // persisted — the administrator could not act at all.
          if (refusal && refusal !== "assistant_persistence_uncertain") { clear(); setMessage(failureKey); return next; }
          if (retry) { post = true; retry = false; continue; }
        }
        if (operation.state === "pending") {
          // The server holds a durable intent. It is reconciled, not replaced.
          setMessage(next.recoveryRequired ? "managedAgents.recoveryRequired" :
            failureKey === "managedAgents.failed" ? "managedAgents.pending" : failureKey); return next;
        }
        setMessage("managedAgents.pending"); return next;
      }
      return null;
    } catch {
      if (current(options.epoch)) setMessage(selection ? "managedAgents.pending" : "managedAgents.loadFailed");
      return null;
    } finally {
      if (current(options.epoch)) { resolvingRef.current = false; setResolving(false); setLoading(false); }
    }
  }, [account, current, refresh, t]);

  /** Reconcile the deployment's assistant policy. A transition that something
   *  still blocks cannot be replaced by another request; the policy has to be
   *  reconciled first, and this is the administrator's way to do it. */
  const reconcile = useCallback(async () => {
    if (!account || !current(epochRef.current)) return;
    resolvingRef.current = true; setResolving(true);
    try {
      await fetch(`${gatewayOrigin()}/api/admin/runtime/reconcile`, { method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(15000) }).catch(() => null);
    } finally {
      resolvingRef.current = false; setResolving(false);
    }
    // The reconciliation may have committed the cutover the browser holds.
    const next = await check(pendingRef.current, { epoch: epochRef.current });
    if (next?.recoveryRequired) setMessage("managedAgents.recoveryRequired");
  }, [account, check, current]);

  const recover = useCallback(async () => {
    if (!account || !policy?.recoverable || resolvingRef.current) return;
    setConfirming(false);
    resolvingRef.current = true; setResolving(true); setRecovering(true); setMessage(null);
    try {
      const result = await fetch(`${gatewayOrigin()}/api/admin/runtime/recover`, { method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identity: policy.recoverable.identity, expectedRevision: policy.revision }),
        signal: AbortSignal.timeout(15000) });
      if (!result.ok) {
        const body = await result.json().catch(() => null) as { code?: string } | null;
        // Re-read the committed revision so a stale page can recover with a
        // fresh expectedRevision instead of replaying the same conflict.
        await check(null, { epoch: epochRef.current });
        setMessage(body?.code === "assistant_busy" ? "managedAgents.busy"
          : body?.code === "assistant_unavailable" ? "managedAgents.recoveryUnavailable"
          : "managedAgents.recoveryFailed");
        return;
      }
      await result.body?.cancel();
      pendingRef.current = null; setPending(null);
      try { sessionStorage.removeItem(storageKey(account)); } catch { /* The server is authoritative. */ }
      toast.success(t("managedAgents.recovered"), { accountId: account,
        returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : undefined });
      void refresh().catch(() => {});
      await check(null, { epoch: epochRef.current });
    } catch {
      setMessage("managedAgents.recoveryRequired");
    } finally {
      resolvingRef.current = false; setResolving(false); setRecovering(false);
    }
  }, [account, check, policy, refresh, t]);

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
    const selection = { runtime: id, expectedRevision: policy.revision, operationId: newOperationId() };
    try { sessionStorage.setItem(storageKey(account), JSON.stringify(selection)); }
    catch { setMessage("managedAgents.failed"); return; }
    pendingRef.current = selection; setPending(selection);
    void check(selection, { epoch: epochRef.current, post: true, returnFocus });
  };
  if (role !== "admin") return null;
  const blocked = loading || resolving || !policy || Boolean(pending) || policy.recoveryRequired;
  const retryable = policy?.recoveryReason === "execution" || policy?.recoveryReason === "live" ||
    policy?.recoveryReason === "manual"
    ? false : Boolean(pending) || !policy || policy.recoveryRequired;
  const recoveryBlocked = loading || resolving || !policy?.recoverable;
  const detail = message ? t(message) : null;
  return <Section title={t("runtime.platformSelect")} flush>
    {policy?.recoveryRequired && policy.recoveryReason === "execution" && policy.recoverable &&
      <div role="status" className="px-4 pb-3 text-xs">
        <p className="font-medium text-text">{t("managedAgents.recoveryTitle")}</p>
        <p className="mt-1 text-muted">{t("managedAgents.recoveryHint", {
          runtime: AGENTS.find(agent => agent.id === policy.recoverable!.runtime)?.label ?? policy.activeRuntime,
        })}</p>
        <p className="mt-1 text-muted">{t("managedAgents.recoverySession", { session: policy.recoverable.sessionId })}</p>
        <button type="button" disabled={recoveryBlocked}
          className="mt-2 rounded-input border border-border px-3 py-2 text-text disabled:opacity-50"
          onClick={() => setConfirming(true)}>
          {recovering ? t("managedAgents.recovering") : t("managedAgents.recover")}
        </button>
      </div>}
    {policy?.recoveryRequired && policy.recoveryReason === "live" &&
      <div role="status" className="px-4 pb-3 text-xs">
        <p className="font-medium text-text">{t("managedAgents.recoveryTitle")}</p>
        <p className="mt-1 text-muted">{t("managedAgents.recoveryLive")}</p>
      </div>}
    {policy?.recoveryRequired && policy.recoveryReason === "manual" &&
      <div role="status" className="px-4 pb-3 text-xs">
        <p className="font-medium text-text">{t("managedAgents.recoveryTitle")}</p>
        <p className="mt-1 text-muted">{t("managedAgents.recoveryManual")}</p>
      </div>}
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
        if (resolvingRef.current) return;
        // A policy that must be reconciled is not repaired by another
        // selection request: the deployment reconciles it instead.
        if (message === "managedAgents.recoveryRequired") { void reconcile(); return; }
        void check(pendingRef.current, { epoch: epochRef.current, retry: true });
      } } : undefined} /></div>}
    {confirming && policy?.recoverable && <ConfirmDialog title={t("managedAgents.recoverConfirmTitle")}
      body={t("managedAgents.recoverConfirmBody")} confirmLabel={t("managedAgents.recoverConfirm")}
      tone={RECOVERY_DIALOG_TONE} onConfirm={() => void recover()} onCancel={() => setConfirming(false)} />}
  </Section>;
}
