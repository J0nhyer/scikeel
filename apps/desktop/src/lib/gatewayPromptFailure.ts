import {ApiError} from "@ai4s/sdk";
type FailureName="workspaceBusy"|"workspaceTimeout"|"workspaceUnavailable"|"workspaceDenied"|"executionRunning"|"deliveryUnconfirmed"|"sendIdChanged"|"recoveryUnconfirmed"|"providerRejected";
export type GatewayPromptFailureKey=`session:composer.error.${FailureName}`;
/** Only structured codes affect recovery; raw upstream messages are never parsed. */
export function gatewayPromptFailureKey(error: unknown): GatewayPromptFailureKey | null {
  if (!(error instanceof ApiError)) {
    return error instanceof TypeError || error instanceof DOMException && error.name === "AbortError"
      ? "session:composer.error.deliveryUnconfirmed" : null;
  }
  const keys: Record<string,FailureName> = {
    workspace_rpc_busy: "workspaceBusy", workspace_rpc_queue_full: "workspaceBusy",
    workspace_rpc_timeout: "workspaceTimeout", workspace_rpc_unavailable: "workspaceUnavailable",
    workspace_rpc_cancelled: "workspaceUnavailable", workspace_rpc_denied: "workspaceDenied",
    research_execution_running: "executionRunning", prompt_delivery_unknown: "deliveryUnconfirmed",
    turn_uncertain: "deliveryUnconfirmed", turn_pending: "deliveryUnconfirmed",
    turn_legacy_receipt: "deliveryUnconfirmed", turn_input_changed: "sendIdChanged",
    prompt_recovery_failed: "recoveryUnconfirmed", model_upstream_rejected: "providerRejected",
  };
  const key=error.code && Object.prototype.hasOwnProperty.call(keys,error.code) ? keys[error.code] : null;
  return key ? `session:composer.error.${key}` : error.status===403 ? "session:composer.error.workspaceDenied" : null;
}
