/** Safe, versioned tool failures. Raw runtime errors are never trusted envelopes. */
export type ToolOutcomeCode =
  | "tool_permission_denied" | "network_admission_denied" | "network_destination_denied"
  | "network_grant_expired" | "network_grant_revoked" | "network_busy" | "network_timeout"
  | "network_upstream_refused" | "search_unavailable" | "delivery_missing_input"
  | "delivery_mode_mismatch" | "delivery_execution_paused" | "edit_ambiguous_match"
  | "edit_no_change" | "tool_unavailable" | "execution_cancelled" | "execution_interrupted"
  | "tool_internal_error";
export interface ToolOutcome {
  version: 1;
  code: ToolOutcomeCode;
  category: "permission" | "configuration" | "transient" | "upstream" | "input" | "cancelled" | "interrupted" | "internal";
  source: "gateway" | "egress" | "collaboration" | "runtime" | "upstream";
  status?: number;
  message: string;
  nextAction: string;
  retry: "never" | "transient_read" | "repair_input";
  correlationId: string;
  details?: { path?: string; origin?: string; attempts?: number; elapsedMs?: number; effectUnknown?: boolean; verifiedNoChange?: boolean };
}
