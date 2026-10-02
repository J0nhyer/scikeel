import { request as httpRequest, createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { URL } from "node:url";
import { classifyRuntimeRoute, validateRuntimeInput, scrubRuntimeSecrets } from "./runtime-route-policy.mjs";

const SESSION_COOKIE = "osd_session";
const BOOTSTRAP_COOKIE = "osd_worker_bootstrap";
const DEFAULT_MAX_BODY_BYTES = 1 * 1024 * 1024;
const SPA_ROOTS = new Set(["live", "example", "skills", "notebooks", "files", "runs", "projects", "settings"]);
const STATIC_EXTENSIONS = new Set([
  "js",
  "mjs",
  "css",
  "map",
  "svg",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "ico",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "json",
  "wasm",
  "txt",
  "html",
]);

function webMime(path) {
  const extension = path.toLowerCase().split(".").at(-1);
  return {
    html: "text/html; charset=utf-8",
    js: "text/javascript; charset=utf-8",
    mjs: "text/javascript; charset=utf-8",
    css: "text/css; charset=utf-8",
    json: "application/json; charset=utf-8",
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    ico: "image/x-icon",
    woff: "font/woff",
    woff2: "font/woff2",
    ttf: "font/ttf",
    wasm: "application/wasm",
    txt: "text/plain; charset=utf-8",
  }[extension] ?? "application/octet-stream";
}

function safeWebRelative(root, path) {
  const candidate = resolve(root, path);
  const rel = relative(resolve(root), candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)) ? candidate : null;
}

function webRequestKind(pathname) {
  if (pathname === "/" || pathname === "/index.html") return "index";
  if (pathname.startsWith("/assets/")) return "asset";
  const extension = pathname.toLowerCase().split(".").at(-1);
  if (extension && STATIC_EXTENSIONS.has(extension)) return "asset";
  const first = pathname.replace(/^\/+/, "").split("/")[0];
  return SPA_ROOTS.has(first) ? "index" : null;
}

function jsonHeaders() {
  return {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };
}

function htmlHeaders() {
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };
}

function sendJson(response, status, body, extraHeaders = {}) {
  response.writeHead(status, { ...jsonHeaders(), ...extraHeaders });
  response.end(JSON.stringify(body));
}

function sendHtml(response, status, html, extraHeaders = {}) {
  response.writeHead(status, { ...htmlHeaders(), ...extraHeaders });
  response.end(html);
}

function redirect(response, location, extraHeaders = {}) {
  response.writeHead(303, {
    location,
    "cache-control": "no-store",
    ...extraHeaders,
  });
  response.end();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function parseCookies(header) {
  const cookies = new Map();
  if (typeof header !== "string") return cookies;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!key) continue;
    try {
      cookies.set(key, decodeURIComponent(value));
    } catch {
      cookies.set(key, value);
    }
  }
  return cookies;
}

function serializeCookie(name, value, {
  maxAge,
  httpOnly = true,
  sameSite = "Lax",
  secure = false,
  path = "/",
} = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, `SameSite=${sameSite}`];
  if (httpOnly) parts.push("HttpOnly");
  if (secure) parts.push("Secure");
  if (Number.isFinite(maxAge)) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
  return parts.join("; ");
}

function clearCookie(name, options) {
  return serializeCookie(name, "", { ...options, maxAge: 0 });
}

function sessionCookie(token, maxAge, secure) {
  return serializeCookie(SESSION_COOKIE, token, { maxAge, secure });
}

function bootstrapCookie(userId, secure) {
  return serializeCookie(BOOTSTRAP_COOKIE, userId, {
    maxAge: 365 * 24 * 60 * 60,
    secure,
  });
}

function workerIdForUser(userId) {
  return `user-${userId}`;
}

function workerBasicToken(token) {
  return Buffer.from(`opencode:${token}`).toString("base64");
}

function isJsonRequest(request) {
  const accept = request.headers.accept ?? "";
  const contentType = request.headers["content-type"] ?? "";
  return accept.includes("application/json") || contentType.includes("application/json");
}

async function readBody(request, maxBytes) {
  const claimed = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(claimed) && claimed > maxBytes) {
    const error = new Error("request body is too large");
    error.code = "body_too_large";
    throw error;
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    request.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        settled = true;
        const error = new Error("request body is too large");
        error.code = "body_too_large";
        reject(error);
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (!settled) resolve(Buffer.concat(chunks));
    });
    request.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    request.on("aborted", () => {
      if (!settled) {
        settled = true;
        reject(new Error("request aborted"));
      }
    });
  });
}

