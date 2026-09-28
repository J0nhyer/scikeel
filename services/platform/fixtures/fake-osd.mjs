import { createServer } from "node:http";

const args = process.argv.slice(2);

function value(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
}

const port = Number(value("--port"));
const token = value("--token");
const workspace = value("--workspace");
const stateDir = value("--state-dir");

if (!port || !token || !workspace || !stateDir) {
  console.error("fake osd: missing required server arguments");
  process.exit(2);
}

const server = createServer((request, response) => {
  if (request.url === "/v1/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, service: "fake-osd" }));
    return;
  }
  if (request.url === "/") {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(`worker:${workspace}`);
    return;
  }
  const expectedBasic = `Basic ${Buffer.from(`opencode:${token}`).toString("base64")}`;
  if (request.url === "/echo") {
    if (request.headers.authorization !== expectedBasic) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "expected basic auth" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      authorization: request.headers.authorization,
      cookie: request.headers.cookie ?? null,
    }));
    return;
  }
  if (request.url?.startsWith("/event")) {
    if (request.headers.authorization !== expectedBasic) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "expected basic auth" }));
      return;
    }
    response.writeHead(200, {
      "cache-control": "no-cache",
      "content-type": "text/event-stream",
    });
    response.end(JSON.stringify({
      authorization: request.headers.authorization,
      query: request.url,
    }));
    return;
  }
  if (request.headers.authorization !== `Bearer ${token}`) {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }
  if (request.url === "/v1/whoami") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      authorization: request.headers.authorization,
      directory: workspace,
      stateDir,
    }));
    return;
  }
  response.writeHead(404);
  response.end();
});

server.listen(port, "127.0.0.1", () => {
  console.log(`fake worker ready on ${port}`);
});

function stop() {
  server.close(() => process.exit(0));
}

process.on("SIGTERM", stop);
process.on("SIGINT", stop);
