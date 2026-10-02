import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";

export const LAUNCHER_OPERATIONS = Object.freeze(["register", "start", "stop", "inspect"]);
const schemas = { register: ["instanceId", "userId"], start: ["instanceId", "generation", "imageDigest"],
  stop: ["instanceId", "generation", "reason"], inspect: ["instanceId"] };
const identifier = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
const generation = (value) => Number.isSafeInteger(value) && value > 0;
const MAX_FRAME = 65536;
const replyFields = { register: ["instanceId", "generation"],
  start: ["instanceId", "generation", "endpoint", "runnerEndpoint"],
  stop: ["instanceId", "generation", "stopped"],
  inspect: ["instanceId", "generation", "status", "limits", "quota", "imageDigest", "endpoint", "runnerEndpoint"] };
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
function endpoint(value) {
  if (typeof value !== "string") throw new Error("invalid launcher endpoint");
  let url;
  try { url = new URL(value); } catch { throw new Error("invalid launcher endpoint"); }
  // The launcher allocates addresses only from the dedicated, internal subnet.
  const match = /^172\.31\.240\.(\d{1,3})$/.exec(url.hostname);
  const octet = match && Number(match[1]);
  if (url.protocol !== "http:" || !match || octet < 2 || octet > 254 || !url.port ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    throw new Error("invalid launcher endpoint");
  return value;
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
      const timer = setTimeout(() => fail(new Error("launcher timeout")), this.timeoutMs);
      function fail(error) { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); reject(error); }
      socket.on("connect", () => socket.write(data));
      socket.on("error", () => fail(new Error("launcher unavailable")));
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
          if (!frame.ok) throw new Error("launcher rejected operation");
          const result = frame.result;
          if (!result || typeof result !== "object" || Array.isArray(result) ||
              Object.keys(result).some((key) => !replyFields[op].includes(key)) || result.instanceId !== args.instanceId || !generation(result.generation) ||
              (args.generation !== undefined && result.generation !== args.generation)) throw new Error("stale or foreign launcher response");
          if (frame.error !== undefined) throw new Error("invalid launcher success response");
          if (op === "inspect" && !["registered", "starting", "ready", "stopped", "unavailable"].includes(result.status))
            throw new Error("invalid launcher inspection response");
          if (op === "start") { endpoint(result.endpoint); endpoint(result.runnerEndpoint); }
          if (op === "stop" && result.stopped !== true) throw new Error("invalid launcher stop response");
          settled = true; clearTimeout(timer); socket.destroy(); resolve(result);
        } catch (error) { fail(error); }
      });
      socket.on("close", () => { if (!settled) fail(new Error("launcher disconnected")); });
    });
  }
  register(args) { return this.call("register", args); }
  start(args) { return this.call("start", args); }
  stop(args) { return this.call("stop", args); }
  inspect(args) { return this.call("inspect", args); }
}
