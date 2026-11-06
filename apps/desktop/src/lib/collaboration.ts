import { toast } from "./toast";
import { useRuntimeStore } from "./runtime";
import i18n from "@/i18n";
import { useCallback, useEffect, useState, useRef } from "react";
import { gatewayOrigin, isGatewayWeb, setPlatformWorkspaceGeneration } from "./webMode";
import { researchPageId } from "./research";
export type CollaborationMode = "guided" | "collaborative" | "delegated" | "autonomous";
export interface ResearchDecision {
  id: string;
  execution: number;
  kind: "plan" | "step" | "method" | "missing_input";
  question: string;
  suggestedAnswer: string;
  answer?: string;
  answeredAt?: number;
}
export interface ResearchDelivery {
  status: "pending" | "completed" | "failed";
  attempts: number;
  issue?: "changed_inputs" | "missing_progress" | "pending_decisions" | "incomplete_report" | "missing_outputs" | "failed_checks" | null;
  report: { limitations: string } | null;
}
export interface CollaborationState {
  version: 1;
  mode: CollaborationMode;
  revision: number;
  execution: number;
  executionMode?: CollaborationMode;
  phase: "idle" | "running" | "waiting_input" | "paused";
  pending: ResearchDecision | null;
  decisions: ResearchDecision[];
  delivery?: ResearchDelivery;
}
export interface CollaborationResult {
  state: CollaborationState;
  available: boolean;
}
export const defaultCollaboration: CollaborationState = {
  version: 1,
  mode: "autonomous",
  revision: 0,
  execution: 0,
  phase: "idle",
  pending: null,
  decisions: [],
};
export async function collaborationRequest(
  sessionId: string,
  body?: unknown,
  keepalive = false,
): Promise<CollaborationResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Collaboration request timed out"));
    }, 10000);
  });
  try {
    return await Promise.race([deadline, (async () => {
      const response = await fetch(
        `${gatewayOrigin()}/api/collaboration/${encodeURIComponent(sessionId)}`,
        {
          credentials: "same-origin", keepalive, signal: controller.signal,
          ...(body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
        },
      );
      const value = await response.json();
      if (!response.ok) { let message = `HTTP ${response.status}`; let code: string | undefined; let retryAfterMs = 0; if (value && typeof value === "object") { if ("error" in value && typeof value.error === "string") message = value.error; if ("code" in value && typeof value.code === "string") code = value.code; if ("retryAfterMs" in value && typeof value.retryAfterMs === "number" && value.retryAfterMs > 0) retryAfterMs = value.retryAfterMs; } if (retryAfterMs === 0) { const header = response.headers.get("retry-after"); const headerMs = header !== null && /^\d+$/.test(header) ? Number(header) * 1000 : 0; if (headerMs > 0) retryAfterMs = headerMs; } const err = new Error(message) as Error & { status?: number; code?: string; retryAfterMs?: number }; err.status = response.status; if (code !== undefined) err.code = code; if (retryAfterMs > 0) err.retryAfterMs = retryAfterMs; throw err; }
      return value;
    })()]);
  } finally { clearTimeout(timer); }
}
/** Persist a draft choice before execution, without resaving existing preferences. */
export async function prepareCollaborationSend(sessionId: string, draftMode?: CollaborationMode): Promise<number> {
  let current = await collaborationRequest(sessionId);
  if (!current.available) throw new Error("Collaboration runtime is not ready. Reload and retry.");
  if (draftMode && draftMode !== current.state.mode) {
    current = await collaborationRequest(sessionId, { action: "mode", mode: draftMode, revision: current.state.revision });
    if (!current.available) throw new Error("Collaboration runtime is not ready. Reload and retry.");
  }
  const ready = await collaborationRequest(sessionId, { action: "heartbeat", pageId: researchPageId });
  if (!ready.available) throw new Error("Collaboration runtime is not ready. Reload and retry.");
  return ready.state.revision;
}
/** Visibility is a platform capability, not a property of the selected assistant. */
export function collaborationPollingEnabled({
  isGatewayWeb,
  isPlatformWeb,
  connected,
}: {
  isGatewayWeb: boolean;
  isPlatformWeb: boolean;
  connected: boolean;
}): boolean {
  return isGatewayWeb && isPlatformWeb && connected;
}
const pageUsers = new Map<string, number>();
/** Read-only loading never begins or resumes a model turn. */
export function useCollaboration(sessionId: string | null, enabled: boolean) {
  const sequence = useRef(0);
  const previousSession = useRef(sessionId);
  const [result, setResult] = useState<CollaborationResult>({
    state: defaultCollaboration,
    available: false,
  });
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const apply = useCallback(
    (value: CollaborationResult) =>
      setResult((previous) =>
        value.state.revision >= previous.state.revision ? value : previous,
      ),
    [],
  );
  const refresh = useCallback(async () => {
    if (!sessionId || !enabled) return;
    const generation = sequence.current;
    try {
      const value = await collaborationRequest(sessionId);
      if (sequence.current !== generation) return;
      setResult((previous) =>
        value.state.revision >= previous.state.revision ? value : previous,
      );
      setError(null);
      setSaveError(null);
    } catch (e) {
      if (sequence.current !== generation) return;
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [sessionId, enabled]);
  useEffect(() => {
    const generation = ++sequence.current;
    setSaving(false);
    const wasDraft = previousSession.current === null;
    previousSession.current = sessionId;
    setResult((previous) => ({ state: !sessionId && wasDraft
      ? { ...defaultCollaboration, mode: previous.state.mode }
      : defaultCollaboration, available: false }));
    setError(null);
    setSaveError(null);
    if (!isGatewayWeb || !enabled || !sessionId) return;
    pageUsers.set(sessionId, (pageUsers.get(sessionId) ?? 0) + 1);
    let active = true;
    const accountId = useRuntimeStore.getState().gatewayUser?.id ?? null;
    let observedRevision = -1;
    let observed: { execution: number; status: string | undefined } | null = null;
    let failures = 0;
    let beatFailures = 0;
    let lastStaleAt = 0;
    let pollTimer: number | undefined;
    let beatTimer: number | undefined;
    const onStale = (e: unknown): void => { if (!(e instanceof Error)) return; const code = "code" in e ? e.code : undefined; const status = "status" in e ? e.status : undefined; if (code === "stale_workspace_context" || (status === 409 && e.message.includes("Workspace has changed"))) { const now = Date.now(); if (now - lastStaleAt < 30000) return; lastStaleAt = now; setPlatformWorkspaceGeneration(null); const state = useRuntimeStore.getState(); if (typeof state.connectRetry === "function") void state.connectRetry().catch(() => {}); } };
    const scheduleRead = (delay: number) => { if (!active) return; window.clearTimeout(pollTimer); pollTimer = window.setTimeout(() => void read(), delay); };
    const read = async () => {
      try {
        const value = await collaborationRequest(sessionId);
        failures = 0;
        if (active) {
          if (value.state.revision < observedRevision) { scheduleRead(2000); return; }
          observedRevision = value.state.revision;
          const status = value.state.delivery?.status;
          if (observed && status === "completed" && (observed.execution !== value.state.execution || observed.status !== "completed")) {
            toast.success(i18n.t("session:collaboration.deliveryCompleted"), {
              accountId, sessionId, eventId: `delivery:${value.state.execution}:completed`,
            });
          } else if (observed && status === "failed" && (observed.execution !== value.state.execution || observed.status !== "failed")) {
            toast.error(i18n.t("session:collaboration.deliveryFailed"), {
              accountId, sessionId, eventId: `delivery:${value.state.execution}:failed:${value.state.delivery?.attempts ?? 0}`,
            });
          }
          observed = { execution: value.state.execution, status };
          apply(value);
          setError(null);
        }
        scheduleRead(2000);
      } catch (e) {
        failures += 1;
        onStale(e);
        if (active) setError(e instanceof Error ? e.message : String(e));
        const retryMs = typeof e === "object" && e !== null && "retryAfterMs" in e && typeof e.retryAfterMs === "number" && e.retryAfterMs > 0 ? e.retryAfterMs : 0;
        scheduleRead(Math.max(retryMs, Math.min(2000 * 2 ** Math.max(0, failures - 1), 30000)));
      }
    };
    void read();
    const scheduleBeat = (delay: number) => { if (!active) return; window.clearTimeout(beatTimer); beatTimer = window.setTimeout(() => void beat(), delay); };
    const beat = async () => {
      let retryMs = 0;
      try {
        await collaborationRequest(sessionId, { action: "heartbeat", pageId: researchPageId });
        beatFailures = 0;
      } catch (e) {
        beatFailures += 1;
        onStale(e);
        retryMs = typeof e === "object" && e !== null && "retryAfterMs" in e && typeof e.retryAfterMs === "number" && e.retryAfterMs > 0 ? e.retryAfterMs : 0;
      }
      scheduleBeat(Math.max(retryMs, Math.min(10000 * 2 ** Math.max(0, beatFailures - 1), 60000)));
    };
    void beat();
    const release = () =>
      void collaborationRequest(
        sessionId,
        { action: "release", pageId: researchPageId },
        true,
      ).catch(() => {});
    window.addEventListener("pagehide", release);
    return () => {
      active = false;
      sequence.current = generation + 1;
      window.clearTimeout(pollTimer);
      window.clearTimeout(beatTimer);
      window.removeEventListener("pagehide", release);
      const users = (pageUsers.get(sessionId) ?? 1) - 1;
      if (users > 0) pageUsers.set(sessionId, users);
      else {
        pageUsers.delete(sessionId);
        release();
      }
    };
  }, [sessionId, enabled, apply]);
  const action = async (body: Record<string, unknown>) => {
    if (!sessionId || saving) return false;
    const generation = sequence.current;
    setSaving(true);
    try {
      const saved = await collaborationRequest(sessionId, body);
      if (sequence.current !== generation) return false;
      apply(saved);
      setError(null);
      setSaveError(null);
      return true;
    } catch (e) {
      if (sequence.current !== generation) return false;
      setSaveError(e instanceof Error ? e.message : String(e));
      const current = await collaborationRequest(sessionId).catch(() => null);
      if (current && sequence.current === generation) apply(current);
      return false;
    } finally {
      if (sequence.current === generation) setSaving(false);
    }
  };
  return {
    ...result,
    error: saveError ?? error,
    saving,
    refresh,
    setMode: (mode: CollaborationMode) => {
      if (!sessionId && enabled && ["guided", "collaborative", "delegated", "autonomous"].includes(mode)) {
        setResult((previous) => ({ ...previous, state: { ...previous.state, mode } }));
        return Promise.resolve(true);
      }
      return action({ action: "mode", mode, revision: result.state.revision });
    },
    answer: (answer: string) =>
      result.state.pending
        ? action({
            action: "answer",
            id: result.state.pending.id,
            execution: result.state.pending.execution,
            revision: result.state.revision,
            answer,
          })
        : Promise.resolve(false),
    pause: () =>
      action({ action: "pause", execution: result.state.execution, revision: result.state.revision }),
    discard: () =>
      result.state.pending
        ? action({
            action: "discard",
            id: result.state.pending.id,
            execution: result.state.pending.execution,
            revision: result.state.revision,
          })
        : Promise.resolve(false),
  };
}
