import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";

export const LAUNCHER_OPERATIONS = Object.freeze(["register", "start", "stop", "inspect"]);
const schemas = { register: ["instanceId", "userId"], start: ["instanceId", "generation", "imageDigest"],
  stop: ["instanceId", "generation", "reason"], inspect: ["instanceId"] };
const identifier = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
const generation = (value) => Number.isSafeInteger(value) && value > 0;
const MAX_FRAME = 65536;
const diagnosticReasons = new Set(["network_resource_collision", "network_tool_unavailable", "network_command_failed",
  "memory_high_not_enforced", "memory_max_not_enforced", "swap_not_enforced", "pids_not_enforced", "cpu_not_enforced", "process_ownership_unverified",
  "limits_not_enforced", "controller_unavailable", "unbounded_controller", "network_inspection_failed", "invalid_network_snapshot",
  "quota_source_not_owned", "quota_wrong_filesystem", "quota_backing_wrong_device", "invalid_controller", "invalid_cpu_controller",
  "mount_failed", "destination_creation_failed", "staging_directory_failed", "host_command_failed", "host_command_timeout",
  "bundle_write_failed", "test_destination_failed", "unmount_failed", "staging_cleanup_failed", "network_namespace_unavailable",
  "network_command_timeout", "network_policy_changed", "network_not_ready", "quota_unavailable", "quota_not_enforced",
  "quota_backing_not_reserved", "host_reserve_insufficient", "controllers_unavailable", "sandbox_readiness_failed",
  "image_not_ready", "wrong_image_variant", "stale_generation", "already_started", "unknown_instance", "cleanup_unverified"]);
function clientError(message, code, reason) {
  return Object.assign(new Error(message), { code, ...(reason ? { reason } : {}) });
}
const replyFields = { register: ["instanceId", "generation"],
  start: ["instanceId", "generation", "endpoint", "runnerEndpoint", "internalToken"],
  stop: ["instanceId", "generation", "stopped"],
  inspect: ["instanceId", "generation", "status", "limits", "quota", "imageDigest", "endpoint", "runnerEndpoint", "internalToken"] };
export function launcherRequest(op, args, requestId) {
  if (!LAUNCHER_OPERATIONS.includes(op)) throw new Error("unsupported launcher operation");
  if (typeof requestId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(requestId)) throw new Error("invalid launcher request ID");
  const keys = schemas[op];
  if (!args || typeof args !== "object" || Array.isArray(args) ||
      Object.keys(args).sort().join(",") !== [...keys].sort().join(",") || !identifier(args.instanceId) ||
      (op === "register" && !identifier(args.userId)) ||
      (["start", "stop"].includes(op) && !generation(args.generation)) ||
      (op === "start" && !/^sha256:[a-f0-9]{64}$/.test(args.imageDigest)) ||
      (op === "stop" && (typeof args.reason !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(args.reason))))
    throw new Error("invalid launcher arguments");
  return { schema: 1, requestId, op, args: { ...args } };
}
function endpoint(value, port) {
  if (typeof value !== "string") throw new Error("invalid launcher endpoint");
  let url;
  try { url = new URL(value); } catch { throw new Error("invalid launcher endpoint"); }
  // The launcher allocates addresses only from the dedicated, internal subnet.
  const match = /^172\.31\.240\.(\d{1,3})$/.exec(url.hostname);
  const octet = match && Number(match[1]);
  if (url.protocol !== "http:" || !match || octet < 2 || octet > 254 || url.port !== String(port) ||
      value !== `http://172.31.240.${octet}:${port}` ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    throw new Error("invalid launcher endpoint");
  return url.hostname;
}
export class SandboxClient {
  constructor({ socketPath, timeoutMs = 30000 } = {}) {
    if (!isAbsolute(socketPath ?? "") || socketPath.includes("\0") || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000)
      throw new Error("invalid launcher client configuration");
    this.socketPath = socketPath; this.timeoutMs = timeoutMs;
  }
  async call(op, args) {
    const request = launcherRequest(op, args, randomUUID());
    const data = JSON.stringify(request) + "\n";
    if (Buffer.byteLength(data) > MAX_FRAME) throw new Error("launcher request exceeds limit");
    return new Promise((resolve, reject) => {
      const socket = createConnection({ path: this.socketPath });
      let buffer = Buffer.alloc(0); let frame; let settled = false;
      const timer = setTimeout(() => fail(clientError("launcher timeout", "launcher_timeout")), this.timeoutMs);
      function fail(error) { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); reject(error); }
      socket.on("connect", () => socket.write(data));
      socket.on("error", () => fail(clientError("launcher unavailable", "launcher_unavailable")));
      socket.on("data", (bytes) => {
        buffer = Buffer.concat([buffer, bytes]);
        if (buffer.length > MAX_FRAME) { fail(new Error("launcher response exceeds limit")); return; }
        const newline = buffer.indexOf(10);
        if (newline !== -1) {
          if (frame || newline !== buffer.length - 1) { fail(new Error("duplicate launcher response")); return; }
          try { frame = JSON.parse(buffer.subarray(0, newline).toString("utf8")); }
          catch { fail(new Error("invalid launcher response")); return; }
          buffer = Buffer.alloc(0);
        }
      });
      socket.on("end", () => {
        if (settled) return;
        try {
          if (!frame || buffer.length || frame.schema !== 1 || frame.requestId !== request.requestId ||
              typeof frame.ok !== "boolean" || Object.keys(frame).some((key) => !["schema", "requestId", "ok", "result", "error"].includes(key)))
            throw new Error("invalid launcher response");
          if (!frame.ok) {
            if (frame.result !== undefined || typeof frame.error !== "string") throw new Error("invalid launcher failure response");
            const reason = diagnosticReasons.has(frame.error) ? frame.error : undefined;
            throw clientError("launcher rejected operation", "launcher_rejected", reason);
          }
          const result = frame.result;
          if (!result || typeof result !== "object" || Array.isArray(result) ||
              Object.keys(result).some((key) => !replyFields[op].includes(key)) || result.instanceId !== args.instanceId || !generation(result.generation) ||
              (args.generation !== undefined && result.generation !== args.generation)) throw new Error("stale or foreign launcher response");
          if (frame.error !== undefined) throw new Error("invalid launcher success response");
          if (op === "inspect" && !["registered", "starting", "ready", "stopped", "unavailable"].includes(result.status))
            throw new Error("invalid launcher inspection response");
          if (op === "start" || (op === "inspect" && result.status === "ready")) {
            if (endpoint(result.endpoint, 4790) !== endpoint(result.runnerEndpoint, 4791)) throw new Error("foreign launcher runner endpoint");
          }
          if (Object.hasOwn(result, "internalToken") && !/^[a-f0-9]{64}$/.test(result.internalToken)) throw new Error("invalid launcher internal token");
          if (op === "stop" && result.stopped !== true) throw new Error("invalid launcher stop response");
          settled = true; clearTimeout(timer); socket.destroy(); resolve(result);
        } catch (error) { fail(error); }
      });
      socket.on("close", () => { if (!settled) fail(clientError("launcher disconnected", "launcher_disconnected")); });
    });
  }
  register(args) { return this.call("register", args); }
  start(args) { return this.call("start", args); }
  stop(args) { return this.call("stop", args); }
  inspect(args) { return this.call("inspect", args); }
}
