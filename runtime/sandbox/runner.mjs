import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFile, lstat, mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { FileRpc, fileRequest } from "./file-rpc.mjs";
import { buildJobEnvironment } from "./cli-jobs.mjs";

function validateManifest(value) {
  if (!value || value.schema !== 1 || !/^[A-Za-z0-9_-]{1,64}$/.test(value.instanceId ?? "") || !Number.isSafeInteger(value.generation) || value.generation < 1 ||
      Object.keys(value).sort().join(",") !== ["schema", "instanceId", "generation", "workspaceDir", "stateDir", "home", "scratchDir"].sort().join(","))
    throw new Error("invalid tenant manifest");
  const paths = [value.workspaceDir, value.stateDir, value.home, value.scratchDir];
  if (paths.some((path) => typeof path !== "string" || !path.startsWith("/") || path === "/" || /[\0\\]/.test(path) || path.endsWith("/") || posix.normalize(path) !== path) ||
      paths.some((path, i) => paths.some((other, j) => i !== j && (path === other || path.startsWith(`${other}/`))))) throw new Error("invalid tenant roots");
  return Object.freeze({ ...value });
}
export class TenantRunner {
  #active = new Set();
  constructor({ manifest, token, files = new FileRpc(), timeoutMs = 30000 } = {}) {
    this.manifest = validateManifest(manifest);
    if (!/^[a-f0-9]{64}$/.test(token ?? "") || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error("invalid tenant runner configuration");
    this.token = token; this.files = files; this.timeoutMs = timeoutMs;
    this.server = createServer((req, res) => { void this.#handle(req, res); });
    this.server.maxHeadersCount = 24; this.server.headersTimeout = 5000; this.server.requestTimeout = 10000;
    this.server.on("clientError", (_error, socket) => socket.destroy());
    this.server.on("connect", (_req, socket) => socket.destroy()); this.server.on("upgrade", (_req, socket) => socket.destroy());
  }
  async listen({ host, port = 4791 }) {
    if (!/^(?:127\.0\.0\.1|172\.31\.240\.(?:[2-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-4]))$/.test(host ?? "")) throw new Error("invalid tenant bind address");
    await new Promise((done, reject) => {
      const error = (reason) => { this.server.off("listening", ready); reject(reason); };
      const ready = () => { this.server.off("error", error); done(); };
      this.server.once("error", error); this.server.once("listening", ready); this.server.listen(port, host);
    }); return this.server.address();
  }
  async close() {
    for (const controller of this.#active) controller.abort();
    this.server.closeAllConnections(); if (this.server.listening) await new Promise((done) => this.server.close(done));
  }
  async #handle(req, res) {
    const send = (status, body) => {
      if (res.destroyed) return;
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", connection: "close" }); res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && req.url === "/health") { send(200, { ready: true }); return; }
    const credential = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization ?? "")?.[1];
    if (!credential || !timingSafeEqual(Buffer.from(credential), Buffer.from(this.token))) { send(403, { error: "runner_denied" }); return; }
    if (req.method !== "POST" || req.url !== "/files") { send(404, { error: "runner_route_unavailable" }); return; }
    if (this.#active.size) { send(429, { error: "runner_busy" }); return; }
    const controller = new AbortController(); this.#active.add(controller);
    const cancel = () => controller.abort();
    const timeout = setTimeout(() => { send(504, { error: "runner_timeout" }); controller.abort(); req.destroy(); }, this.timeoutMs);
    req.once("aborted", cancel); res.once("close", cancel);
    try {
      if (req.headers["content-type"] !== "application/json" || req.headers["content-encoding"]) throw new Error("invalid runner payload");
      let bytes = 0; const chunks = [];
      for await (const chunk of req) {
        bytes += chunk.length; if (bytes > 4 * 1024 ** 2 || controller.signal.aborted) throw new Error("runner body limit"); chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (body.instanceId !== this.manifest.instanceId || body.generation !== this.manifest.generation) throw new Error("foreign runner context");
      const { instanceId: _instanceId, generation: _generation, ...operation } = body;
      const result = await this.files.call(fileRequest(operation), { signal: controller.signal });
      if (!controller.signal.aborted) send(200, result);
    } catch { if (!controller.signal.aborted) send(403, { error: "runner_operation_denied" }); }
    finally { clearTimeout(timeout); req.off("aborted", cancel); res.off("close", cancel); this.#active.delete(controller); }
  }
}
async function trustedJson(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.uid !== 0 || (metadata.mode & 0o022) || metadata.size > 65536) throw new Error("untrusted runner configuration");
  return JSON.parse(await readFile(path, "utf8"));
}
async function startTenant() {
  const manifest = validateManifest(await trustedJson("/opt/scikeel/tenant.json"));
  const auth = await trustedJson("/opt/scikeel/runner-auth.json");
  if (auth.schema !== 1 || !/^[a-f0-9]{64}$/.test(auth.token ?? "")) throw new Error("invalid runner identity");
  const address = process.env.SCIKEEL_BIND_ADDRESS;
  const env = buildJobEnvironment({ privateHome: manifest.home, projectDir: manifest.workspaceDir,
    environment: { kind: "base", python: "/opt/scikeel/science/bin/python" } });
  for (const path of [manifest.workspaceDir, manifest.stateDir, `${manifest.stateDir}/runtime`]) await mkdir(path, { recursive: true, mode: 0o700 });
  await writeFile(`${manifest.stateDir}/runtime/base-workspace.txt`, manifest.workspaceDir, { mode: 0o600 });
  const child = spawn("/opt/scikeel/tools/bin/osd", ["server", "--managed", "--bind-address", address,
    "--port", "4790", "--workspace", manifest.workspaceDir, "--state-dir", manifest.stateDir,
    "--resources", "/opt/scikeel/tools/resources", "--token", auth.token], {
    cwd: manifest.workspaceDir, env: { ...env, OSD_STATE_DIR: manifest.stateDir }, detached: true, stdio: ["ignore", "ignore", "ignore"],
  });
  const runner = new TenantRunner({ manifest, token: auth.token });
  let stopping;
  const stop = () => stopping ??= (async () => {
    await runner.close(); if (child.pid) { try { process.kill(-child.pid, "SIGTERM"); } catch {} }
    const deadline = setTimeout(() => { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} } }, 3000);
    deadline.unref();
  })();
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void stop(); });
  child.once("error", () => { process.exitCode = 1; void stop(); });
  child.once("exit", () => { if (!stopping) process.exitCode = 1; void stop(); });
  try {
    const deadline = Date.now() + 20000; let ready = false;
    while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
      try {
        const response = await fetch(`http://${address}:4790/v1/health`, { headers: { authorization: `Bearer ${auth.token}` }, signal: AbortSignal.timeout(500) });
        if (response.ok) { ready = true; break; }
      } catch {}
      await new Promise((done) => setTimeout(done, 100));
    }
    if (!ready) throw new Error("managed gateway unavailable");
    await runner.listen({ host: address });
  } catch (error) { await stop(); throw error; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await startTenant(); }
  catch { console.error("Managed tenant runner unavailable"); process.exitCode = 1; }
}
