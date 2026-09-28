import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

import { WorkerManager } from "../src/worker-manager.mjs";

const fakeOsd = fileURLToPath(new URL("../fixtures/fake-osd.mjs", import.meta.url));
const managers = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
});

async function makeManager() {
  const rootDir = await mkdtemp(join(tmpdir(), "osd-platform-"));
  const manager = new WorkerManager({
    rootDir,
    osdCommand: process.execPath,
    osdArgs: [fakeOsd],
    startupTimeoutMs: 5_000,
    stopTimeoutMs: 1_000,
  });
  managers.push(manager);
  return manager;
}

async function whoami(manager, instanceId) {
  const { url, token } = manager.getWorkerAccess(instanceId);
  const response = await fetch(`${url}/v1/whoami`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
  return response.json();
}

test("starts isolated workers with separate state, workspace, port, and token", async () => {
  const manager = await makeManager();
  const first = await manager.ensureWorker({ instanceId: "user-a", userId: "a" });
  const second = await manager.ensureWorker({ instanceId: "user-b", userId: "b" });

  assert.equal(first.status, "running");
  assert.equal(second.status, "running");
  assert.notEqual(first.workspaceDir, second.workspaceDir);
  assert.notEqual(first.stateDir, second.stateDir);
  assert.notEqual(first.port, second.port);
  assert.notDeepEqual(await whoami(manager, "user-a"), await whoami(manager, "user-b"));
  assert.notEqual(manager.getWorkerAccess("user-a").token, manager.getWorkerAccess("user-b").token);
  assert.equal(manager.getWorker("user-a").token, undefined);
});

test("stops and restarts one worker without changing the other", async () => {
  const manager = await makeManager();
  const first = await manager.ensureWorker({ instanceId: "user-a", userId: "a" });
  const second = await manager.ensureWorker({ instanceId: "user-b", userId: "b" });
  const firstWorkspace = first.workspaceDir;
  const secondAccess = manager.getWorkerAccess("user-b");

  await manager.stopWorker("user-a");
  assert.equal(manager.getWorker("user-a").status, "stopped");
  await assert.rejects(fetch(`${first.url}/v1/health`), /fetch failed|ECONNREFUSED|terminated/i);

  const secondHealth = await fetch(`${secondAccess.url}/v1/health`);
  assert.equal(secondHealth.status, 200);

  const restarted = await manager.restartWorker("user-a");
  assert.equal(restarted.status, "running");
  assert.equal(restarted.workspaceDir, firstWorkspace);
  assert.notEqual(restarted.port, first.port);
  assert.equal((await fetch(`${secondAccess.url}/v1/health`)).status, 200);
  assert.equal(second.workspaceDir, manager.getWorker("user-b").workspaceDir);
});

test("rejects unsafe instance ids and prevents ownership reassignment", async () => {
  const manager = await makeManager();
  await assert.rejects(
    manager.ensureWorker({ instanceId: "../other", userId: "a" }),
    /instanceId/,
  );
  await manager.ensureWorker({ instanceId: "user-a", userId: "a" });
  await assert.rejects(
    manager.ensureWorker({ instanceId: "user-a", userId: "b" }),
    /another user/,
  );
});
