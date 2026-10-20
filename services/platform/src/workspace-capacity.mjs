import { randomUUID } from "node:crypto";
import { recoveryError, validWorkspaceContext } from "./workspace-recovery.mjs";

const reasons = new Set(["active_operations", "workspace_reassigned", "execution_active", "idle_unverified", "memory_reserve", "memory_pressure", "build_lock", "queue_full", "queue_timeout"]);
const categories = new Set(["runtime_busy", "execution_busy", "http_status", "malformed_status", "probe_timeout", "probe_unreachable", "generation_scope", "handoff"]);
export function capacityError(reason, { context, blockedContext, activeOperations, activeMutations, maintenance,
  logger, correlationId = randomUUID(), category, elapsedMs, availableBytes, reserveBytes, fullAvg10 } = {}) {
  if (!reasons.has(reason)) throw new Error("invalid capacity reason");
  const error = recoveryError("workspace_capacity_unavailable", { context, retryAfterMs: 5000 });
  error.capacityReason = reason;
  error.failure.correlationId = correlationId;
  const details = {};
  if (categories.has(category)) details.category = category;
  for (const [name, value] of Object.entries({ elapsedMs, availableBytes, reserveBytes, fullAvg10 })) {
    if (Number.isFinite(value) && value >= 0) details[name] = value;
  }
  error.capacityDetails = details;
  if (logger) {
    const event = { type: "workspace.capacity_rejected", reason, correlationId, ...details };
    for (const [name, value] of Object.entries({ context, blockedContext })) {
      if (validWorkspaceContext(value)) event[name] = { instanceId: value.instanceId, generation: value.generation };
    }
    if (Number.isSafeInteger(activeOperations)) event.activeOperations = activeOperations;
    if (Number.isSafeInteger(activeMutations)) event.activeMutations = activeMutations;
    if (typeof maintenance === "boolean") event.maintenance = maintenance;
    logger(event);
  }
  return error;
}
