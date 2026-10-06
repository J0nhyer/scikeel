import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFile, lstat, mkdir, writeFile, rename } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { FileRpc, fileRequest, EnvironmentRpc, environmentRequest } from "./file-rpc.mjs";
import { buildJobEnvironment, CliJobs, jobRequest } from "./cli-jobs.mjs";

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
  #active = new Set(); #operations = new Set();
  constructor({ manifest, token, files = new FileRpc(), environments = new EnvironmentRpc(), configureProfile, healthy=()=>true, jobsFactory=options=>new CliJobs(options), timeoutMs = 30000 } = {}) {
    this.manifest = validateManifest(manifest);
    if (!/^[a-f0-9]{64}$/.test(token ?? "") || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error("invalid tenant runner configuration");
    this.token = token; this.files = files; this.environments = environments; this.configureProfile = configureProfile; this.healthy=healthy; this.jobsFactory = jobsFactory; this.timeoutMs = timeoutMs;
    this.server = createServer((req, res) => { void this.#handle(req, res); });
    this.server.maxHeadersCount = 24; this.server.headersTimeout = 5000; this.server.requestTimeout = 10000;
    this.server.on("clientError", (_error, socket) => socket.destroy());
    this.server.on("connect", (_req, socket) => socket.destroy()); this.server.on("upgrade", (_req, socket) => socket.destroy());
  }
  async listen({ host, port = 4791 }) {
    if (!/^(?:127\.0\.0\.[12]|172\.31\.240\.(?:[2-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-4]))$/.test(host ?? "")) throw new Error("invalid tenant bind address");
    await new Promise((done, reject) => {
      const error = (reason) => { this.server.off("listening", ready); reject(reason); };
      const ready = () => { this.server.off("error", error); done(); };
      this.server.once("error", error); this.server.once("listening", ready); this.server.listen(port, host);
    }); return this.server.address();
  }
  async close() {
    for (const controller of this.#active) controller.abort();
    await this.jobs?.close();
    this.server.closeAllConnections(); if (this.server.listening) await new Promise((done) => this.server.close(done));
  }
  async #handle(req, res) {
    const send = (status, body) => {
      if (res.destroyed) return;
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", connection: "close" }); res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && req.url === "/health") { const ready=this.healthy();send(ready ? 200 : 503, {ready});return; }
    const credential = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization ?? "")?.[1];
    if (!credential || !timingSafeEqual(Buffer.from(credential), Buffer.from(this.token))) { send(403, { error: "runner_denied" }); return; }
    if (req.method !== "POST" || !["/files", "/profile", "/environments", "/jobs"].includes(req.url)) { send(404, { error: "runner_route_unavailable" }); return; }
    if (this.#operations.has(req.url) || this.#operations.has("/profile") || (req.url === "/profile" && this.#active.size)) { send(429, { error: "runner_busy" }); return; }
    const controller = new AbortController(); this.#active.add(controller); this.#operations.add(req.url);
    const cancel = () => controller.abort();
    const timeout = setTimeout(() => { send(504, { error: "runner_timeout" }); controller.abort(); req.destroy(); }, req.url === "/environments" ? 300000 : this.timeoutMs);
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
      let result;
      if (req.url === "/profile") {
        if (Object.keys(operation).some(key=>!["profile","imageDigest"].includes(key)) || !this.configureProfile || this.jobs?.busy) throw new Error("profile unavailable");
        const profile=validateProfile(operation.profile);
        if(operation.imageDigest!==undefined && !/^sha256:[a-f0-9]{64}$/.test(operation.imageDigest))throw new Error("invalid immutable job image");
        await this.configureProfile(profile, { signal: controller.signal, imageDigest:operation.imageDigest });
        await this.jobs?.close();this.jobs=undefined;
        if(operation.imageDigest) {
          this.jobs=this.jobsFactory({manifest:this.manifest,environments:this.environments,imageDigest:operation.imageDigest});
          this.jobs.configure(profile);
        }
        result = { configured: true };
      } else if(req.url==="/jobs") {
        if(!this.jobs || !this.healthy())throw new Error("managed jobs unavailable");
        result=await this.jobs.call(jobRequest(operation),{signal:controller.signal});
      } else if(req.url==="/environments") {
        const value=environmentRequest(operation);
        if(value.operation!=="inspect" && this.jobs?.busy)throw new Error("managed environment busy");
        result=await this.environments.call(value,{signal:controller.signal});
      }
      else result = await this.files.call(fileRequest(operation), { signal: controller.signal });
      if (!controller.signal.aborted) send(200, result);
    } catch { if (!controller.signal.aborted) send(403, { error: "runner_operation_denied" }); }
    finally { clearTimeout(timeout); req.off("aborted", cancel); res.off("close", cancel); this.#active.delete(controller); this.#operations.delete(req.url); }
  }
}
function validateProfile(value) {
  if (!value || Object.keys(value).sort().join(",") !== ["model", "enabled_providers", "provider", "permission"].sort().join(",") ||
      !Array.isArray(value.enabled_providers) || value.enabled_providers.length !== 1) throw new Error("invalid managed profile");
  const name = value.enabled_providers[0]; const provider = value.provider?.[name];
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(name) || Object.keys(value.provider).join(",") !== name || !provider ||
      Object.keys(provider).sort().join(",") !== ["npm", "name", "options", "models", "whitelist"].sort().join(",") || provider.name !== name ||
      !["@ai-sdk/openai-compatible", "@ai-sdk/anthropic"].includes(provider.npm) ||
      Object.keys(provider.options ?? {}).sort().join(",") !== "apiKey,baseURL" || provider.options.baseURL !== "http://172.31.240.1:4792/v1" ||
      !/^[a-f0-9]{64}$/.test(provider.options.apiKey ?? "") || !provider.models || Array.isArray(provider.models) ||
      Object.entries(provider.models).some(([model, entry]) => !model || model.length > 160 || /[\0\r\n]/.test(model) || Object.keys(entry).join(",") !== "name" || entry.name !== model) ||
      !Array.isArray(provider.whitelist) || provider.whitelist.length !== Object.keys(provider.models).length ||
      new Set(provider.whitelist).size !== provider.whitelist.length || !provider.whitelist.every(model => Object.hasOwn(provider.models, model)) ||
      !Object.hasOwn(provider.models, String(value.model).slice(name.length + 1)) || !String(value.model).startsWith(`${name}/`)) throw new Error("invalid managed provider");
  const permissions = { bash: "ask", edit: "ask", external_directory: "deny", webfetch: "ask", websearch: "ask" };
  if (!value.permission || Object.keys(value.permission).length !== Object.keys(permissions).length ||
      Object.entries(permissions).some(([key, mode]) => value.permission[key] !== mode)) throw new Error("invalid managed permission policy");
  return value;
}
async function trustedJson(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.uid !== 0 || (metadata.mode & 0o022) || metadata.size > 65536) throw new Error("untrusted runner configuration");
  return JSON.parse(await readFile(path, "utf8"));
}
export class TenantGateway {
  #child;
  constructor({ manifest, token, address, port = 4790, spawnImpl = spawn }) {
    this.manifest = validateManifest(manifest);
    if (!/^[a-f0-9]{64}$/.test(token ?? "") || !/^(?:127\.0\.0\.[12]|172\.31\.240\.\d{1,3})$/.test(address ?? "") ||
        !Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("invalid gateway identity");
    Object.assign(this, { token, address, port, spawnImpl });
  }
  get ready() {return !!this.#child && this.#child.exitCode===null && this.#child.signalCode===null;}
  async stop() {
    const child = this.#child; if (!child) return; this.#child = undefined;
    if (child.pid) { try { process.kill(-child.pid, "SIGTERM"); } catch {} }
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((done) => {
      const timer = setTimeout(() => { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} } }, 3000);
      child.once("close", () => { clearTimeout(timer); done(); });
    });
  }
  async start(profile, {imageDigest} = {}) {
    await this.stop();
    const manifest = this.manifest;
    const env = buildJobEnvironment({ privateHome: manifest.home, projectDir: manifest.workspaceDir,
      environment: { kind: "base", python: "/opt/scikeel/science/bin/python" } });
    const config = `${manifest.stateDir}/runtime/xdg-config/opencode`;
    await mkdir(config, { recursive: true, mode: 0o700 });
    await writeFile(`${manifest.stateDir}/runtime/base-workspace.txt`, manifest.workspaceDir, { mode: 0o600 });
    try { await lstat(`${config}/opencode.jsonc`); throw new Error("legacy managed profile requires migration"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const temporary = `${config}/profile-${process.pid}-${Date.now()}.tmp`;
    // Skill resources live outside the workspace. Put the deny first because
    // OpenCode evaluates the last matching rule; retain manual writes/commands.
    const skills = "/opt/scikeel/tools/resources/skills-core";
    const configured = {
      ...profile,
      skills: { paths: [skills] },
      permission: { bash: "ask", edit: "ask", webfetch: "ask", websearch: "ask", ...profile?.permission,
        external_directory: { "*": "deny", [skills]: "allow", [`${skills}/*`]: "allow" } },
      ...(profile && imageDigest ? { plugin: [["file:///opt/scikeel/tools/science-environment.mjs", { imageDigest, collaborationToken:profile.provider?.[profile.enabled_providers?.[0]]?.options?.apiKey }]] } : {}),
    };
    await writeFile(temporary, JSON.stringify(configured), { flag: "wx", mode: 0o600 });
    await rename(temporary, `${config}/opencode.json`);
    const child = this.spawnImpl("/opt/scikeel/tools/bin/osd", ["server", "--managed", "--bind-address", this.address,
      "--port", String(this.port), "--workspace", manifest.workspaceDir, "--state-dir", manifest.stateDir,
      "--resources", "/opt/scikeel/tools/resources", "--token", this.token], {
      cwd: manifest.workspaceDir, env: { ...env, OSD_STATE_DIR: manifest.stateDir, SCIKEEL_SESSION_TITLE_POLICY: "conversation-v1" }, detached: true,
      stdio: ["ignore", "ignore", process.env.SCIKEEL_CI_DIAGNOSTICS === "1" ? "inherit" : "ignore"],
    });
    this.#child = child; let failed = false; child.once("error", () => failed = true);
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && !failed && child.exitCode === null && child.signalCode === null) {
      try {
        const response = await fetch(`http://${this.address}:${this.port}/v1/health`, { headers: { authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(500) });
        if (response.ok) return;
      } catch {}
      await new Promise((done) => setTimeout(done, 100));
    }
    await this.stop(); throw new Error("managed gateway unavailable");
  }
}
async function startTenant() {
  const manifest = validateManifest(await trustedJson("/opt/scikeel/tenant.json"));
  const auth = await trustedJson("/opt/scikeel/runner-auth.json");
  if (auth.schema !== 1 || !/^[a-f0-9]{64}$/.test(auth.token ?? "")) throw new Error("invalid runner identity");
  const address = process.env.SCIKEEL_BIND_ADDRESS;
  const gateway = new TenantGateway({ manifest, token: auth.token, address });
  const runner = new TenantRunner({ manifest, token: auth.token, configureProfile: (profile,options) => gateway.start(profile,options), healthy:()=>gateway.ready });
  let stopping;
  const stop = () => stopping ??= (async () => {
    await runner.close(); await gateway.stop();
  })();
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void stop(); });
  try {
    await gateway.start();
    await runner.listen({ host: address });
  } catch (error) { await stop(); throw error; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await startTenant(); }
  catch (error) {
    console.error("Managed tenant runner unavailable");
    if (process.env.SCIKEEL_CI_DIAGNOSTICS === "1") console.error(error.message);
    process.exitCode = 1;
  }
}
