import test from "node:test";
import assert from "node:assert/strict";
import { assertScopeLimits, parseCgroupLimit } from "../../../scripts/dev/sandbox-probe.mjs";
import { createSandboxRig, validateTestConfig } from "../fixtures/sandbox-rig.mjs";

test("a successful command is insufficient without enforced limits", () => {
  const limits = { memoryMax: 1073741824, swapMax: 134217728,
    pidsMax: 256, cpuMax: "100000 100000", childrenOwned: true };
  assert.doesNotThrow(() => assertScopeLimits(limits));
  for (const override of [{ memoryMax: "max" }, { swapMax: undefined },
    { memoryMax: 0 }, { pidsMax: 257 }, { cpuMax: "max 100000" },
    { cpuMax: "0 100000" }, { cpuMax: "200000 100000" },
    { cpuMax: "100000 0" }, { childrenOwned: false }, { childrenOwned: "true" }]) {
    assert.throws(() => assertScopeLimits({ ...limits, ...override }), /unenforced/);
  }
});

test("cgroup values are parsed without treating max or missing data as zero", () => {
  assert.equal(parseCgroupLimit("1073741824\n"), 1073741824);
  for (const value of ["max", "", undefined, "-1", "1e9", "9007199254740992"])
    assert.throws(() => parseCgroupLimit(value), /invalid cgroup/);
});

test("a requested integration case cannot silently skip missing configuration", async () => {
  await assert.rejects(createSandboxRig({ caseName: "preflight", configPath:
    "/etc/scikeel/nonexistent-sandbox-test.json" }), /prerequisite.*configuration/);
  await assert.rejects(createSandboxRig({ caseName: "production" }), /unsupported case/);
});

test("synthetic config rejects production identities, floating images and embedded secrets", () => {
  const config = { schema: 1, synthetic: true, accountPrefix: "sandbox-test-",
    launcherSocket: "/run/scikeel/sandbox-test.sock", imageDigest: `sha256:${"a".repeat(64)}` };
  assert.equal(validateTestConfig(config), config);
  for (const patch of [{ synthetic: false }, { accountPrefix: "user-" },
    { imageDigest: "science:latest" }, { launcherSocket: "relative.sock" },
    { models: { apiKey: "synthetic-only" } }])
    assert.throws(() => validateTestConfig({ ...config, ...patch }), /prerequisite/);
});
test("preflight uses the actual four-operation launcher protocol and reconciles its two bounded tenants", async (t) => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "scikeel-rig-")); t.after(() => rm(root, { recursive: true, force: true }));
  const config = { schema: 1, synthetic: true, accountPrefix: "sandbox-test-", launcherSocket: "/run/scikeel/test.sock", imageDigest: `sha256:${"a".repeat(64)}` };
  const configPath = join(root, "test.json"); await writeFile(configPath, JSON.stringify(config));
  const calls = [];
  const client = { register: async (input) => { calls.push(["register",input]); return { ...input,generation:1 }; },
    start: async (input) => { calls.push(["start",input]); return {}; },
    inspect: async (input) => ({ ...input,generation:1,status:"ready",imageDigest:config.imageDigest,
      limits:{memoryMax:1073741824,swapMax:134217728,pidsMax:256,cpuQuota:100000,cpuPeriod:100000,owned:true},
      quota:{enforced:true,byteLimit:67108864,inodeLimit:1024} }),
    stop: async (input) => { calls.push(["stop",input]); } };
  const rig = await createSandboxRig({ caseName:"preflight",configPath,client,
    inspectConfig:async()=>({isFile:()=>true,uid:0,mode:0o644,size:1024}) });
  assert.equal(rig.evidence.tenants.length,2);
  assert.equal(calls.filter(([operation])=>operation==="start").length,2);
  await rig.close();
  assert.equal(calls.filter(([operation])=>operation==="stop").length,2);
});