function parseBody(request, body) {
  if (body.length === 0) return {};
  const contentType = request.headers["content-type"] ?? "";
  if (contentType.includes("application/json")) {
    const parsed = JSON.parse(body.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("request body must be a JSON object");
    }
    return parsed;
  }
  const params = new URLSearchParams(body.toString("utf8"));
  return Object.fromEntries(params.entries());
}

function safeNextPath(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}

function booleanValue(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return !["0", "false", "no", "off"].includes(value.toLowerCase());
  return Boolean(value);
}

function loginPage(error = "", next = "/") {
  const errorMarkup = error
    ? `<p role="alert" style="color:#a33d2e;margin:0 0 16px">${escapeHtml(error)}</p>`
    : "";
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Open Science Desktop</title>
<style>body{margin:0;background:#f5f4f1;color:#252321;font:16px system-ui,sans-serif}main{box-sizing:border-box;width:min(100% - 32px,420px);margin:12vh auto;padding:32px;border:1px solid #d9d5cf;background:#fff;border-radius:8px;box-shadow:0 12px 40px #25232112}h1{margin:0 0 8px;font-size:22px}p{color:#6b6660;line-height:1.5}label{display:block;margin:16px 0 6px;font-size:14px}input{box-sizing:border-box;width:100%;height:42px;padding:0 12px;border:1px solid #c8c3bc;border-radius:6px;font:inherit}button{width:100%;height:42px;margin-top:22px;border:0;border-radius:6px;background:#2f5fa8;color:#fff;font:inherit;cursor:pointer}button:hover{background:#254f8f}</style>
</head><body><main><h1>Open Science Desktop</h1><p>Sign in to your research workspace.</p>${errorMarkup}<form method="post" action="/auth/login"><input type="hidden" name="next" value="${escapeHtml(next)}"><label for="username">Username</label><input id="username" name="username" autocomplete="username" required><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required><button type="submit">Sign in</button></form></main></body></html>`;
}

function upstreamRequestPath(requestUrl, workerToken) {
  const parsed = new URL(requestUrl ?? "/", "http://platform.invalid");
  parsed.searchParams.delete("token");
      parsed.searchParams.delete("auth_token");
  parsed.searchParams.delete("auth_token");
  if (parsed.pathname === "/event") {
    parsed.searchParams.set("auth_token", workerBasicToken(workerToken));
  }
  return `${parsed.pathname}${parsed.search}`;
}

function filterResponseHeaders(headers) {
  const filtered = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key === "set-cookie" || key === "connection" || key === "keep-alive") continue;
    filtered[key] = value;
  }
  return filtered;
}

/**
 * HTTP control plane for the internal multi-user deployment.
 *
 * The browser talks to this server only. It authenticates the platform
 * session, starts the user's isolated Open Science worker, and injects the
 * worker's private gateway credential into the loopback proxy request.
 */
export class PlatformServer {
  constructor({
    host = "127.0.0.1",
    port = 0,
    authStore,
    workerManager,
    cliRuntime = null,
    webRoot = null,
    secureCookies = false,
    maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
    logger = () => {},
    tenantPolicy = null,
    approvalGate = null,
    runtimeCatalog = null,
  } = {}) {
    if (!authStore) throw new Error("authStore is required");
    if (!workerManager) throw new Error("workerManager is required");
    this.host = host;
    this.port = port;
    this.authStore = authStore;
    this.workerManager = workerManager;
    this.cliRuntime = cliRuntime;
    this.webRoot = webRoot ? resolve(webRoot) : null;
    this.secureCookies = secureCookies;
    this.maxBodyBytes = maxBodyBytes;
    this.logger = logger;
    this.tenantPolicy = tenantPolicy;
    this.approvalGate = approvalGate;
    this.runtimeCatalog = runtimeCatalog;
    this.server = null;
    this.listenPromise = null;
  }

  async init() {
    await this.authStore.init();
    await this.workerManager.init();
    await this.cliRuntime?.init();
  }

  async listen() {
    if (this.server?.listening) return this.address();
    if (this.listenPromise) return this.listenPromise;
    await this.init();
    this.server = createServer((request, response) => {
      void this.#handle(request, response);
    });
    this.listenPromise = new Promise((resolve, reject) => {
      const onError = (error) => {
        this.server?.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server?.off("error", onError);
        resolve(this.address());
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.port, this.host);
    });
    try {
      return await this.listenPromise;
    } finally {
      this.listenPromise = null;
    }
  }

  address() {
    const address = this.server?.address();
    if (!address || typeof address === "string") return null;
    return { host: address.address, port: address.port };
  }

  async close() {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve()));
  }

  async #currentUser(request) {
    const token = parseCookies(request.headers.cookie).get(SESSION_COOKIE);
    if (!token) return null;
    return this.authStore.getUserBySession(token);
  }

  #unauthorized(request, response) {
    if (isJsonRequest(request) || request.url?.startsWith("/api/")) {
      sendJson(response, 401, { error: "authentication required" });
      return;
    }
    const next = safeNextPath(new URL(request.url ?? "/", "http://platform.invalid").pathname);
    redirect(response, `/login?next=${encodeURIComponent(next)}`);
  }

  #forbidden(response, message = "forbidden") {
    sendJson(response, 403, { error: message });
  }

  async #requireAdmin(request, response) {
    const user = await this.#currentUser(request);
    if (!user) {
      this.#unauthorized(request, response);
      return null;
    }
    if (user.role !== "admin") {
      this.#forbidden(response);
      return null;
    }
    return user;
  }

  async #readPayload(request, response) {
    try {
      return parseBody(request, await readBody(request, this.maxBodyBytes));
    } catch (error) {
      const status = error?.code === "body_too_large" ? 413 : 400;
      sendJson(response, status, { error: error?.message ?? "invalid request body" });
      return null;
    }
  }

  async #adminUsers(request, response) {
    if (request.method === "GET") {
      sendJson(response, 200, { users: await this.authStore.listUsers() });
      return;
    }
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "method not allowed" }, { allow: "GET, POST" });
      return;
    }
    const payload = await this.#readPayload(request, response);
    if (!payload) return;
    try {
      const user = await this.authStore.createUser(payload);
      sendJson(response, 201, { user });
    } catch (error) {
      const status = error?.code === "duplicate_username" ? 409 : 400;
      sendJson(response, status, { error: error?.message ?? "could not create user" });
    }
  }

  async #disableUser(request, response, userId) {
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "method not allowed" }, { allow: "POST" });
      return;
    }
    const payload = await this.#readPayload(request, response);
    if (!payload) return;
    const disabled = booleanValue(payload.disabled, true);
    try {
      const user = await this.authStore.disableUser(userId, disabled);
      if (disabled) {
        await this.workerManager.stopWorker(workerIdForUser(userId)).catch((error) => {
          if (!/unknown worker/.test(error?.message ?? "")) throw error;
        });
      }
      sendJson(response, 200, { user });
    } catch (error) {
      const status = error?.code === "unknown_user" ? 404 : 400;
      sendJson(response, status, { error: error?.message ?? "could not update user" });
    }
  }

  async #ensureWorker(user) {
    const workerId = workerIdForUser(user.id);
    await this.workerManager.ensureWorker({ instanceId: workerId, userId: user.id });
    return {
      workerId,
      worker: this.workerManager.getWorker(workerId),
      access: this.workerManager.getWorkerAccess(workerId),
    };
  }

  #bootstrapRequired(request, user) {
    if (this.tenantPolicy || request.method !== "GET") return false;
    const path = new URL(request.url ?? "/", "http://platform.invalid").pathname;
    if (path.startsWith("/api/") || path.startsWith("/v1/") || path === "/event") return false;
    const marker = parseCookies(request.headers.cookie).get(BOOTSTRAP_COOKIE);
    return marker !== user.id;
  }

  #bootstrapRedirect(request, response, user, token) {
    const parsed = new URL(request.url ?? "/", "http://platform.invalid");
    const location = `${parsed.pathname}${parsed.search}#token=${encodeURIComponent(token)}`;
    redirect(response, location, {
      "set-cookie": bootstrapCookie(user.id, this.secureCookies),
    });
  }

  async #proxy(request, response, access, user, worker) {
    // This branch is enabled only for explicitly migrated managed accounts.
    // It never invokes the legacy host CLI adapters.
    if (this.tenantPolicy && !(request.url ?? "").startsWith("/v1/")) {
      await this.#managedRuntimeProxy(request, response, access, user, worker);
      return;
    }
    if (this.cliRuntime && !this.tenantPolicy) {
      const handled = await this.cliRuntime.handle(request, response, {
        userId: user.id,
        workspaceDir: worker.workspaceDir,
      });
      if (handled) return;
    }
    const workerUrl = new URL(access.url);
    const parsed = new URL(request.url ?? "/", "http://platform.invalid");
    const isV1 = parsed.pathname.startsWith("/v1/");
    const token = isV1 ? `Bearer ${access.token}` : `Basic ${workerBasicToken(access.token)}`;
    const headers = { ...request.headers };
    delete headers.host;
    delete headers.connection;
    delete headers.cookie;
    delete headers.authorization;
    delete headers["x-forwarded-for"];
    delete headers["x-forwarded-host"];
    delete headers["x-forwarded-proto"];
    headers.host = workerUrl.host;
    headers.authorization = token;
    const upstream = httpRequest(
      {
        protocol: workerUrl.protocol,
        hostname: workerUrl.hostname,
        port: workerUrl.port,
        method: request.method,
        path: upstreamRequestPath(request.url, access.token),
        headers,
      },
      (upstreamResponse) => {
        const responseHeaders = filterResponseHeaders(upstreamResponse.headers);
        const download = parsed.pathname === "/v1/fs/read" && request.method === "GET"
          ? parsed.searchParams.get("download") : null;
        if (download && upstreamResponse.statusCode === 200) {
          const filename = Array.from(download.split(/[\\/]/).pop().replace(/[\r\n\x00]/g, "").toWellFormed()).slice(0, 240).join("") || "download";
          const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
          const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
          responseHeaders["content-disposition"] = `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
        }
        response.writeHead(
          upstreamResponse.statusCode ?? 502,
          responseHeaders,
        );
        upstreamResponse.pipe(response);
      },
    );
    let responded = false;
    upstream.on("response", () => {
      responded = true;
    });
    upstream.on("error", (error) => {
      if (response.headersSent || responded) {
        response.destroy(error);
        return;
      }
      sendJson(response, 502, { error: "worker unavailable" });
      this.logger({ type: "worker.proxy_error", error: error.message });
    });
    request.on("aborted", () => upstream.destroy());
    response.on("close", () => {
      if (!response.writableEnded) upstream.destroy();
    });
    request.pipe(upstream);
  }

  async #managedRuntimeProxy(request, response, access, user, worker) {
    try {
      const context = { userId: user.id, instanceId: workerIdForUser(user.id), generation: worker.generation };
      this.tenantPolicy.account(context);
      const rawPath = (request.url ?? "/").split("?")[0];
      const operation = classifyRuntimeRoute(request.method, rawPath);
      if (!operation) { sendJson(response, 404, { error: "not found" }); return; }
      if (!["GET", "HEAD"].includes(request.method)) {
        const expectedOrigin = `${this.secureCookies ? "https" : "http"}://${request.headers.host}`;
        if (request.headers.origin !== expectedOrigin ||
            request.headers["sec-fetch-site"] === "cross-site") {
          sendJson(response, 403, { error: "foreign origin" }); return;
        }
      }
      const parsed = new URL(request.url, "http://platform.invalid");
      let body = {};
      if (["POST", "PATCH", "DELETE"].includes(request.method)) {
        const bytes = await readBody(request, this.maxBodyBytes);
        try { body = parseBody(request, bytes); }
        catch { throw Object.assign(new Error("invalid runtime body"), { statusCode: 400 }); }
      }
      const input = validateRuntimeInput(operation, { query: parsed.searchParams, body, headers: request.headers });
      let directory = this.tenantPolicy.directory(context, input.directory);
      const sessionId = operation.identifiers.sessionId ?? body.sessionID;
      if (sessionId) {
        const session = this.tenantPolicy.session(context, sessionId);
        if (input.directory !== undefined && operation.operation !== "sessionMove" && input.directory !== session.directory)
          throw Object.assign(new Error("directory does not match session"), { statusCode: 403 });
        if (operation.operation !== "sessionMove") directory = session.directory;
      }
      if (body.parentID) this.tenantPolicy.session(context, body.parentID);
      if (operation.identifiers.requestId) this.tenantPolicy.request(context, operation.identifiers.requestId);
      if (operation.approval && operation.approval !== "reply" &&
          !(await this.approvalGate?.(context, { operation: operation.operation, sessionId, body }))) {
        sendJson(response, 403, { error: "approval required" }); return;
      }
      if (["modelConfig", "modelCatalog", "providerCatalog"].includes(operation.operation)) {
        const catalog = await this.runtimeCatalog?.(context);
        const safe = operation.operation === "modelConfig" ? { model: catalog?.model ?? null }
          : operation.operation === "providerCatalog" ? { all: catalog?.providers ?? [], connected: catalog?.connected ?? [] }
          : { providers: catalog?.providers ?? [], default: catalog?.defaults ?? {} };
        sendJson(response, 200, scrubRuntimeSecrets(safe)); return;
      }
      parsed.searchParams.delete("token");
      parsed.searchParams.delete("auth_token");
      parsed.searchParams.set("directory", directory);
      const target = new URL(`${operation.path}${parsed.search}`, access.url);
      const controller = new AbortController();
      request.on("aborted", () => controller.abort());
      response.on("close", () => { if (!response.writableEnded) controller.abort(); });
      const timeout = setTimeout(() => controller.abort(), 30000);
      try {
        const upstream = await fetch(target, { method: operation.method, redirect: "error", signal: controller.signal,
          headers: { authorization: `Basic ${workerBasicToken(access.token)}`, accept: operation.operation === "event"
            ? "text/event-stream" : "application/json", "content-type": "application/json" },
          ...(["POST", "PATCH", "DELETE"].includes(operation.method) ? { body: JSON.stringify(body) } : {}),
        });
        if (operation.operation === "event" && upstream.ok) {
          clearTimeout(timeout);
          response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
          const reader = upstream.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
              if (Buffer.byteLength(buffer) > this.maxBodyBytes) throw new Error("event exceeds limit");
              let boundary;
              while ((boundary = buffer.indexOf("\n\n")) !== -1) {
                const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
                const data = frame.split("\n").filter((line) => line.startsWith("data:"))
                  .map((line) => line.slice(5).trimStart()).join("\n");
                if (!data) continue;
                let event;
                try { event = scrubRuntimeSecrets(JSON.parse(data)); } catch { continue; }
                const properties = event.properties ?? event.payload?.properties;
                const type = event.type ?? event.payload?.type;
                if (["session.created", "session.updated"].includes(type) && properties?.info)
                  this.tenantPolicy.registerSession(context, properties.info);
                if (["permission.asked", "question.asked"].includes(type) && properties)
                  this.tenantPolicy.registerRequest(context, properties);
                if (properties?.sessionID) this.tenantPolicy.session(context, properties.sessionID);
                if (!response.write(`data: ${JSON.stringify(event)}\n\n`)) {
                  await new Promise((resolve, reject) => {
                    const onDrain = () => { cleanup(); resolve(); };
                    const onClose = () => { cleanup(); reject(new Error("event client closed")); };
                    const cleanup = () => { response.off("drain", onDrain); response.off("close", onClose); };
                    response.once("drain", onDrain); response.once("close", onClose);
                  });
                }
              }
            }
          } finally { await reader.cancel().catch(() => {}); }
          response.end(); return;
        }
        const chunks = [];
        let size = 0;
        for await (const chunk of upstream.body ?? []) {
          size += chunk.length;
          if (size > this.maxBodyBytes) throw new Error("runtime response exceeds limit");
          chunks.push(chunk);
        }
        let value;
        const text = Buffer.concat(chunks).toString("utf8");
        if (text) { try { value = JSON.parse(text); } catch { throw new Error("invalid runtime response"); } }
        if (upstream.ok) {
          if (["sessionCreate", "sessionFork", "sessionRead", "sessionPatch"].includes(operation.operation) && value)
            this.tenantPolicy.registerSession(context, { ...value, directory: value.directory ?? directory });
          if (["sessionList", "sessionChildren"].includes(operation.operation) && Array.isArray(value))
            this.tenantPolicy.registerSessionList(context, value);
          if (["permissionList", "questionList"].includes(operation.operation) && Array.isArray(value))
            for (const pending of value) this.tenantPolicy.registerRequest(context, pending);
          if (operation.operation === "sessionDelete") this.tenantPolicy.removeSession(context, sessionId);
          if (operation.operation === "sessionMove") this.tenantPolicy.registerSession(context, { id: sessionId, directory });
        }
        sendJson(response, upstream.status, scrubRuntimeSecrets(value ?? null));
      } finally { clearTimeout(timeout); }
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      const status = error.statusCode ?? (error.code === "body_too_large" ? 413 : 502);
      sendJson(response, status, { error: status < 500 ? error.message : "managed runtime unavailable" });
    }
  }

  async #serveWeb(request, response) {
    if (!this.webRoot || request.method !== "GET") return false;
    const pathname = new URL(request.url ?? "/", "http://platform.invalid").pathname;
    const kind = webRequestKind(pathname);
    if (!kind) return false;
    let relativePath;
    try {
      relativePath = kind === "index" ? "index.html" : decodeURIComponent(pathname.slice(1));
    } catch {
      sendJson(response, 400, { error: "invalid asset path" });
      return true;
    }
    const filePath = safeWebRelative(this.webRoot, relativePath);
    if (!filePath) {
      sendJson(response, 400, { error: "invalid asset path" });
      return true;
    }
    let body;
    try {
      body = await readFile(filePath);
    } catch (error) {
      // A missing index means the deployment has no separate web bundle; let
      // the worker's embedded client remain the fallback during rollout.
      if (error?.code === "ENOENT" && kind === "index") return false;
      if (error?.code === "ENOENT") {
        sendJson(response, 404, { error: "asset not found" });
        return true;
      }
      throw error;
    }
    if (kind === "index") {
      const html = body.toString("utf8").replace(
        "<head>",
        "<head><script>window.__OS_WEB__=true;</script>",
      );
      sendHtml(response, 200, html);
      return true;
    }
    response.writeHead(200, {
      "cache-control": pathname.startsWith("/assets/")
        ? "public, max-age=31536000, immutable"
        : "public, max-age=3600",
      "content-type": webMime(relativePath),
      "x-content-type-options": "nosniff",
    });
    response.end(body);
    return true;
  }

  async #handle(request, response) {
    try {
      const parsed = new URL(request.url ?? "/", "http://platform.invalid");
      const path = parsed.pathname;

      if (request.method === "GET" && path === "/health") {
        sendJson(response, 200, { ok: true, service: "open-science-platform" });
        return;
      }

      if (path === "/login") {
        const user = await this.#currentUser(request);
        if (user && request.method === "GET") {
          redirect(response, "/");
          return;
        }
        if (request.method !== "GET") {
          sendJson(response, 405, { error: "method not allowed" }, { allow: "GET" });
          return;
        }
        sendHtml(response, 200, loginPage("", safeNextPath(parsed.searchParams.get("next"))));
        return;
      }

      if (request.method === "POST" && path === "/auth/login") {
        const payload = await this.#readPayload(request, response);
        if (!payload) return;
        const user = await this.authStore.authenticate(payload.username, payload.password);
        if (!user) {
          if (isJsonRequest(request)) {
            sendJson(response, 401, { error: "invalid username or password" });
          } else {
            sendHtml(
              response,
              401,
              loginPage("Invalid username or password.", safeNextPath(payload.next)),
            );
          }
          return;
        }
        const session = await this.authStore.createSession(user.id);
        if (!session) {
          sendJson(response, 403, { error: "user is disabled" });
          return;
        }
        const cookies = [
          sessionCookie(
            session.token,
            Math.ceil((session.expiresAt - Date.now()) / 1_000),
            this.secureCookies,
          ),
          clearCookie(BOOTSTRAP_COOKIE, { secure: this.secureCookies }),
        ];
        if (isJsonRequest(request)) {
          sendJson(response, 200, { user }, { "set-cookie": cookies });
        } else {
          redirect(response, safeNextPath(payload.next), { "set-cookie": cookies });
        }
        return;
      }

      if (request.method === "POST" && path === "/auth/logout") {
        const sessionToken = parseCookies(request.headers.cookie).get(SESSION_COOKIE);
        if (sessionToken) await this.authStore.revokeSession(sessionToken);
        const cookies = [
          clearCookie(SESSION_COOKIE, { secure: this.secureCookies }),
          clearCookie(BOOTSTRAP_COOKIE, { secure: this.secureCookies }),
        ];
        if (isJsonRequest(request)) {
          sendJson(response, 200, { ok: true }, { "set-cookie": cookies });
        } else {
          redirect(response, "/login", { "set-cookie": cookies });
        }
        return;
      }

      if (path.startsWith("/api/")) {
        const user = await this.#currentUser(request);
        if (!user) {
          this.#unauthorized(request, response);
          return;
        }
        if (path === "/api/me" && request.method === "GET") {
          sendJson(response, 200, { user });
          return;
        }
        if (path === "/api/runtime") {
          if (request.method === "GET") {
            sendJson(response, 200, this.cliRuntime ? await this.cliRuntime.freshDescribe(user.id) : {
              runtime: "opencode",
              kind: "opencode",
              managed: false,
              label: "OpenCode",
              available: [{ runtime: "opencode", kind: "opencode", managed: false, label: "OpenCode" }],
            });
            return;
          }
          if (request.method !== "POST") {
            sendJson(response, 405, { error: "method not allowed" }, { allow: "GET, POST" });
            return;
          }
          if (!this.cliRuntime) {
            sendJson(response, 404, { error: "runtime selection is unavailable" });
            return;
          }
          const payload = await this.#readPayload(request, response);
          if (!payload) return;
          try {
            sendJson(response, 200, await this.cliRuntime.setUserRuntime(user.id, payload.runtime, payload.model));
          } catch (error) {
            sendJson(response, error?.status ?? 400, { error: error?.message ?? "could not set runtime" });
          }
          return;
        }
        if (path === "/api/admin/users" || path === "/api/admin/workers") {
          if (!(await this.#requireAdmin(request, response))) return;
          if (path === "/api/admin/users") {
            await this.#adminUsers(request, response);
          } else if (request.method === "GET") {
            sendJson(response, 200, { workers: this.workerManager.listWorkers() });
          } else {
            sendJson(response, 405, { error: "method not allowed" }, { allow: "GET" });
          }
          return;
        }
        if (path === "/api/admin/runtime") {
          if (!(await this.#requireAdmin(request, response))) return;
          if (!this.cliRuntime) {
            sendJson(response, 404, { error: "CLI runtime management is unavailable" });
            return;
          }
          if (request.method === "GET") {
            sendJson(response, 200, await this.cliRuntime.freshAdminDescribe());
            return;
          }
          if (request.method === "POST") {
            const payload = await this.#readPayload(request, response);
            if (!payload) return;
            try {
              sendJson(
                response,
                200,
                await (Object.keys(payload).sort().join(",") === "enabled,runtime"
                  ? this.cliRuntime.setAssistantEnabled(payload.runtime, payload.enabled)
                  : this.cliRuntime.setManagedRuntime(payload.runtime, payload.models, payload.defaultModel)),
              );
            } catch (error) {
              sendJson(response, error?.status ?? 400, { error: error?.message ?? "could not update runtime" });
            }
            return;
          }
          sendJson(response, 405, { error: "method not allowed" }, { allow: "GET, POST" });
          return;
        }
        const disableMatch = path.match(/^\/api\/admin\/users\/([^/]+)\/disable$/);
        if (disableMatch) {
          if (!(await this.#requireAdmin(request, response))) return;
          await this.#disableUser(request, response, decodeURIComponent(disableMatch[1]));
          return;
        }
        sendJson(response, 404, { error: "not found" });
        return;
      }

      const user = await this.#currentUser(request);
      if (!user) {
        this.#unauthorized(request, response);
        return;
      }
      const { access, worker } = await this.#ensureWorker(user);
      if (this.#bootstrapRequired(request, user)) {
        this.#bootstrapRedirect(request, response, user, access.token);
        return;
      }
      if (await this.#serveWeb(request, response)) return;
      await this.#proxy(request, response, access, user, worker);
    } catch (error) {
      this.logger({ type: "platform.request_error", error: error?.message ?? String(error) });
      if (!response.headersSent) {
        sendJson(response, 500, { error: "internal server error" });
      } else {
        response.destroy(error);
      }
    }
  }
}

export const platformConstants = {
  SESSION_COOKIE,
  BOOTSTRAP_COOKIE,
};
