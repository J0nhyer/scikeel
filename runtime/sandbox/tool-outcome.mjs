const rows = [
  ["tool_permission_denied", "permission", "Execution was not allowed.", "Review the current tool permission.", "never"],
  ["network_admission_denied", "configuration", "Network authorization could not be established.", "Check the managed network connection.", "never"],
  ["network_destination_denied", "permission", "The destination is outside the allowed scope.", "Choose an allowed public destination.", "never"],
  ["network_grant_expired", "permission", "Network authorization expired.", "Start a new authorized call if still needed.", "never"],
  ["network_grant_revoked", "permission", "Network authorization was revoked.", "Check whether the execution was stopped.", "never"],
  ["network_busy", "transient", "Network capacity is temporarily busy.", "Retry within the current call budget.", "transient_read"],
  ["network_timeout", "transient", "The network request timed out.", "Retry within the current call budget.", "transient_read"],
  ["network_upstream_refused", "upstream", "The remote service rejected the request.", "Check its known status and availability.", "never"],
  ["search_unavailable", "configuration", "The configured search service is unavailable.", "Check its configuration or use an available capability.", "never"],
  ["delivery_missing_input", "input", "An original input is missing.", "Correct its workspace-relative path.", "repair_input"],
  ["delivery_mode_mismatch", "input", "Delivery is incompatible with the current mode.", "Review the current research mode.", "never"],
  ["delivery_execution_paused", "input", "Research execution is paused.", "Resume the authorized execution if needed.", "never"],
  ["edit_ambiguous_match", "input", "The replacement matches more than one location.", "Read the file and supply unique surrounding text.", "repair_input"],
  ["edit_no_change", "input", "The replacement would make no change.", "Verify whether the requested content already exists.", "repair_input"],
  ["tool_unavailable", "input", "The selected tool is unavailable.", "Use the current available-tool list.", "never"],
  ["execution_cancelled", "cancelled", "The execution was cancelled.", "Review any partial effects before continuing.", "never"],
  ["execution_interrupted", "interrupted", "The execution was interrupted.", "Check its effect before starting another call.", "never"],
  ["tool_internal_error", "internal", "The tool could not complete.", "Use its correlation identifier to inspect the failure.", "never"]
];
export const OUTCOME_DESCRIPTORS = Object.freeze(Object.fromEntries(rows.map(
  ([code, category, message, nextAction, retry]) => [code, Object.freeze({category,message,nextAction,retry})]
)));
const sources = new Set(["gateway", "egress", "collaboration", "runtime", "upstream"]);
export function makeToolOutcome(code, {source, status, correlationId, details} = {}) {
  const descriptor = Object.hasOwn(OUTCOME_DESCRIPTORS, code) ? OUTCOME_DESCRIPTORS[code] : null;
  if (!descriptor || !sources.has(source) || typeof correlationId !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(correlationId) ||
      (status !== undefined && (!Number.isInteger(status) || status < 100 || status > 599)))
    throw new TypeError("Invalid tool outcome");
  const safe = {};
  if (details !== undefined) {
    if (!details || typeof details !== "object" || Array.isArray(details)) throw new TypeError("Invalid outcome details");
    for (const [key, value] of Object.entries(details)) {
      if (key === "path" && typeof value === "string" && value.length <= 1024 &&
          !value.startsWith("/") && !/[\\:?\u0000-\u001f\u007f]/.test(value) &&
          value.split("/").every(part => part && part !== "." && part !== "..")) safe.path = value;
      else if (key === "origin" && typeof value === "string") {
        const url = new URL(value);
        if (!["http:","https:"].includes(url.protocol) || url.origin !== value || url.username || url.password)
          throw new TypeError("Invalid outcome origin");
        safe.origin = value;
      } else if (["attempts","elapsedMs"].includes(key) && Number.isSafeInteger(value) && value >= 0) safe[key] = value;
      else if (key === "effectUnknown" && typeof value === "boolean") safe.effectUnknown = value;
      else if (key === "verifiedNoChange" && code === "edit_no_change" && typeof value === "boolean") safe.verifiedNoChange = value;
      else throw new TypeError("Invalid outcome detail field");
    }
  }
  const outcome = {version:1, code, ...descriptor, source, correlationId,
    ...(status === undefined ? {} : {status}), ...(Object.keys(safe).length ? {details:safe} : {})};
  if (new TextEncoder().encode(JSON.stringify({error:outcome})).byteLength > 8192)
    throw new TypeError("Tool outcome exceeds limit");
  return outcome;
}
export class ToolOutcomeError extends Error {
  constructor(outcome) { super(outcome.message); this.code=outcome.code; this.status=outcome.status; this.outcome=outcome; }
}
export const serializeToolError = outcome => ({error:outcome});
export function readToolError(text) {
  if (typeof text !== "string" || new TextEncoder().encode(text).byteLength > 8192) return null;
  try {
    const body=JSON.parse(text), value=body?.error;
    if (!value || value.version !== 1 || Object.keys(body).some(key=>key!=="error") ||
        Object.keys(value).some(key=>!["version","code","category","source","status","message","nextAction","retry","correlationId","details"].includes(key))) return null;
    const safe=makeToolOutcome(value.code,value);
    return ["category","message","nextAction","retry"].every(key=>safe[key]===value[key]) ? safe : null;
  } catch { return null; }
}

/** The gateway replaces runtime metadata before forwarding it. Legacy errors only
 * identify concrete runtime observations and never prove authenticated Stop. */
export function normalizeToolResult(tool, state = {}, callId = 'unknown') {
  const status = state.status === 'completed' ? 'success' : state.status === 'error' ? 'failed' : state.status === 'running' ? 'running' : 'pending';
  const error = typeof state.error === 'string' ? state.error : undefined;
  let outcome = readToolError(JSON.stringify({ error: state.metadata?.scikeelOutcome }));
  if (outcome?.correlationId !== callId) outcome = null;
  if (!outcome && error) {
    const reported = readToolError(error);
    if (reported && ['runtime', 'upstream'].includes(reported.source) && reported.correlationId === callId) outcome = reported;
  }
  if (!outcome && /^[A-Za-z0-9_-]{1,128}$/.test(callId)) {
    let code;
    if (tool === 'invalid') code = 'tool_unavailable';
    else if (error === 'The user rejected permission to use this specific tool call.') code = 'tool_permission_denied';
    else if (error === 'No changes to apply: oldString and newString are identical.') code = 'edit_no_change';
    else if (error === 'Found multiple matches for oldString. Provide more surrounding context to make the match unique.') code = 'edit_ambiguous_match';
    else if (error && /^(?:Tool execution aborted|The operation was aborted\.?|Aborted)$/.test(error)) code = 'execution_interrupted';
    if (code) outcome = makeToolOutcome(code, { source: 'runtime', correlationId: callId });
  }
  const warning = outcome && (['execution_cancelled', 'execution_interrupted'].includes(outcome.code) || outcome.code === 'edit_no_change' && outcome.details?.verifiedNoChange === true);
  return { status: warning ? 'warning' : outcome ? 'failed' : status, ...(error === undefined ? {} : { error }), ...(outcome ? { outcome } : {}) };
}
