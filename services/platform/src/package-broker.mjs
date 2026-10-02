import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export function packageRoute(method, path) {
  if (!["GET", "HEAD"].includes(method) || typeof path !== "string" || path.length > 1024 || /[%?#!\\\x00-\x20]/.test(path)) return null;
  const index = /^\/root\/pypi\/\+simple\/([a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?)\/$/.exec(path);
  if (index) return { kind: "index", package: index[1], path };
  if (/^\/root\/pypi\/\+f\/[a-f0-9]{3}\/[a-f0-9]{13,64}\/[A-Za-z0-9][A-Za-z0-9_.+-]{0,240}\.(?:whl|zip|tar\.(?:gz|bz2|xz))$/.test(path))
    return { kind: "archive", path };
  return null;
}
function decode(value) {
  const named = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" };
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|quot|apos|lt|gt);/gi, (_, name) => {
    if (!name.startsWith("#")) return named[name.toLowerCase()];
    const code = name.toLowerCase().startsWith("#x") ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    if (!Number.isSafeInteger(code) || code < 1 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw new Error("invalid mirror entity");
    return String.fromCodePoint(code);
  });
}
function escape(value) { return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]); }
export function rewritePackageIndex(html, base) {
  if (typeof html !== "string" || Buffer.byteLength(html) > 2 * 1024 ** 2) throw new Error("mirror index limit");
  const origin = new URL(base).origin; const links = [];
  // Reconstruct inert PEP 503 anchors; never expose upstream markup or external archive links.
  for (const anchor of html.matchAll(/<a\s+([^>]{1,8192})>/gi)) {
    const attribute = /(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(anchor[1]);
    if (!attribute) throw new Error("invalid mirror anchor");
    const raw = decode(attribute[1] ?? attribute[2]);
    if (raw.includes("%") || raw.includes("\\")) throw new Error("invalid mirror link");
    const url = new URL(raw, base);
    const route = packageRoute("GET", url.pathname);
    if (url.origin !== origin || url.username || url.password || url.search || route?.kind !== "archive" ||
        (url.hash && !/^#sha256=[a-f0-9]{64}$/.test(url.hash))) throw new Error("untrusted mirror link");
    let attributes = "";
    for (const name of ["data-requires-python", "data-yanked"]) {
      const valued = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(anchor[1]);
      if (valued) attributes += ` ${name}="${escape(decode(valued[1] ?? valued[2]))}"`;
      else if (name === "data-yanked" && /(?:^|\s)data-yanked(?:\s|$)/i.test(anchor[1])) attributes += ' data-yanked=""';
    }
    const href = `${route.path}${url.hash}`;
    links.push(`<a href="${escape(href)}"${attributes}>${escape(url.pathname.split("/").at(-1))}</a>`);
    if (links.length > 20000) throw new Error("mirror index limit");
  }
  return `<!doctype html><html><body>\n${links.join("\n")}\n</body></html>\n`;
}
function error(code, status) { return Object.assign(new Error(code), { code, status }); }
function credential(value) {
  if (typeof value !== "string" || value.length > 240) return null;
  const bearer = /^Bearer ([A-Za-z0-9_-]{1,128})$/.exec(value);
  if (bearer) return bearer[1];
  const basic = /^Basic ([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!basic) return null;
  const decoded = Buffer.from(basic[1], "base64");
  if (decoded.toString("base64") !== basic[1]) return null;
  return /^scikeel:([A-Za-z0-9_-]{1,128})$/.exec(decoded.toString("utf8"))?.[1] ?? null;
}
function limit(maximum) {
  let bytes = 0;
  return new Transform({ transform(chunk, _encoding, callback) {
    bytes += chunk.length; callback(bytes > maximum ? error("package_byte_limit", 413) : null, chunk);
  } });
}
function authorized(operation, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(operation).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
function fail(res, reason) {
  if (res.destroyed) return;
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(reason?.status ?? 502, { "content-type": "application/json", "cache-control": "no-store", connection: "close" });
  res.end(JSON.stringify({ error: reason?.status ? reason.code : "package_mirror_unavailable" }));
}
const contentHeaders = { "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'", "cache-control": "no-store" };
export class PackageBroker {
  #clients = new Set(); #operations = new Set(); #active = new Set();
  constructor({ mirrorUrl, identify, authorize, timeoutMs = 90000, maxBytes = 128 * 1024 ** 2, maxConnections = 8 } = {}) {
    let url; try { url = new URL(mirrorUrl); } catch { throw new Error("invalid package mirror configuration"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
        typeof identify !== "function" || typeof authorize !== "function" ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 90000 ||
        !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 128 * 1024 ** 2 ||
        !Number.isSafeInteger(maxConnections) || maxConnections < 1 || maxConnections > 8) throw new Error("invalid package mirror configuration");
    this.mirrorUrl = url; this.identify = identify; this.authorize = authorize;
    this.timeoutMs = timeoutMs; this.maxBytes = maxBytes; this.maxConnections = maxConnections;
  }
  async #handle(req, res) {
    const controller = new AbortController(); this.#operations.add(controller);
    const timer = setTimeout(() => controller.abort(error("package_timeout", 504)), this.timeoutMs);
    const cancel = () => { if (!res.writableFinished) controller.abort(error("package_client_closed", 499)); };
    res.once("close", cancel);
    let upstream; let owner;
    try {
      const route = packageRoute(req.method, req.url);
      if (!route || req.headers["content-length"] && req.headers["content-length"] !== "0" || req.headers["transfer-encoding"]) throw error("package_route_denied", 403);
      if (this.#operations.size > this.maxConnections) throw error("package_busy", 429);
      const grant = credential(req.headers.authorization);
      const context = await authorized(() => this.identify(req.socket.remoteAddress), controller.signal);
      if (!context || ![context.userId, context.instanceId].every((id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id)) ||
          !Number.isSafeInteger(context.generation) || context.generation < 1 || !grant ||
          await authorized(() => this.authorize(context, route, grant), controller.signal) !== true) throw error("package_grant_denied", 403);
      owner = `${context.userId}:${context.instanceId}:${context.generation}`;
      if (this.#active.has(owner)) { owner = undefined; throw error("package_busy", 429); }
      this.#active.add(owner);
      const url = new URL(route.path, this.mirrorUrl);
      upstream = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, { method: req.method, agent: false,
        headers: { accept: route.kind === "index" ? "text/html" : "application/octet-stream", "accept-encoding": "identity" }, signal: controller.signal });
      const response = await new Promise((resolve, reject) => { upstream.once("response", resolve); upstream.once("error", reject); upstream.end(); });
      if (response.statusCode !== 200) {
        response.destroy();
        if (response.statusCode === 404) throw error("package_not_found", 404);
        throw error("package_mirror_unavailable", 502);
      }
      if (req.method === "HEAD") {
        response.destroy(); res.writeHead(200, { ...contentHeaders, "content-type": route.kind === "index" ? "text/html; charset=utf-8" : "application/octet-stream" }); res.end();
      } else if (route.kind === "index") {
        if (!/^text\/html(?:\s*;|$)/i.test(response.headers["content-type"] ?? "") || response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") throw error("package_mirror_unavailable", 502);
        const chunks = []; let bytes = 0;
        for await (const chunk of response) {
          bytes += chunk.length; if (bytes > Math.min(this.maxBytes, 2 * 1024 ** 2)) throw error("package_byte_limit", 413);
          chunks.push(chunk);
        }
        const html = rewritePackageIndex(Buffer.concat(chunks).toString("utf8"), url.href);
        res.writeHead(200, { ...contentHeaders, "content-type": "text/html; charset=utf-8" }); res.end(html);
      } else {
        if (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") throw error("package_mirror_unavailable", 502);
        res.writeHead(200, { ...contentHeaders, "content-type": "application/octet-stream" });
        await pipeline(response, limit(this.maxBytes), res, { signal: controller.signal });
      }
    } catch (reason) { fail(res, controller.signal.aborted ? controller.signal.reason : reason); }
    finally {
      upstream?.destroy(); if (owner) this.#active.delete(owner); clearTimeout(timer);
      res.removeListener("close", cancel); this.#operations.delete(controller);
    }
  }
  async listen({ host = "172.31.240.1", port = 4793 } = {}) {
    if (this.server) throw new Error("package broker already listening");
    this.server = createServer({ maxHeaderSize: 16384, requestTimeout: 15000, headersTimeout: 5000 }, (req, res) => void this.#handle(req, res));
    this.server.on("connection", (socket) => { this.#clients.add(socket); socket.once("close", () => this.#clients.delete(socket)); });
    this.server.on("connect", (_req, socket) => socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"));
    this.server.on("clientError", (_error, socket) => socket.destroy()); this.server.maxConnections = this.maxConnections * 2;
    try {
      await new Promise((resolve, reject) => {
        const failed = (error) => { this.server.removeListener("listening", ready); reject(error); };
        const ready = () => { this.server.removeListener("error", failed); resolve(); };
        this.server.once("error", failed); this.server.once("listening", ready); this.server.listen(port, host);
      });
    } catch (error) { this.server.close(); this.server = null; throw error; }
    return this.server.address();
  }
  async close() {
    for (const operation of this.#operations) operation.abort(error("package_broker_closed", 503));
    for (const socket of this.#clients) socket.destroy();
    if (this.server) { this.server.closeAllConnections(); await new Promise((resolve) => this.server.close(resolve)); this.server = null; }
  }
}
