import { BlockList, createConnection, isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { randomBytes } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const denied = new BlockList();
for (const [address, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]])
  denied.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList(); globalV6.addSubnet("2000::", 3, "ipv6");
for (const [address, prefix] of [["2001::", 32], ["2001:db8::", 32], ["2002::", 16], ["2001:10::", 28],
  ["2001:20::", 28], ["3fff::", 20]]) denied.addSubnet(address, prefix, "ipv6");
export function isPublicAddress(address) {
  if (typeof address !== "string" || address.includes("%")) return false;
  const family = isIP(address);
  if (family === 4) return !denied.check(address, "ipv4");
  return family === 6 && globalV6.check(address, "ipv6") && !denied.check(address, "ipv6");
}
function identity(context) {
  if (!context || ![context.userId, context.instanceId].every((v) => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v)) ||
      !Number.isSafeInteger(context.generation) || context.generation < 1) throw failure("egress_identity_denied");
  return `${context.userId}:${context.instanceId}:${context.generation}`;
}
function destination(value) {
  let url; try { url = new URL(value); } catch { throw failure("egress_destination_denied"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash ||
      !url.hostname || !["", url.protocol === "https:" ? "443" : "80"].includes(url.port)) throw failure("egress_destination_denied");
  return url;
}
function byteLimit(maximum) {
  let bytes = 0;
  return new Transform({ transform(chunk, encoding, callback) {
    bytes += chunk.length;
    if (bytes > maximum) callback(failure("egress_byte_limit", 413)); else callback(null, chunk);
  } });
}
function failure(code, status = 403) {
  return Object.assign(new Error(code), { code, status });
}
function bounded(operation, signal, timeoutMs, code) {
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    const abort = () => { cleanup(); reject(signal.reason); };
    if (signal?.aborted) { reject(signal.reason); return; }
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => { cleanup(); reject(failure(code, 504)); }, timeoutMs);
    Promise.resolve().then(operation).then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
  });
}
function sendFailure(res, error) {
  if (res.destroyed) return;
  if (res.headersSent) { res.destroy(); return; }
  const known = error?.status && /^egress_[a-z_]+$/.test(error.code ?? "");
  res.writeHead(known ? error.status : 502, { "content-type": "application/json", "cache-control": "no-store", connection: "close" });
  res.end(JSON.stringify({ error: known ? error.code : "egress_upstream_unavailable" }));
}
function proxyGrant(value) {
  if (typeof value !== "string" || value.length > 200) return null;
  const bearer = /^Bearer ([a-f0-9]{64})$/.exec(value);
  if (bearer) return bearer[1];
  const basic = /^Basic ([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!basic) return null;
  const decoded = Buffer.from(basic[1], "base64");
  if (decoded.toString("base64") !== basic[1]) return null;
  return /^scikeel:([a-f0-9]{64})$/.exec(decoded.toString("utf8"))?.[1] ?? null;
}
const hopHeaders = new Set(["authorization", "cookie", "proxy-authorization", "proxy-authenticate", "connection", "keep-alive", "te", "trailer", "transfer-encoding", "upgrade", "forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto"]);
function headers(input) {
  const out = {};
  const connection = String(input.connection ?? "").toLowerCase().split(",").map((v) => v.trim());
  for (const [key, value] of Object.entries(input)) if (!hopHeaders.has(key) && !connection.includes(key) && key !== "host" && value !== undefined) out[key] = value;
  return out;
}
export class EgressBroker {
  #grants = new Map(); #active = new Map(); #clients = new Set(); #operations = new Set(); #pending = 0;
  constructor({ now = Date.now, resolve = (host) => lookup(host, { all: true, verbatim: true }), identify,
    request = (options) => (options.protocol === "https:" ? httpsRequest : httpRequest)(options), connect = createConnection,
    maxBytes = 32 * 1024 ** 2, timeoutMs = 120000, dnsTimeoutMs = 5000, maxConnections = 8 } = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 128 * 1024 ** 2 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000 ||
        !Number.isSafeInteger(dnsTimeoutMs) || dnsTimeoutMs < 1 || dnsTimeoutMs > 5000 ||
        !Number.isSafeInteger(maxConnections) || maxConnections < 1 || maxConnections > 8) throw new Error("invalid egress limits");
    this.now = now; this.resolve = resolve; this.identify = identify; this.request = request; this.connect = connect;
    this.maxBytes = maxBytes; this.timeoutMs = timeoutMs; this.dnsTimeoutMs = dnsTimeoutMs; this.maxConnections = maxConnections;
  }
  grant({ context, destinations, expiresAt }) {
    const owner = identity(context);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= this.now() || expiresAt > this.now() + 600000 ||
        !Array.isArray(destinations) || destinations.length < 1 || destinations.length > 20) throw new Error("invalid egress grant");
    for (const [id, grant] of this.#grants) if (grant.expiresAt <= this.now()) this.#grants.delete(id);
    if (this.#grants.size >= 1000) throw new Error("egress grant capacity");
    const origins = new Set(destinations.map((value) => destination(value).origin));
    const id = randomBytes(32).toString("hex"); this.#grants.set(id, { owner, origins, expiresAt }); return { id, expiresAt };
  }
  revoke(context) {
    const owner = identity(context);
    for (const [id, grant] of this.#grants) if (grant.owner === owner) this.#grants.delete(id);
    this.#active.get(owner)?.abort(failure("egress_grant_revoked"));
  }
  async target({ context, grantId, url, signal }) {
    const owner = identity(context); const grant = this.#grants.get(grantId); const parsed = destination(url);
    if (!grant || grant.owner !== owner || grant.expiresAt <= this.now() || !grant.origins.has(parsed.origin)) throw failure("egress_grant_denied");
    const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
    let answers;
    try {
      answers = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await bounded(
        () => this.resolve(hostname), signal, Math.min(this.dnsTimeoutMs, grant.expiresAt - this.now()), "egress_dns_timeout");
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw error?.status ? error : failure("egress_dns_unavailable", 502);
    }
    if (!Array.isArray(answers) || answers.length < 1 || answers.length > 32 ||
        answers.some((answer) => !answer || !isPublicAddress(answer.address) || isIP(answer.address) !== answer.family)) throw failure("egress_address_denied");
    if (signal?.aborted) throw signal.reason;
    if (grant.expiresAt <= this.now() || this.#grants.get(grantId) !== grant) throw failure("egress_grant_expired");
    return { address: answers[0].address, family: answers[0].family, port: parsed.protocol === "https:" ? 443 : 80,
      hostname, protocol: parsed.protocol, path: `${parsed.pathname}${parsed.search}`, expiresAt: grant.expiresAt };
  }
  async #admit(req, controller) {
    const grantId = proxyGrant(req.headers["proxy-authorization"]);
    if (!grantId || !this.identify) throw failure("egress_admission_denied");
    if (this.#active.size + this.#pending >= this.maxConnections) throw failure("egress_busy", 429);
    this.#pending++;
    let context;
    try { context = await bounded(() => this.identify(req.socket.remoteAddress), controller.signal, this.timeoutMs, "egress_timeout"); }
    catch (error) { throw controller.signal.aborted ? controller.signal.reason : error?.status ? error : failure("egress_admission_denied"); }
    finally { this.#pending--; }
    const owner = identity(context);
    if (this.#active.has(owner)) throw failure("egress_busy", 429);
    this.#active.set(owner, controller);
    let released = false;
    const release = () => { if (!released) { released = true; this.#active.delete(owner); } };
    return { context, owner, grantId, release };
  }
  async #http(req, res) {
    let lease; let upstream; let expiry;
    const controller = new AbortController(); this.#operations.add(controller);
    const timer = setTimeout(() => controller.abort(failure("egress_timeout", 504)), this.timeoutMs);
    const cancel = () => { if (!res.writableFinished) controller.abort(failure("egress_client_closed", 499)); };
    res.once("close", cancel);
    try {
      if (!["GET", "HEAD", "POST"].includes(req.method)) throw failure("egress_method_denied");
      lease = await this.#admit(req, controller);
      const target = await this.target({ context: lease.context, grantId: lease.grantId, url: req.url, signal: controller.signal });
      expiry = setTimeout(() => controller.abort(failure("egress_grant_expired")), Math.max(1, target.expiresAt - this.now()));
      upstream = this.request({ protocol: target.protocol, hostname: target.address, family: target.family, port: target.port, servername: target.hostname,
        method: req.method, path: target.path, headers: { ...headers(req.headers), host: target.hostname }, agent: false,
        // Target is already an IP; no second name lookup can rebind it.
        lookup: (_name, _options, callback) => callback(new Error("unexpected egress DNS lookup")), signal: controller.signal });
      const response = await new Promise((resolve, reject) => {
        upstream.once("response", resolve); upstream.once("error", reject);
        pipeline(req, byteLimit(1024 ** 2), upstream).catch(reject);
      });
      res.writeHead(response.statusCode, headers(response.headers));
      await pipeline(response, byteLimit(this.maxBytes), res, { signal: controller.signal });
    } catch (error) {
      sendFailure(res, controller.signal.aborted ? controller.signal.reason : error);
    } finally {
      upstream?.destroy(); lease?.release(); clearTimeout(timer); clearTimeout(expiry);
      res.removeListener("close", cancel); this.#operations.delete(controller);
    }
  }
  async #connect(req, socket, head) {
    let lease; let upstream; let expiry; let established = false;
    const controller = new AbortController(); this.#operations.add(controller);
    const timer = setTimeout(() => controller.abort(failure("egress_timeout", 504)), this.timeoutMs);
    const cancel = () => controller.abort(failure("egress_client_closed", 499));
    socket.once("close", cancel);
    socket.once("error", cancel);
    try {
      if (head.length || !/^(?:[A-Za-z0-9.-]+|\[[0-9a-fA-F:]+\]):443$/.test(req.url)) throw failure("egress_destination_denied");
      lease = await this.#admit(req, controller);
      const target = await this.target({ context: lease.context, grantId: lease.grantId, url: `https://${req.url}`, signal: controller.signal });
      expiry = setTimeout(() => controller.abort(failure("egress_grant_expired")), Math.max(1, target.expiresAt - this.now()));
      upstream = this.connect({ host: target.address, family: target.family, port: 443, signal: controller.signal,
        lookup: (_name, _options, callback) => callback(new Error("unexpected egress DNS lookup")) });
      await new Promise((resolve, reject) => {
        upstream.once("connect", resolve); upstream.once("error", reject); socket.once("error", reject);
      });
      established = true; socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      await Promise.all([pipeline(socket, byteLimit(this.maxBytes), upstream, { signal: controller.signal }),
        pipeline(upstream, byteLimit(this.maxBytes), socket, { signal: controller.signal })]);
    } catch (error) {
      const reason = controller.signal.aborted ? controller.signal.reason : error;
      if (!established && !socket.destroyed) socket.end(`HTTP/1.1 ${reason?.status ?? 502} Connection Failed\r\nConnection: close\r\n\r\n`);
      else socket.destroy();
    } finally {
      upstream?.destroy(); lease?.release(); clearTimeout(timer); clearTimeout(expiry);
      socket.removeListener("close", cancel); socket.removeListener("error", cancel); this.#operations.delete(controller);
    }
  }
  async listen({ host = "172.31.240.1", port = 4794 } = {}) {
    if (this.server) throw new Error("egress broker already listening");
    this.server = createServer({ maxHeaderSize: 16384, requestTimeout: 15000, headersTimeout: 5000 }, (req, res) => void this.#http(req, res));
    this.server.on("connect", (req, socket, head) => void this.#connect(req, socket, head));
    this.server.on("clientError", (_error, socket) => socket.destroy());
    this.server.on("connection", (socket) => {
      this.#clients.add(socket);
      // CONNECT transfers ownership away from HTTP's socket error handler.
      // Keep one listener after tunnel cleanup, including late peer resets.
      socket.on("error", () => socket.destroy());
      socket.once("close", () => this.#clients.delete(socket));
    });
    this.server.maxConnections = this.maxConnections * 2;
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
    for (const operation of this.#operations) operation.abort(failure("egress_broker_closed", 503));
    for (const socket of this.#clients) socket.destroy(); this.#grants.clear();
    if (this.server) { this.server.closeAllConnections(); await new Promise((resolve) => this.server.close(resolve)); this.server = null; }
  }
}
