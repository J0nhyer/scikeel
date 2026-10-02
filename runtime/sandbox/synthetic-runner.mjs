// Synthetic image only: fixed acceptance tasks, never a production execution API.
import { createServer } from "node:http";
import { scienceProbe } from "./probe-entry.mjs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function createSyntheticRunner({ probe = scienceProbe } = {}) {
  let active = false;
  function response(res, status, body) {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", connection: "close" });
    res.end(JSON.stringify(body));
  }
  const gateway = createServer((req, res) => {
    response(res, req.method === "GET" && req.url === "/health" ? 200 : 404, { synthetic: true });
  });
  const runner = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") { response(res, 200, { synthetic: true }); return; }
    if (req.method !== "POST" || req.url !== "/test/science" || req.headers["transfer-encoding"] ||
        (req.headers["content-length"] && req.headers["content-length"] !== "0")) { response(res, 404, { error: "unsupported_fixture" }); return; }
    if (active) { response(res, 429, { error: "fixture_busy" }); return; }
    active = true;
    try { response(res, 200, await probe()); }
    catch { response(res, 500, { error: "science_fixture_failed" }); }
    finally { active = false; }
  });
  for (const server of [gateway, runner]) {
    server.maxHeadersCount = 16; server.headersTimeout = 5000; server.requestTimeout = 5000;
    server.on("clientError", (_error, socket) => socket.destroy());
  }
  async function close() {
    for (const server of [gateway, runner]) {
      server.closeAllConnections();
      if (server.listening) await new Promise((done) => server.close(done));
    }
  }
  return { gateway, runner, close, async listen({ host, gatewayPort = 4790, runnerPort = 4791 }) {
    if (!/^(?:127\.0\.0\.1|172\.31\.240\.(?:[2-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-4]))$/.test(host ?? ""))
      throw new Error("invalid synthetic bind address");
    try {
      for (const [server, port] of [[gateway, gatewayPort], [runner, runnerPort]]) await new Promise((done, reject) => {
        const error = (reason) => { server.off("listening", ready); reject(reason); };
        const ready = () => { server.off("error", error); done(); };
        server.once("error", error); server.once("listening", ready); server.listen(port, host);
      });
      return { gateway: `http://${host}:${gateway.address().port}`, runner: `http://${host}:${runner.address().port}` };
    } catch (error) { await close(); throw error; }
  } };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const runner = createSyntheticRunner();
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void runner.close().finally(() => process.exit(0)); });
  try { await runner.listen({ host: process.env.SCIKEEL_BIND_ADDRESS }); }
  catch { console.error("Synthetic runner startup failed"); process.exitCode = 1; }
}
