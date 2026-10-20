export type WorkspaceContext = { instanceId: string; generation: number };
export type WorkspaceReport = {
  context: WorkspaceContext | null;
  state: "healthy" | "stopped" | "starting" | "recovering" | "unreachable" | "unresponsive" | "unknown" | "capacity";
  activity: "idle" | "running" | "maintenance" | "unknown";
  canRestart: boolean;
  retryAfterMs: number;
};
export type WorkspaceRecoveryCommand = { action: "retry" } | ({ action: "restart"; confirmed: true } & WorkspaceContext);
export type WorkspaceFailure = {
  code: string; error: string; stage: "workspace" | "runtime" | "capacity" | "recovery";
  retryable: boolean; context: WorkspaceContext | null;
  action: "retry" | "confirm_restart" | "wait" | "none"; retryAfterMs: number;
  correlationId?: string;
};
export class GatewayWorkspaceError extends Error {
  constructor(public status: number, public failure: WorkspaceFailure) { super(failure.error); this.name = "GatewayWorkspaceError"; }
}
const messages: Record<string, string> = {
  workspace_stopped: "Workspace is stopped", workspace_unreachable: "Workspace could not be reached",
  runtime_unresponsive: "Runtime is not responding", workspace_status_unknown: "Workspace status could not be verified",
  workspace_capacity_unavailable: "Workspace capacity is unavailable", workspace_recovery_in_progress: "Workspace recovery is in progress",
  workspace_recovery_cooldown: "Workspace recovery is temporarily limited", workspace_recovery_required: "Workspace recovery is required",
  stale_workspace_context: "Workspace has changed", workspace_cleanup_unverified: "Workspace cleanup could not be verified",
};
const contextValid = (value: unknown): value is WorkspaceContext => !!value && typeof value === "object" &&
  typeof (value as WorkspaceContext).instanceId === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test((value as WorkspaceContext).instanceId) &&
  Number.isSafeInteger((value as WorkspaceContext).generation) && (value as WorkspaceContext).generation > 0;
const backoffValid = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 60000;
export function isWorkspaceReport(value: unknown): value is WorkspaceReport {
  const v = value as WorkspaceReport | null;
  return !!v && (v.context === null || contextValid(v.context)) &&
    ["healthy", "stopped", "starting", "recovering", "unreachable", "unresponsive", "unknown", "capacity"].includes(v.state) &&
    ["idle", "running", "maintenance", "unknown"].includes(v.activity) && typeof v.canRestart === "boolean" && backoffValid(v.retryAfterMs) &&
    (!v.canRestart || (v.state === "unresponsive" && contextValid(v.context) && v.activity !== "maintenance" && v.retryAfterMs === 0));
}
export function decodeWorkspaceFailure(value: unknown): WorkspaceFailure | null {
  const v = value as WorkspaceFailure | null;
  if (!v || !Object.prototype.hasOwnProperty.call(messages, v.code) || (v.context !== null && !contextValid(v.context)) || !backoffValid(v.retryAfterMs) ||
      !["workspace", "runtime", "capacity", "recovery"].includes(v.stage) || !["retry", "confirm_restart", "wait", "none"].includes(v.action) ||
      typeof v.retryable !== "boolean" || (v.action === "confirm_restart" && (v.code !== "runtime_unresponsive" || !contextValid(v.context))) ||
      (v.correlationId !== undefined && (typeof v.correlationId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v.correlationId))) ||
      (v.code === "workspace_capacity_unavailable" && (v.stage !== "capacity" || v.action !== "wait" || !v.retryable))) return null;
  return { code: v.code, error: messages[v.code], stage: v.stage, retryable: v.retryable,
    context: v.context ? { instanceId: v.context.instanceId, generation: v.context.generation } : null,
    action: v.action, retryAfterMs: v.retryAfterMs, ...(v.correlationId ? { correlationId: v.correlationId } : {}) };
}
export type WorkspaceReadOptions = { signal: AbortSignal; timeoutMs: number; context?: WorkspaceContext | null };
export class GatewayWorkspaceClient {
  private fetchImpl: typeof fetch;
  constructor({ fetchImpl = fetch }: { fetchImpl?: typeof fetch } = {}) { this.fetchImpl = fetchImpl; }
  status(options: WorkspaceReadOptions): Promise<WorkspaceReport> { return this.request("/api/workspace/status", undefined, options); }
  recover(command: WorkspaceRecoveryCommand, options: WorkspaceReadOptions): Promise<WorkspaceReport> {
    return this.request("/api/workspace/recover", command, options);
  }
  private async request(path: string, command: WorkspaceRecoveryCommand | undefined, { signal, timeoutMs, context }: WorkspaceReadOptions): Promise<WorkspaceReport> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Workspace request deadline expired");
    if (context !== undefined && context !== null && !contextValid(context)) throw new Error("Invalid workspace request context");
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(() => controller.abort(new Error("Workspace request timed out")), timeoutMs);
    let rejectAbort: () => void = () => {};
    const cancelled = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(controller.signal.reason ?? new Error("Workspace request cancelled"));
      controller.signal.addEventListener("abort", rejectAbort, { once: true });
      if (controller.signal.aborted) rejectAbort();
    });
    try {
      return await Promise.race([cancelled, (async () => {
        const response = await this.fetchImpl(path, { method: command ? "POST" : "GET", credentials: "same-origin", signal: controller.signal,
          headers: { accept: "application/json", ...(command ? { "content-type": "application/json" } : {}),
            ...(context ? { "x-scikeel-runtime-generation": String(context.generation) } : {}) },
          ...(command ? { body: JSON.stringify(command) } : {}) });
        const body: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          const failure = decodeWorkspaceFailure(body);
          if (!failure) throw new Error("Workspace status could not be verified");
          throw new GatewayWorkspaceError(response.status, failure);
        }
        if (!isWorkspaceReport(body)) throw new Error("Workspace status could not be verified");
        return body;
      })()]);
    } finally {
      clearTimeout(timer); signal.removeEventListener("abort", abort); controller.signal.removeEventListener("abort", rejectAbort);
    }
  }
}
