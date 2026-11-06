import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerApi, DockerApiError } from "../src/docker-api.mjs";

test("sends the API version and parses JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "docker-api-"));
  const socketPath = join(dir, "docker.sock");
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url });
    if (req.url.endsWith("/images/missing/json")) { res.statusCode = 404; res.end(JSON.stringify({ message: "no such image" })); return; }
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const api = new DockerApi({ socketPath });
    assert.deepEqual(await api.request("GET", "/_ping"), { ok: true });
    assert.equal(seen[0].url, "/v1.44/_ping");
    await assert.rejects(() => api.imageInspect("missing"), (error) => error instanceof DockerApiError && error.statusCode === 404);
    await assert.rejects(() => api.imageInspect("missing"), /no such image/);
  } finally { await new Promise((resolve) => server.close(resolve)); await rm(dir, { recursive: true, force: true }); }
});
