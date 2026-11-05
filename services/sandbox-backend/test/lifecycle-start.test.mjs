import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "../src/registry.mjs";
import { DockerSandbox } from "../src/lifecycle.mjs";
import { configFor } from "./fixtures.mjs";
const image = `sha256:${"a".repeat(64)}`;
const token = "b".repeat(64);

function fakeDocker(calls) {
  return {
    imageInspect: async () => ({ Id: image, Architecture: "amd64", Config: { Labels: { "com.scikeel.worker": "true" } } }),
    networkCreate: async (spec) => { calls.push(["networkCreate", spec]); return { Id: "n1" }; },
    networkInspect: async () => ({ Id: "n1", Containers: {} }),
    networkConnect: async (...args) => calls.push(["networkConnect", ...args]),
    networkDisconnect: async (...args) => calls.push(["networkDisconnect", ...args]),
    containerCreate: async (spec) => { calls.push(["containerCreate", spec]); return { Id: "c1" }; },
    containerStart: async () => {},
    containerInspect: async () => ({ Id: "c1", State: { Running: true, Status: "running" } }),
    containerStop: async (...args) => calls.push(["containerStop", ...args]),
    containerRemove: async (...args) => calls.push(["containerRemove", ...args]),
    networkRemove: async (...args) => calls.push(["networkRemove", ...args]),
    listContainers: async () => [], listNetworks: async () => [],
  };
}

test("start creates an isolated worker with exact limits and binds", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandbox-start-"));
  const calls = [];
  const config = { dataDir: root, dataHostDir: root, instancesDir: join(root, "instances"), instancesHostDir: join(root, "instances"), nativeDir: join(root, "native"), nativeHostDir: join(root, "native"), stateDir: join(root, "state"), stateHostDir: join(root, "state"), platformContainer: "scikeel-platform", backendContainer: "scikeel-sandbox-backend", workerPlatform: "linux/amd64", runtime: "runc", workerUid: 1000, workerGid: 1000, memoryBytes: 1073741824, swapBytes: 1207959552, pidsMax: 256, nanoCpus: 1000000000, healthTimeoutMs: 1000, stopTimeoutSeconds: 5 };
  const sandbox = new DockerSandbox({ registry: new Registry(), docker: fakeDocker(calls), config, fetchImpl: async () => ({ ok: true, body: { cancel: async () => {} } }), tokenFactory: () => token });
  try {
    assert.deepEqual(await sandbox.register({ instanceId: "user-a", userId: "usr_a" }), { instanceId: "user-a", generation: 1 });
    assert.equal(JSON.parse(await readFile(join(root, "state", "registry.json"), "utf8")).accounts["user-a"].status, "registered");
    const result = await sandbox.start({ instanceId: "user-a", generation: 1, imageDigest: image });
    assert.deepEqual(result, { instanceId: "user-a", generation: 1, endpoint: "http://scikeel-worker-user-a:4790", runnerEndpoint: "http://scikeel-worker-user-a:4791", internalToken: token });
    assert.equal(JSON.parse(await readFile(join(root, "state", "registry.json"), "utf8")).accounts["user-a"].status, "ready");
    const create = calls.find(([name]) => name === "containerCreate")[1];
    assert.equal(create.platform, "linux/amd64");
    assert.equal(create.body.Image, image);
    assert.equal(create.body.User, "1000:1000");
    assert.equal(create.body.HostConfig.NetworkMode, "scikeel-user-user-a");
    assert.equal(create.body.HostConfig.ReadonlyRootfs, true);
    assert.deepEqual(create.body.HostConfig.CapDrop, ["ALL"]);
    assert.equal(create.body.HostConfig.Memory, 1073741824);
    assert.equal(create.body.HostConfig.PidsLimit, 256);
    assert.equal(create.body.HostConfig.NanoCpus, 1000000000);
    assert.equal(create.body.HostConfig.Runtime, "runc");
    assert.equal(create.body.HostConfig.Binds.some((bind) => bind.includes("docker.sock")), false);
    assert.equal(create.body.HostConfig.Binds.filter((bind) => bind.includes("/workspace")).length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("container writes use container roots while binds use host roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandbox-paths-"));
  const config = { ...configFor(root), instancesDir: join(root, "container", "instances"), instancesHostDir: join(root, "host", "instances"),
    nativeDir: join(root, "container", "native"), nativeHostDir: join(root, "host", "native"),
    stateDir: join(root, "container", "state"), stateHostDir: join(root, "host", "state") };
  const calls = [];
  const sandbox = new DockerSandbox({ registry: new Registry(), docker: fakeDocker(calls), config,
    fetchImpl: async () => ({ ok: true, body: { cancel: async () => {} } }), tokenFactory: () => token });
  try {
    await sandbox.register({ instanceId: "user-a", userId: "usr_a" });
    await sandbox.start({ instanceId: "user-a", generation: 1, imageDigest: image });
    const create = calls.find(([name]) => name === "containerCreate")[1];
    assert.ok(create.body.HostConfig.Binds.includes(
      `${join(root, "host", "instances", "user-a", "workspace")}:${join(root, "container", "instances", "user-a", "workspace")}:rw`));
    assert.equal((await stat(join(root, "container", "state", "control", "user-a-g1", "tenant.json"))).isFile(), true);
    assert.equal((await stat(join(root, "container", "native", "usr_a"))).mode & 0o777, 0o700);
    await assert.rejects(stat(join(root, "host", "state", "control", "user-a-g1", "tenant.json")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a failed cleanup is reported unverified without marking the account stopped", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandbox-start-unverified-"));
  const calls = [];
  const docker = fakeDocker(calls);
  docker.containerRemove = async () => { throw Object.assign(new Error("remove failed"), { statusCode: 500 }); };
  const sandbox = new DockerSandbox({ registry: new Registry(), docker, config: configFor(root),
    fetchImpl: async () => ({ ok: false, body: { cancel: async () => {} } }), tokenFactory: () => token });
  try {
    await sandbox.register({ instanceId: "user-a", userId: "usr_a" });
    await assert.rejects(() => sandbox.start({ instanceId: "user-a", generation: 1, imageDigest: image }), { code: "cleanup_unverified" });
    assert.equal(sandbox.registry.account("user-a").status, "starting");
    assert.equal(sandbox.registry.account("user-a").generation, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a failed health probe cleans up and increments the generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandbox-start-fail-"));
  const calls = [];
  const sandbox = new DockerSandbox({ registry: new Registry(), docker: fakeDocker(calls), config: configFor(root), fetchImpl: async () => ({ ok: false, body: { cancel: async () => {} } }), tokenFactory: () => token });
  try {
    await sandbox.register({ instanceId: "user-a", userId: "usr_a" });
    await assert.rejects(() => sandbox.start({ instanceId: "user-a", generation: 1, imageDigest: image }), /worker_health_timeout|unavailable/);
    assert.equal(sandbox.registry.account("user-a").status, "unavailable");
    assert.equal(sandbox.registry.account("user-a").generation, 2);
    assert.ok(calls.some(([name]) => name === "containerRemove"));
    assert.ok(calls.some(([name]) => name === "networkRemove"));
  } finally { await rm(root, { recursive: true, force: true }); }
});
