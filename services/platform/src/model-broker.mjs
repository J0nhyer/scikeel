import { makeToolOutcome, readToolError, serializeToolError } from "../../../packages/sdk/src/tool-outcome.mjs";
import { createHash, randomBytes } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const ROUTES = new Set(["/v1/responses", "/v1/chat/completions", "/v1/messages"]);
const validName = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const validModel = (value) => typeof value === "string" && value.length > 0 && value.length <= 160 && !/[\x00-\x20]/.test(value);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const failure = (code, status = 403) => Object.assign(new Error(code), { code, status });
function identity(context) {
  if (!context || !validName(context.userId) || !validName(context.instanceId) ||
      !Number.isSafeInteger(context.generation) || context.generation < 1) throw failure("model_identity_denied");
  return `${context.userId}:${context.instanceId}:${context.generation}`;
}
export function authorizeModelRequest({ capability, request, policy, now }) {
  if (!capability || !request || !policy || !Number.isSafeInteger(now) ||
      identity(capability) !== identity(request) || capability.provider !== request.provider ||
      !validName(capability.provider) || !Number.isSafeInteger(capability.expiresAt) || now >= capability.expiresAt ||
      policy.revoked !== false || request.method !== "POST" || !ROUTES.has(request.path) ||
      !capability.routes?.includes(request.path) || !validModel(request.model) ||
      !capability.models?.includes(request.model) || !policy.enabledModels?.includes(request.model) ||
      Object.hasOwn(request, "upstream")) throw failure("model_request_denied");
  return true;
}
function sendFailure(res, reason) {
  if (res.destroyed) return;
  if (res.headersSent) { res.destroy(); return; }
  const known = /^model_[a-z_]+$/.test(reason?.code ?? "") && Number.isInteger(reason.status);
  res.writeHead(known ? reason.status : 502, { "content-type": "application/json", "cache-control": "no-store", connection: "close" });
  res.end(JSON.stringify({ error: known ? reason.code : "model_upstream_unavailable" }));
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
  #providers = new Map(); #grants = new Map(); #operations = new Set();
  constructor({ providers, identify, now = Date.now, timeoutMs = 120000, maxBodyBytes = 2 * 1024 ** 2,
    maxResponseBytes = 16 * 1024 ** 2, maxConnections = 4,
    maxOutputTokens = 32768, maxGrants = 1024 } = {}) {
    if (!providers || typeof identify !== "function" || typeof now !== "function") throw new Error("invalid model broker configuration");
    for (const [name, value] of Object.entries({ timeoutMs, maxBodyBytes, maxResponseBytes, maxConnections,
      maxOutputTokens, maxGrants }))
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`invalid model broker ${name}`);
    if (timeoutMs > 1200000 || maxBodyBytes > 16 * 1024 ** 2 || maxResponseBytes > 64 * 1024 ** 2 || maxConnections > 32 || maxGrants > 10000)
      throw new Error("model broker limits exceed host budget");
    for (const [name, provider] of Object.entries(providers)) {
      const url = new URL(provider.baseUrl);
      if (!validName(name) || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
          !Array.isArray(provider.enabledModels) || !provider.enabledModels.length || !provider.enabledModels.every(validModel) ||
          !Array.isArray(provider.routes) || !provider.routes.length || !provider.routes.every((route) => ROUTES.has(route)) ||
          typeof provider.credential !== "string" || !provider.credential || /[\r\n\0]/.test(provider.credential) ||
          ![undefined, "bearer", "x-api-key"].includes(provider.authMode)) throw new Error("invalid fixed model provider");
      // Fixed administrator-owned routing. No tenant input reaches URL construction.
      this.#providers.set(name, { url, credential: provider.credential, authMode: provider.authMode ?? "bearer",
        enabledModels: [...provider.enabledModels], routes: [...provider.routes], revoked: false });
    }
    Object.assign(this, { identify, now, timeoutMs, maxBodyBytes, maxResponseBytes, maxConnections,
      maxOutputTokens, maxGrants });
    this.server = createServer((req, res) => { void this.#handle(req, res); });
    this.server.maxHeadersCount = 32; this.server.headersTimeout = 10000; this.server.requestTimeout = Math.min(timeoutMs, 30000);
    this.server.on("clientError", (_error, socket) => socket.destroy());
    this.server.on("connect", (_req, socket) => socket.destroy());
    this.server.on("upgrade", (_req, socket) => socket.destroy());
  }
  issue(capability) {
    identity(capability);
    const policy = this.#providers.get(capability.provider);
    if (!policy || policy.revoked || !Number.isSafeInteger(capability.expiresAt) || capability.expiresAt <= this.now() ||
        capability.expiresAt > this.now() + 900000 || !Array.isArray(capability.models) || !capability.models.length ||
        !capability.models.every((model) => policy.enabledModels.includes(model)) || !Array.isArray(capability.routes) ||
        !capability.routes.length || !capability.routes.every((route) => policy.routes.includes(route))) throw failure("model_grant_denied");
    for (const [key, grant] of this.#grants) if (grant.expiresAt <= this.now()) this.#grants.delete(key);
    if (this.#grants.size >= this.maxGrants) throw failure("model_grant_capacity", 429);
    const token = randomBytes(32).toString("hex");
    this.#grants.set(hash(token), Object.freeze({ userId: capability.userId, instanceId: capability.instanceId,
      generation: capability.generation, provider: capability.provider, expiresAt: capability.expiresAt,
      models: Object.freeze([...capability.models]), routes: Object.freeze([...capability.routes]) }));
    return token;
  }
  revoke(token) {
    if (typeof token !== "string") return;
    const key = hash(token); this.#grants.delete(key);
    for (const operation of this.#operations) if (operation.grantKey === key) operation.controller.abort(failure("model_grant_revoked"));
  }
  renew(token, context) {
    identity(context);
    if (typeof token !== "string") throw failure("model_grant_denied");
    const key = hash(token); const grant = this.#grants.get(key);
    const policy = grant && this.#providers.get(grant.provider);
    if (!grant || identity(grant) !== identity(context) || grant.expiresAt <= this.now() || !policy || policy.revoked ||
        grant.models.some((model) => !policy.enabledModels.includes(model))) throw failure("model_grant_denied");
    const expiresAt = this.now() + 900000;
    this.#grants.set(key, Object.freeze({ ...grant, expiresAt }));
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
    this.#grants.clear();
    for (const operation of this.#operations) operation.controller.abort(failure("model_broker_stopped", 503));
    this.server.closeAllConnections();
    if (this.server.listening) await new Promise((resolve) => this.server.close(resolve));
  }
  async #handle(req, res) {
    const controller = new AbortController(); const operation = { controller };
    let collaborationCorrelation; let networkCorrelation;
    const timer = setTimeout(() => controller.abort(failure("model_timeout", 504)), this.timeoutMs);
    const aborted = () => controller.abort(failure("model_client_cancelled", 499));
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
      if (req.method !== "POST" || !(ROUTES.has(req.url) || req.url === "/collaboration" && this.collaborationHandler || req.url === "/network" && this.networkHandler) || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers["content-type"] ?? "") ||
          req.headers["content-encoding"] || req.headers.expect) throw failure("model_request_denied");
      const bearer = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization ?? "")?.[1];
      const apiKey = /^[a-f0-9]{64}$/.test(req.headers["x-api-key"] ?? "") ? req.headers["x-api-key"] : undefined;
      if (bearer && apiKey && bearer !== apiKey) throw failure("model_grant_denied");
      const token = bearer ?? apiKey;
      if (!token) throw failure("model_grant_denied");
      const grantKey = hash(token); const capability = this.#grants.get(grantKey);
      if (!capability) throw failure("model_grant_denied");
      operation.grantKey = grantKey;
      const context = await wait(() => this.identify(req), controller.signal);
      if (identity(context) !== identity(capability) || capability.expiresAt <= this.now()) throw failure("model_grant_denied");
      const expiration = setTimeout(() => controller.abort(failure("model_grant_expired")), Math.max(1, capability.expiresAt - this.now()));
      controller.signal.addEventListener("abort", () => clearTimeout(expiration), { once: true });
      operation.expiration = expiration;
      let bytes = 0; const chunks = [];
      for await (const chunk of req) {
        if (controller.signal.aborted) throw controller.signal.reason;
        bytes += chunk.length; if (bytes > this.maxBodyBytes) throw failure("model_body_limit", 413); chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw failure("model_invalid_json", 400); }
      if (!body || typeof body !== "object" || Array.isArray(body)) throw failure("model_request_denied");
      if (req.url === "/network") {
        if (bytes > 8192 || body.version !== 1 || !["authorize", "complete", "cancel"].includes(body.action) ||
            Object.keys(body).some(key => !["version", "action", "sessionId", "callId", "execution", "tool", "origins", "operationId", "outcome"].includes(key))) throw failure("model_request_denied");
        if (body.action === "authorize" && (!validName(body.sessionId) || !validName(body.callId) || !Number.isSafeInteger(body.execution) || body.execution < 1 ||
            !["webfetch", "websearch"].includes(body.tool) || !Array.isArray(body.origins) || body.origins.length !== 1 || typeof body.origins[0] !== "string" || body.origins[0].length > 2048)) throw failure("model_request_denied");
        if ((body.action !== "authorize" || body.operationId !== undefined) && !validName(body.operationId)) throw failure("model_request_denied");
        networkCorrelation = body.callId ?? `network_${randomBytes(16).toString("hex")}`;
        const result = await wait(() => this.networkHandler(context, body), controller.signal);
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(result)); return;
      }
      if (req.url === "/collaboration") {
        if (bytes > 16384 || !["guard", "state", "checkpoint", "capability", "delivery"].includes(body.action) ||
            !validName(body.sessionId) || (body.callId !== undefined && !validName(body.callId)) || Object.keys(body).some(key => !["action", "sessionId", "kind", "question", "suggestedAnswer", "execution", "operation", "inputs", "deliverables", "callId"].includes(key)))
          throw failure("model_request_denied");
        collaborationCorrelation = body.callId ?? `collab_${randomBytes(16).toString("hex")}`;
        const result = await wait(() => this.collaborationHandler(context, body), controller.signal);
        res.writeHead(200, {"content-type":"application/json", "cache-control":"no-store"});
        res.end(JSON.stringify(result)); return;
      }
      const provider = this.#providers.get(capability.provider);
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
      // Only active operations are bounded; completed calls consume no account allowance.
      operation.provider = capability.provider; operation.model = body.model;
      if (controller.signal.aborted || !this.#grants.has(grantKey)) throw controller.signal.reason ?? failure("model_grant_revoked");
      const url = new URL(provider.url); const prefix = url.pathname.replace(/\/$/, "");
      url.pathname = `${prefix}${prefix.endsWith("/v1") ? req.url.slice(3) : req.url}`;
      const payload = JSON.stringify(body);
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
      const upstreamRequest = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, { method: "POST", headers, signal: controller.signal, agent: false });
      const upstream = await new Promise((resolve, reject) => {
        upstreamRequest.once("response", resolve); upstreamRequest.once("error", reject); upstreamRequest.end(payload);
      });
      if (upstream.statusCode !== 200) { upstream.destroy(); throw failure("model_upstream_rejected", 502); }
      const contentType = upstream.headers["content-type"] ?? "";
      if (!(body.stream ? /^text\/event-stream(?:;|$)/i : /^application\/json(?:;|$)/i).test(contentType)) {
        upstream.destroy(); throw failure("model_upstream_protocol", 502);
      }
      res.writeHead(200, { "content-type": contentType, "cache-control": "no-store", "x-content-type-options": "nosniff" });
      let responseBytes = 0;
      const limiter = new Transform({ transform: (chunk, _encoding, callback) => {
        responseBytes += chunk.length;
        callback(responseBytes > this.maxResponseBytes ? failure("model_byte_limit", 413) : null, chunk);
      } });
      await pipeline(upstream, limiter, res, { signal: controller.signal });
    } catch (reason) {
      const error = controller.signal.aborted ? controller.signal.reason : reason;
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
      clearTimeout(timer); clearTimeout(operation.expiration);
      req.off("aborted", aborted); res.off("close", aborted); this.#operations.delete(operation);
      controller.signal.removeEventListener("abort", stopRead);
      if (!controller.signal.aborted) controller.abort(failure("model_request_finished"));
    }
  }
}
