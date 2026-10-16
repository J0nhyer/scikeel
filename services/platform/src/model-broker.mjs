import { isToolCallId, makeToolOutcome, readToolError, serializeToolError } from "../../../packages/sdk/src/tool-outcome.mjs";
import { createHash, randomBytes } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

const ROUTES = new Set(["/v1/responses", "/v1/chat/completions", "/v1/messages"]);
const validName = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const validModel = (value) => typeof value === "string" && value.length > 0 && value.length <= 160 && !/[\x00-\x20]/.test(value);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const DEFAULT_FIRST_BYTE_TIMEOUT_MS = 120_000;
const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 3_600_000;
const TIMEOUT_MESSAGES = {
  model_first_byte_timeout: "The model did not start responding within 2 minutes. Try again or choose another model.",
  model_idle_timeout: "The model response was interrupted after 2 minutes without data. Your existing work is preserved.",
  model_total_timeout: "This model request reached the 1-hour limit. Your existing work is preserved; continue in another turn.",
};
function timeoutError(code, timeoutMs, correlationId) {
  const defaultLabel = code === "model_total_timeout" ? "1-hour" : "2 minutes";
  const defaultDuration = code === "model_total_timeout" ? DEFAULT_TOTAL_TIMEOUT_MS : DEFAULT_IDLE_TIMEOUT_MS;
  const label = timeoutMs === defaultDuration ? defaultLabel : `${timeoutMs / 1000} seconds`;
  return Object.assign(failure(code, 504), {
    publicMessage: `[${code}] ${TIMEOUT_MESSAGES[code].replace(defaultLabel, label)}`, correlationId, timeoutMs,
  });
}
function terminalFrame(route, reason) {
  const error = { code: reason.code, message: reason.publicMessage, type: "api_error", param: null };
  if (route === "/v1/responses") return `event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: { error: { code: error.code, message: error.message } }, sequence_number: 0 })}\n\n`;
  if (route === "/v1/messages") return `event: error\ndata: ${JSON.stringify({ type: "error", error })}\n\n`;
  return `data: ${JSON.stringify({ error })}\n\n`;
}
async function endWithError(res, frame) {
  if (res.destroyed || res.writableEnded) return false;
  return new Promise(resolve => {
    let settled = false;
    const finish = delivered => {
      if (settled) return;
      settled = true; clearTimeout(timer); res.off("finish", onFinish); res.off("close", onClose); resolve(delivered);
    };
    const onFinish = () => finish(true);
    const onClose = () => finish(false);
    const timer = setTimeout(() => { res.destroy(); finish(false); }, 1000);
    res.once("finish", onFinish); res.once("close", onClose);
    res.end(frame);
  });
}
const failure = (code, status = 403) => Object.assign(new Error(code), { code, status });
function fixedProvider(name, provider, identityRevision = null) {
  let url;
  try { url = new URL(provider?.baseUrl); } catch { throw new Error("invalid fixed model provider"); }
  if (!validName(name) || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      !Array.isArray(provider.enabledModels) || !provider.enabledModels.length || !provider.enabledModels.every(validModel) ||
      !Array.isArray(provider.routes) || !provider.routes.length || !provider.routes.every(route => ROUTES.has(route)) ||
      typeof provider.credential !== "string" || !provider.credential || /[\r\n\0]/.test(provider.credential) ||
      ![undefined, "bearer", "x-api-key"].includes(provider.authMode)) throw new Error("invalid fixed model provider");
  return { url, credential: provider.credential, authMode: provider.authMode ?? "bearer", identityRevision,
    enabledModels: [...provider.enabledModels], routes: [...provider.routes], revoked: false };
}
function identity(context) {
  if (!context || !validName(context.userId) || !validName(context.instanceId) ||
      !Number.isSafeInteger(context.generation) || context.generation < 1) throw failure("model_identity_denied");
  return `${context.userId}:${context.instanceId}:${context.generation}`;
}
const turnFields=['userId','instanceId','generation','conversationId','execution','requestId','policyRevision','runtime'];
function turnScope(capability) {
  const turn=capability.turnIdentity;
  return turn&&typeof turn==='object'&&!Array.isArray(turn)&&Object.keys(turn).length===turnFields.length&&
    turnFields.every(field=>Object.hasOwn(turn,field))&&['userId','instanceId','conversationId','requestId'].every(field=>validName(turn[field]))&&
    ['generation','execution','policyRevision'].every(field=>Number.isSafeInteger(turn[field])&&turn[field]>0)&&
    ['opencode','codex','claude'].includes(turn.runtime)&&['userId','instanceId','generation','policyRevision','runtime']
      .every(field=>turn[field]===capability[field]);
}
export function authorizeModelRequest({ capability, request, policy, now }) {
  if (!capability || !request || !policy || !Number.isSafeInteger(now) ||
      capability.bridgeOnly === true || capability.inferenceRevoked === true ||
      identity(capability) !== identity(request) || capability.provider !== request.provider ||
      !validName(capability.provider) || !Number.isSafeInteger(capability.expiresAt) || now >= capability.expiresAt ||
      policy.revoked !== false || request.method !== "POST" || !ROUTES.has(request.path) ||
      !capability.routes?.includes(request.path) || !validModel(request.model) ||
      !capability.models?.includes(request.model) || !policy.enabledModels?.includes(request.model) ||
      (policy.identityRevision != null && capability.profileRevision !== policy.identityRevision) ||
      Object.hasOwn(request, "upstream")) throw failure("model_request_denied");
  return true;
}
function sendFailure(res, reason) {
  if (res.destroyed) return;
  if (res.headersSent) { res.destroy(); return; }
  const known = /^model_[a-z_]+$/.test(reason?.code ?? "") && Number.isInteger(reason.status);
  const code = known ? reason.code : "model_upstream_unavailable";
  res.writeHead(known ? reason.status : 502, { "content-type": "application/json", "cache-control": "no-store", connection: "close", ...(reason?.correlationId ? { "x-scikeel-correlation-id": reason.correlationId } : {}) });
  res.end(JSON.stringify(reason?.publicMessage
    ? { error: { code, message: reason.publicMessage, type: "api_error" } }
    : { error: code }));
}
function wait(operation, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(operation).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
export class ModelBroker {
  #providers = new Map(); #grants = new Map(); #operations = new Set(); #expiredRequests = new Map();
  #assistantPolicy; #executionAuthority; #revokedAssistantRevisions = new Map();
  constructor({ providers, identify, now = Date.now, timeoutMs, firstByteTimeoutMs, idleTimeoutMs, totalTimeoutMs,
    maxBodyBytes = 2 * 1024 ** 2, maxResponseBytes = 16 * 1024 ** 2, maxConnections = 4,
    maxOutputTokens = 32768, maxGrants = 1024, assistantPolicy = null, executionAuthority = null, logger = event => console.log(JSON.stringify(event)) } = {}) {
    if (!providers || typeof identify !== "function" || typeof now !== "function" || typeof logger !== "function" ||
        assistantPolicy !== null && typeof assistantPolicy !== "function"||executionAuthority!==null&&typeof executionAuthority!=='function')
      throw new Error("invalid model broker configuration");
    this.#assistantPolicy = assistantPolicy;
    this.#executionAuthority=executionAuthority;
    const legacyTimeout = timeoutMs;
    firstByteTimeoutMs ??= legacyTimeout ?? DEFAULT_FIRST_BYTE_TIMEOUT_MS;
    idleTimeoutMs ??= legacyTimeout ?? DEFAULT_IDLE_TIMEOUT_MS;
    totalTimeoutMs ??= legacyTimeout ?? DEFAULT_TOTAL_TIMEOUT_MS;
    for (const [name, value] of Object.entries({ firstByteTimeoutMs, idleTimeoutMs, totalTimeoutMs,
      maxBodyBytes, maxResponseBytes, maxConnections, maxOutputTokens, maxGrants }))
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`invalid model broker ${name}`);
    if (firstByteTimeoutMs > totalTimeoutMs || idleTimeoutMs > totalTimeoutMs || totalTimeoutMs > DEFAULT_TOTAL_TIMEOUT_MS ||
        maxBodyBytes > 16 * 1024 ** 2 || maxResponseBytes > 64 * 1024 ** 2 || maxConnections > 32 || maxGrants > 10000)
      throw new Error("model broker limits exceed host budget");
    for (const [name, provider] of Object.entries(providers)) {
      // Fixed administrator-owned routing. No tenant input reaches URL construction.
      this.#providers.set(name, fixedProvider(name, provider));
    }
    Object.assign(this, { identify, now, firstByteTimeoutMs, idleTimeoutMs, totalTimeoutMs, maxBodyBytes, maxResponseBytes, maxConnections,
      maxOutputTokens, maxGrants, logger });
    this.server = createServer((req, res) => { void this.#handle(req, res); });
    this.server.maxHeadersCount = 32; this.server.headersTimeout = 10000; this.server.requestTimeout = Math.min(firstByteTimeoutMs, 30000);
    this.server.on("clientError", (_error, socket) => socket.destroy());
    this.server.on("connect", (_req, socket) => socket.destroy());
    this.server.on("upgrade", (_req, socket) => socket.destroy());
  }
  #inferenceAllowed(capability) {
    if (capability.bridgeOnly === true || capability.inferenceRevoked === true) return false;
    if(!this.#executionAllowed(capability))return false;
    if (!this.#assistantPolicy) return true;
    try {
      const current = this.#assistantPolicy({ userId: capability.userId, instanceId: capability.instanceId,
        generation: capability.generation, runtime: capability.runtime, policyRevision: capability.policyRevision });
      return current?.recoveryRequired === false && ["opencode", "codex", "claude"].includes(capability.runtime) &&
        Number.isSafeInteger(capability.policyRevision) && capability.policyRevision > 0 &&
        capability.policyRevision > (this.#revokedAssistantRevisions.get(capability.runtime) ?? 0) &&
        current.activeRuntime === capability.runtime && current.revision === capability.policyRevision;
    } catch { return false; }
  }
  #executionAllowed(capability) {
    if(capability.runtime!=='codex'&&capability.turnIdentity===undefined)return true;
    if(!turnScope(capability)||!this.#executionAuthority)return false;
    try{return this.#executionAuthority(structuredClone(capability.turnIdentity))===true;}catch{return false;}
  }
  #requireInference(grantKey, operation) {
    const current = this.#grants.get(grantKey);
    if (!current || !this.#inferenceAllowed(current)) throw failure("model_request_denied");
    operation.inference = true;
  }
  async revokeAssistant({ runtime, policyRevision }) {
    if (!["opencode", "codex", "claude"].includes(runtime) || !Number.isSafeInteger(policyRevision) || policyRevision < 1)
      throw failure("model_grant_denied");
    this.#revokedAssistantRevisions.set(runtime, Math.max(policyRevision, this.#revokedAssistantRevisions.get(runtime) ?? 0));
    const revoked = new Set();
    for (const [key, grant] of this.#grants) if (grant.runtime === runtime && grant.policyRevision <= policyRevision) {
      this.#grants.set(key, Object.freeze({ ...grant, inferenceRevoked: true })); revoked.add(key);
    }
    const draining = [...this.#operations].filter(operation => operation.inference && revoked.has(operation.grantKey));
    await this.#drain(draining);
  }
  async #drain(draining) {
    for (const operation of draining) operation.controller.abort(failure("model_grant_revoked"));
    let timer;
    try {
      await Promise.race([Promise.all(draining.map(operation => operation.done)), new Promise((_, reject) => {
        timer = setTimeout(() => reject(failure("model_revocation_unverified", 503)), 5000);
      })]);
    } finally { clearTimeout(timer); }
  }
  inferenceInventory() {
    return [...this.#operations].filter(operation => operation.inference).map(operation => ({ ...operation.context }));
  }
  replaceProviderSnapshot({ name, expectedRevision, identityRevision, provider, createOnly = false }) {
    const current = this.#providers.get(name);
    if (!validName(identityRevision) || expectedRevision !== (current?.identityRevision ?? null) || createOnly && current)
      throw failure("model_profile_revision_conflict", 409);
    const next = fixedProvider(name, provider, identityRevision);
    if (identityRevision === current?.identityRevision && (!current.revoked ||
        JSON.stringify({ ...current, revoked: false }) !== JSON.stringify(next)))
      throw failure("model_profile_revision_conflict", 409);
    this.revokeProvider(name);
    this.#providers.set(name, next);
    return { identityRevision };
  }
  revokeProvider(name) {
    const current = this.#providers.get(name);
    if (current) current.revoked = true;
    const revoked = new Set();
    for (const [key, grant] of this.#grants) if (grant.provider === name) { this.#grants.delete(key); revoked.add(key); }
    for (const operation of this.#operations) if (revoked.has(operation.grantKey))
      operation.controller.abort(failure("model_grant_revoked"));
  }
  issue(capability) {
    identity(capability);
    if (capability.bridgeOnly !== undefined && typeof capability.bridgeOnly !== "boolean" ||
        capability.bridgeOnly !== true && !this.#inferenceAllowed(capability)) throw failure("model_grant_denied");
    const policy = this.#providers.get(capability.provider);
    if (!policy || policy.revoked || (policy.identityRevision != null && capability.profileRevision !== policy.identityRevision) ||
        !Number.isSafeInteger(capability.expiresAt) || capability.expiresAt <= this.now() ||
        capability.expiresAt > this.now() + 900000 || !Array.isArray(capability.models) || !capability.models.length ||
        !capability.models.every((model) => policy.enabledModels.includes(model)) || !Array.isArray(capability.routes) ||
        !capability.routes.length || !capability.routes.every((route) => policy.routes.includes(route))) throw failure("model_grant_denied");
    for (const [key, grant] of this.#grants) if (grant.expiresAt <= this.now()) this.#grants.delete(key);
    if (this.#grants.size >= this.maxGrants) throw failure("model_grant_capacity", 429);
    const token = randomBytes(32).toString("hex");
    this.#grants.set(hash(token), Object.freeze({ userId: capability.userId, instanceId: capability.instanceId,
      generation: capability.generation, provider: capability.provider, expiresAt: capability.expiresAt,
      ...(capability.runtime !== undefined ? { runtime: capability.runtime } : {}),
      ...(capability.policyRevision !== undefined ? { policyRevision: capability.policyRevision } : {}),
      ...(capability.bridgeOnly === true ? { bridgeOnly: true } : {}),
      ...(capability.turnIdentity!==undefined?{turnIdentity:Object.freeze(structuredClone(capability.turnIdentity))}:{}),
      ...(policy.identityRevision != null ? { profileRevision: policy.identityRevision } : {}),
      models: Object.freeze([...capability.models]), routes: Object.freeze([...capability.routes]) }));
    return token;
  }
  revoke(token) {
    if (typeof token !== "string") return;
    const key = hash(token); this.#grants.delete(key);
    for (const operation of this.#operations) if (operation.grantKey === key) operation.controller.abort(failure("model_grant_revoked"));
  }
  async revokeAndDrain(token) {
    if(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token))throw failure('model_grant_denied');
    const key=hash(token),draining=[...this.#operations].filter(operation=>operation.grantKey===key);
    this.revoke(token);await this.#drain(draining);
  }
  renew(token, context) {
    identity(context);
    if (typeof token !== "string") throw failure("model_grant_denied");
    const key = hash(token); const grant = this.#grants.get(key);
    const policy = grant && this.#providers.get(grant.provider);
    if (!grant || identity(grant) !== identity(context) || grant.expiresAt <= this.now() || !policy || policy.revoked ||
        (policy.identityRevision != null && grant.profileRevision !== policy.identityRevision) ||
        grant.models.some((model) => !policy.enabledModels.includes(model))||!this.#executionAllowed(grant)) throw failure("model_grant_denied");
    const expiresAt = this.now() + 900000;
    this.#grants.set(key, Object.freeze({ ...grant, expiresAt }));
    for (const operation of this.#operations) if (operation.grantKey === key) operation.armExpiry?.(expiresAt);
    return expiresAt;
  }
  revokeContext(context) {
    const key = identity(context);
    for (const [grantKey, grant] of this.#grants) if (identity(grant) === key) {
      this.#grants.delete(grantKey);
      for (const operation of this.#operations) if (operation.grantKey === grantKey) operation.controller.abort(failure("model_grant_revoked"));
    }
  }
  setEnabledModels(provider, models) {
    const policy = this.#providers.get(provider);
    if (!policy || !Array.isArray(models) || !models.every(validModel)) throw new Error("invalid model policy");
    policy.enabledModels = [...models];
    for (const operation of this.#operations) if (operation.provider === provider && !models.includes(operation.model))
      operation.controller.abort(failure("model_request_denied"));
  }
  async listen({ host = "172.31.240.1", port = 4792 } = {}) {
    await new Promise((resolve, reject) => {
      const error = (reason) => { this.server.off("listening", ready); reject(reason); };
      const ready = () => { this.server.off("error", error); resolve(); };
      this.server.once("error", error); this.server.once("listening", ready); this.server.listen(port, host);
    });
    return this.server.address();
  }
  async close() {
    this.#grants.clear(); this.#expiredRequests.clear();
    for (const operation of this.#operations) operation.controller.abort(failure("model_broker_stopped", 503));
    this.server.closeAllConnections();
    if (this.server.listening) await new Promise((resolve) => this.server.close(resolve));
  }
  async #handle(req, res) {
    const startedAt = performance.now(); const correlationId = randomBytes(16).toString("hex");
    let finished;
    const controller = new AbortController(); const operation = { controller, done: new Promise(resolve => { finished = resolve; }) };
    let collaborationCorrelation; let networkCorrelation; let context;
    let modelRequest = false; let streaming = false; let eventBoundary = true; let trailing = Buffer.alloc(0);
    let responseBytes = 0; let forwardedBytes = 0; let firstDataAt; let lastDataAt;
    let upstreamStatus = null;
    let outcome = "success"; let terminalErrorDelivered = false; let downstreamBlocked = false;
    let firstByteTimer = null; let idleTimer = null; let totalTimer = null; let requestFingerprint;
    const lifecycleTimer = setTimeout(() => controller.abort(failure("model_timeout", 504)), Math.min(this.firstByteTimeoutMs, 120000));
    const expire = (code, duration) => {
      if (performance.now() - startedAt >= this.totalTimeoutMs) { code = "model_total_timeout"; duration = this.totalTimeoutMs; }
      controller.abort(timeoutError(code, duration, correlationId));
    };
    const clearModelTimers = () => {
      clearTimeout(firstByteTimer); clearTimeout(idleTimer); clearTimeout(totalTimer);
      firstByteTimer = null; idleTimer = null; totalTimer = null;
    };
    const armIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => expire("model_idle_timeout", this.idleTimeoutMs), this.idleTimeoutMs);
    };
    const aborted = () => { if (!res.writableFinished) controller.abort(failure("model_client_cancelled", 499)); };
    const stopRead = () => {
      if (!req.complete) {
        res.once("finish", () => req.destroy());
        sendFailure(res, controller.signal.reason);
        if (res.destroyed) req.destroy();
      }
    };
    controller.signal.addEventListener("abort", stopRead, { once: true });
    req.once("aborted", aborted); res.once("close", aborted); this.#operations.add(operation);
    try {
      if (this.#operations.size > this.maxConnections) throw failure("model_capacity", 429);
      if (req.method !== "POST" || !(ROUTES.has(req.url) || req.url === "/native/effect" && this.nativeEffectHandler || req.url === "/collaboration" && this.collaborationHandler || req.url === "/network" && this.networkHandler) || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers["content-type"] ?? "") ||
          req.headers["content-encoding"] || req.headers.expect) throw failure("model_request_denied");
      const bearer = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization ?? "")?.[1];
      const apiKey = /^[a-f0-9]{64}$/.test(req.headers["x-api-key"] ?? "") ? req.headers["x-api-key"] : undefined;
      if (bearer && apiKey && bearer !== apiKey) throw failure("model_grant_denied");
      const token = bearer ?? apiKey;
      if (!token) throw failure("model_grant_denied");
      const grantKey = hash(token); const capability = this.#grants.get(grantKey);
      if (!capability) throw failure("model_grant_denied");
      operation.grantKey = grantKey;
      context = await wait(() => this.identify(req), controller.signal);
      if (identity(context) !== identity(capability) || capability.expiresAt <= this.now()) throw failure("model_grant_denied");
      operation.context = { ...context, runtime: capability.runtime, policyRevision: capability.policyRevision,
        ...(capability.turnIdentity?{turnIdentity:structuredClone(capability.turnIdentity)}:{}) };
      operation.armExpiry = expiresAt => {
        clearTimeout(operation.expiration);
        operation.expiration = setTimeout(() => controller.abort(failure("model_grant_expired")), Math.max(1, expiresAt - this.now()));
      };
      operation.armExpiry(capability.expiresAt);
      controller.signal.addEventListener("abort", () => clearTimeout(operation.expiration), { once: true });
      let bytes = 0; const chunks = [];
      for await (const chunk of req) {
        if (controller.signal.aborted) throw controller.signal.reason;
        bytes += chunk.length; if (bytes > this.maxBodyBytes) throw failure("model_body_limit", 413); chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw failure("model_invalid_json", 400); }
      if (!body || typeof body !== "object" || Array.isArray(body)) throw failure("model_request_denied");
      // Native effects require the input-bound tool transport, never legacy bridge writes.
      if(capability.runtime==='codex'&&(req.url==='/network'||req.url==='/collaboration'&&!['state','guard'].includes(body.action)))
        throw failure('model_request_denied');
      if(req.url==='/native/effect'){
        if(bytes>512*1024||capability.runtime!=='codex'||!turnScope(capability))throw failure('model_request_denied');
        this.#requireInference(grantKey,operation);
        const work=Promise.resolve().then(()=>{
          controller.signal.throwIfAborted();this.#requireInference(grantKey,operation);
          return this.nativeEffectHandler(structuredClone(operation.context),body,{signal:controller.signal});
        });
        operation.effect=work;
        const result=await wait(()=>work,controller.signal);
        controller.signal.throwIfAborted();this.#requireInference(grantKey,operation);
        res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});
        res.end(JSON.stringify(result));return;
      }
      if (req.url === "/network") {
        if (bytes > 8192 || body.version !== 1 || !["authorize", "complete", "cancel"].includes(body.action) ||
            Object.keys(body).some(key => !["version", "action", "sessionId", "callId", "execution", "tool", "origins", "operationId", "outcome"].includes(key))) throw failure("model_request_denied");
        if (body.callId !== undefined && !isToolCallId(body.callId)) throw failure("model_request_denied");
        if (body.action === "authorize" && (!validName(body.sessionId) || !isToolCallId(body.callId) || !Number.isSafeInteger(body.execution) || body.execution < 1 ||
            !["webfetch", "websearch"].includes(body.tool) || !Array.isArray(body.origins) || body.origins.length !== 1 || typeof body.origins[0] !== "string" || body.origins[0].length > 2048)) throw failure("model_request_denied");
        if ((body.action !== "authorize" || body.operationId !== undefined) && !validName(body.operationId)) throw failure("model_request_denied");
        networkCorrelation = body.callId ?? `network_${randomBytes(16).toString("hex")}`;
        if (body.action === "authorize") this.#requireInference(grantKey, operation);
        const work = Promise.resolve().then(() => {
          controller.signal.throwIfAborted();
          if (operation.inference) this.#requireInference(grantKey, operation);
          return this.networkHandler(context, body);
        });
        if (operation.inference) operation.effect = work;
        const result = await wait(() => work, controller.signal);
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(result)); return;
      }
      if (req.url === "/collaboration") {
        if (bytes > 16384 || !["guard", "state", "checkpoint", "capability", "delivery"].includes(body.action) ||
            !validName(body.sessionId) || (body.callId !== undefined && !isToolCallId(body.callId)) || Object.keys(body).some(key => !["action", "sessionId", "kind", "question", "suggestedAnswer", "execution", "operation", "inputs", "deliverables", "callId"].includes(key)))
          throw failure("model_request_denied");
        collaborationCorrelation = body.callId ?? `collab_${randomBytes(16).toString("hex")}`;
        if (["checkpoint", "delivery"].includes(body.action)) this.#requireInference(grantKey, operation);
        const work = Promise.resolve().then(() => {
          controller.signal.throwIfAborted();
          if (operation.inference) this.#requireInference(grantKey, operation);
          return this.collaborationHandler(context, body);
        });
        if (operation.inference) operation.effect = work;
        const result = await wait(() => work, controller.signal);
        res.writeHead(200, {"content-type":"application/json", "cache-control":"no-store"});
        res.end(JSON.stringify(result)); return;
      }
      const provider = this.#providers.get(capability.provider);
      this.#requireInference(grantKey, operation);
      authorizeModelRequest({ capability, policy: provider, now: this.now(), request: {
        ...context, provider: capability.provider, method: req.method, path: req.url, model: body.model,
        ...(Object.hasOwn(body, "upstream") ? { upstream: body.upstream } : {}) } });
      if (["base_url", "baseUrl", "url", "endpoint", "provider"].some((key) => Object.hasOwn(body, key))) throw failure("model_request_denied");
      for (const key of ["authorization", "api_key", "apiKey", "credential", "credentials", "token"]) delete body[key];
      if (body.stream !== undefined && typeof body.stream !== "boolean") throw failure("model_request_denied");
      if (["n", "best_of"].some((key) => Object.hasOwn(body, key) && body[key] !== 1)) throw failure("model_token_limit");
      const tokenField = req.url === "/v1/responses" ? "max_output_tokens" : req.url === "/v1/messages" ? "max_tokens" :
        Object.hasOwn(body, "max_completion_tokens") ? "max_completion_tokens" : "max_tokens";
      const reserved = body[tokenField] ?? Math.min(4096, this.maxOutputTokens);
      if (!Number.isSafeInteger(reserved) || reserved < 1 || reserved > this.maxOutputTokens ||
          ["max_tokens", "max_completion_tokens", "max_output_tokens"].some((key) => key !== tokenField && Object.hasOwn(body, key)))
        throw failure("model_token_limit");
      body[tokenField] = reserved;
      clearTimeout(lifecycleTimer);
      modelRequest = true; streaming = body.stream === true;
      totalTimer = setTimeout(() => expire("model_total_timeout", this.totalTimeoutMs), Math.max(1, this.totalTimeoutMs - (performance.now() - startedAt)));
      // Only active operations are bounded; completed calls consume no account allowance.
      operation.provider = capability.provider; operation.model = body.model;
      if (controller.signal.aborted || !this.#grants.has(grantKey)) throw controller.signal.reason ?? failure("model_grant_revoked");
      const url = new URL(provider.url); const prefix = url.pathname.replace(/\/$/, "");
      url.pathname = `${prefix}${prefix.endsWith("/v1") ? req.url.slice(3) : req.url}`;
      const payload = JSON.stringify(body);
      const sessionHeader = req.headers["x-opencode-session"] ?? req.headers["x-session-id"];
      const requestHeader = req.headers["x-opencode-request"];
      const continuation = [sessionHeader, requestHeader].map(value => validName(value) ? value : "").join(":");
      requestFingerprint = hash(`${grantKey}:${req.url}:${continuation}:${payload}`);
      for (const [key, entry] of this.#expiredRequests) if (entry.until <= performance.now()) this.#expiredRequests.delete(key);
      const expired = this.#expiredRequests.get(requestFingerprint);
      // Some pinned protocol parsers retry a terminal SSE error as HTTP 5xx.
      // Refuse only that identical expired continuation before upstream contact;
      // a new user turn changes the body. This is not a cumulative usage quota.
      if (expired) throw Object.assign(timeoutError("model_total_timeout", this.totalTimeoutMs, correlationId), { status: 400 });
      const headers = { "content-type": "application/json", "content-length": Buffer.byteLength(payload), accept: body.stream ? "text/event-stream" : "application/json" };
      if (provider.authMode === "x-api-key") headers["x-api-key"] = provider.credential;
      else headers.authorization = `Bearer ${provider.credential}`;
      if (req.url === "/v1/messages") headers["anthropic-version"] = "2023-06-01";
      // The actual OpenCode runtime supplies the free provider's attribution.
      // Keep only these bounded metadata headers, never tenant credentials.
      if (capability.provider === "opencode") {
        for (const name of ["user-agent", "x-opencode-project", "x-opencode-session", "x-opencode-request", "x-opencode-client"]) {
          const value = req.headers[name];
          if (typeof value === "string" && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value)) headers[name] = value;
        }
      }
      firstByteTimer = setTimeout(() => expire("model_first_byte_timeout", this.firstByteTimeoutMs), this.firstByteTimeoutMs);
      const upstreamRequest = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, { method: "POST", headers, signal: controller.signal, agent: false });
      const upstream = await new Promise((resolve, reject) => {
        upstreamRequest.once("response", resolve); upstreamRequest.once("error", reject); upstreamRequest.end(payload);
      });
      upstreamStatus=Number.isInteger(upstream.statusCode) && upstream.statusCode>=100 && upstream.statusCode<=599 ? upstream.statusCode : null;
      if (upstream.statusCode !== 200) { upstream.destroy(); throw failure("model_upstream_rejected", 502); }
      const contentType = upstream.headers["content-type"] ?? "";
      if (!(body.stream ? /^text\/event-stream(?:;|$)/i : /^application\/json(?:;|$)/i).test(contentType)) {
        upstream.destroy(); throw failure("model_upstream_protocol", 502);
      }
      let receivedFirstByte = false;
      const limiter = new Transform({ transform: (chunk, _encoding, callback) => {
        if (chunk.length > 0) {
          lastDataAt = performance.now();
          if (!receivedFirstByte) { receivedFirstByte = true; firstDataAt = lastDataAt; clearTimeout(firstByteTimer); firstByteTimer = null; }
          armIdleTimer();
        }
        responseBytes += chunk.length;
        callback(responseBytes > this.maxResponseBytes ? failure("model_byte_limit", 413) : null, chunk);
      } });
      // The pipeline owns the upstream and this bounded writer, not the HTTP
      // response: upstream cancellation must leave a chance to report a timeout.
      const writer = new Writable({ write: (chunk, _encoding, callback) => {
        if (res.destroyed) { callback(failure("model_client_cancelled", 499)); return; }
        if (!res.headersSent) res.writeHead(200, { "content-type": contentType, "cache-control": "no-store", "x-content-type-options": "nosniff" });
        forwardedBytes += chunk.length;
        if (streaming) {
          trailing = Buffer.concat([trailing, chunk.subarray(-4)]).subarray(-4);
          const tail = trailing.toString("latin1");
          eventBoundary = tail.endsWith("\n\n") || tail.endsWith("\r\n\r\n") || tail.endsWith("\r\r");
        }
        if (res.write(chunk)) { callback(); return; }
        downstreamBlocked = true;
        const drain = () => { cleanup(); downstreamBlocked = false; callback(); };
        const closed = () => { cleanup(); callback(failure("model_client_cancelled", 499)); };
        const cancel = () => { cleanup(); callback(controller.signal.reason); };
        const cleanup = () => { res.off("drain", drain); res.off("close", closed); controller.signal.removeEventListener("abort", cancel); };
        res.once("drain", drain); res.once("close", closed); controller.signal.addEventListener("abort", cancel, { once: true });
        if (controller.signal.aborted) cancel();
      } });
      await pipeline(upstream, limiter, writer, { signal: controller.signal });
      if (!res.headersSent) res.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
      res.end();
    } catch (reason) {
      const error = controller.signal.aborted ? controller.signal.reason : reason;
      outcome = /^model_[a-z_]+$/.test(error?.code ?? "") ? error.code : "model_upstream_unavailable";
      if (outcome === "model_total_timeout" && requestFingerprint && !this.#expiredRequests.has(requestFingerprint)) {
        // Bound ephemeral terminal identities by the existing grant ceiling.
        // No request text, token, or cumulative account counter is retained.
        if (this.#expiredRequests.size >= this.maxGrants) this.#expiredRequests.delete(this.#expiredRequests.keys().next().value);
        this.#expiredRequests.set(requestFingerprint, { until: performance.now() + DEFAULT_TOTAL_TIMEOUT_MS });
      }
      if (modelRequest && TIMEOUT_MESSAGES[error?.code] && res.headersSent && streaming && eventBoundary) {
        const frame = terminalFrame(req.url, error);
        if (forwardedBytes + Buffer.byteLength(frame) <= this.maxResponseBytes) terminalErrorDelivered = await endWithError(res, frame);
        else res.destroy();
        return;
      }
      const networkOutcome = networkCorrelation && readToolError(JSON.stringify({ error: error?.outcome }));
      if (networkOutcome && !res.headersSent && !res.destroyed) {
        res.writeHead(networkOutcome.status ?? 502, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(serializeToolError(networkOutcome)));
      } else if (collaborationCorrelation && ["delivery_missing_input", "delivery_mode_mismatch", "delivery_execution_paused"].includes(error?.code) && !res.headersSent && !res.destroyed) {
        try {
          const outcome = makeToolOutcome(error.code, { source: "collaboration", status: error.status, correlationId: collaborationCorrelation, details: error.details });
          res.writeHead(error.status, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify(serializeToolError(outcome)));
        } catch { sendFailure(res, error); }
      } else sendFailure(res, error);
    } finally {
      clearTimeout(lifecycleTimer); clearModelTimers(); clearTimeout(operation.expiration);
      // A cancelled HTTP wait is not evidence that its effectful handler stopped.
      if (operation.effect) await operation.effect.catch(() => {});
      req.off("aborted", aborted); res.off("close", aborted); this.#operations.delete(operation);
      controller.signal.removeEventListener("abort", stopRead);
      if (!controller.signal.aborted) controller.abort(failure("model_request_finished"));
      if (modelRequest) {
        const endedAt = performance.now();
        try { this.logger({ type: "model.operation", correlationId, userId: context?.userId, instanceId: context?.instanceId,
          generation: context?.generation, route: req.url, provider: operation.provider, model: operation.model, outcome, upstreamStatus,
          elapsedMs: Math.round(endedAt - startedAt), firstByteMs: firstDataAt === undefined ? null : Math.round(firstDataAt - startedAt),
          idleMs: lastDataAt === undefined ? null : Math.round(endedAt - lastDataAt), responseBytes, forwardedBytes,
          firstByteTimeoutMs: this.firstByteTimeoutMs, idleTimeoutMs: this.idleTimeoutMs, totalTimeoutMs: this.totalTimeoutMs,
          headersSent: res.headersSent, downstreamBlocked, terminalErrorDelivered }); } catch { /* Logging must not retain a slot. */ }
      }
      finished();
    }
  }
}
