import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "../src/registry.mjs";
import { DockerSandbox } from "../src/lifecycle.mjs";
import { configFor } from "./fixtures.mjs";
const image = `sha256:${"a".repeat(64)}`;

test("init retires interrupted generations and removes orphans", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandbox-init-"));
  const removed = [];
  const docker = { listContainers: async () => [{ Id: "orphan", Labels: { "com.scikeel.managed": "true" } }], listNetworks: async () => [{ Id: "orphan-net", Name: "scikeel-user-orphan" }], containerInspect: async () => ({ State: { Running: true } }), containerStop: async () => {}, containerRemove: async (id) => removed.push(["container", id]), networkInspect: async () => ({ Containers: {} }), networkDisconnect: async () => {}, networkRemove: async (id) => removed.push(["network", id]), networkConnect: async () => {} };
  const registry = new Registry(); registry.register("user-a", "usr_a"); registry.beginStart("user-a", 1, image); registry.markReady("user-a", 1);
  const sandbox = new DockerSandbox({ registry, docker, config: configFor(root), fetchImpl: async () => ({ ok: true, body: { cancel: async () => {} } }) });
  try {
    await sandbox.init();
    assert.equal(registry.account("user-a").status, "unavailable");
    assert.equal(registry.account("user-a").generation, 2);
    assert.ok(removed.some(([kind, id]) => kind === "container" && id === "orphan"));
    assert.ok(removed.some(([kind, id]) => kind === "network" && id === "orphan-net"));
    const saved = JSON.parse(await readFile(join(root, "state", "registry.json"), "utf8"));
    assert.equal(saved.accounts["user-a"].status, "unavailable");
  } finally { await rm(root, { recursive: true, force: true }); }
});
