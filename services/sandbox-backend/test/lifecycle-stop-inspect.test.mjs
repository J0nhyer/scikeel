import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "../src/registry.mjs";
import { DockerSandbox } from "../src/lifecycle.mjs";
import { configFor } from "./fixtures.mjs";
const image = `sha256:${"a".repeat(64)}`;
const token = "c".repeat(64);

function readyRegistry() {
  const registry = new Registry();
  registry.register("user-a", "usr_a");
  registry.beginStart("user-a", 1, image);
  registry.markReady("user-a", 1);
  return registry;
}

test("stop is idempotent and stale generations are rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandbox-stop-"));
  const calls = [];
  const docker = { containerStop: async (...a) => calls.push(["stop", ...a]), containerRemove: async (...a) => calls.push(["remove", ...a]), networkInspect: async () => ({ Containers: {} }), networkDisconnect: async () => {}, networkRemove: async () => {}, containerInspect: async () => ({ State: { Running: true } }) };
  const sandbox = new DockerSandbox({ registry: new Registry(), docker, config: configFor(root), fetchImpl: async () => ({ ok: true, body: { cancel: async () => {} } }), tokenFactory: () => "a".repeat(64) });
  try {
    const r = new Registry(); r.register("user-a", "usr_a"); r.beginStart("user-a", 1, image); r.markReady("user-a", 1);
    sandbox.registry = r;
    assert.deepEqual(await sandbox.stop({ instanceId: "user-a", generation: 1, reason: "idle" }), { instanceId: "user-a", generation: 1, stopped: true });
    assert.equal(calls.filter(([name]) => name === "stop").length, 1);
    await sandbox.stop({ instanceId: "user-a", generation: 1, reason: "idle" });
    assert.equal(calls.filter(([name]) => name === "stop").length, 1);
    await sandbox.stop({ instanceId: "user-a", generation: 2, reason: "idle" });
    assert.equal(r.account("user-a").generation, 3);
    await assert.rejects(() => sandbox.stop({ instanceId: "user-a", generation: 1, reason: "idle" }), { code: "stale_generation" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("inspect returns ready endpoints and reattaches the platform", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandbox-inspect-"));
  const calls = [];
  const config = configFor(root);
  const control = join(config.stateHostDir, "control", "user-a-g1");
  await mkdir(control, { recursive: true });
  await writeFile(join(control, "runner-auth.json"), JSON.stringify({ schema: 1, token }));
  const docker = {
    containerInspect: async () => ({ State: { Running: true } }),
    networkInspect: async () => ({ Containers: {} }),
    networkConnect: async (...args) => calls.push(args),
  };
  const sandbox = new DockerSandbox({ registry: readyRegistry(), docker, config });
  try {
    assert.deepEqual(await sandbox.inspect({ instanceId: "user-a" }), {
      instanceId: "user-a", generation: 1, status: "ready", imageDigest: image,
      endpoint: "http://scikeel-worker-user-a:4790", runnerEndpoint: "http://scikeel-worker-user-a:4791", internalToken: token,
    });
    assert.ok(calls.some(([network, container, aliases]) => network === "scikeel-user-user-a" &&
      container === "scikeel-platform" && aliases.includes("broker")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("inspect marks a missing container unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandbox-inspect-missing-"));
  const docker = { containerInspect: async () => { throw Object.assign(new Error("not found"), { statusCode: 404 }); } };
  const registry = readyRegistry();
  const sandbox = new DockerSandbox({ registry, docker, config: configFor(root) });
  try {
    const value = await sandbox.inspect({ instanceId: "user-a" });
    assert.equal(value.status, "unavailable");
    assert.equal(registry.account("user-a").generation, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("inventory omits internal registry fields", () => {
  const registry = new Registry(); registry.register("user-a", "usr_a");
  const sandbox = new DockerSandbox({ registry, docker: {}, config: configFor("/tmp") });
  assert.deepEqual(sandbox.inventory(), { accounts: [{ instanceId: "user-a", userId: "usr_a", generation: 1, status: "registered" }] });
});
