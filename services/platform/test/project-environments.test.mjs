import test from "node:test";
import assert from "node:assert/strict";
import { selectPythonEnvironment, ProjectEnvironments } from "../src/project-environments.mjs";
import { EnvironmentApprovals } from "../src/environment-approvals.mjs";

const base = { owned: true, imageDigest: `sha256:${"a".repeat(64)}`, basePython: "/opt/scikeel/science/bin/python", projectDir: "/tenant/project" };
test("projects use the common science baseline until a valid private environment exists", () => {
  assert.deepEqual(selectPythonEnvironment({ ...base, venvState: "absent" }), { kind: "base", python: base.basePython, imageDigest: base.imageDigest });
  assert.equal(selectPythonEnvironment({ ...base, venvState: "valid", venvPython: "/tenant/project/.venv/bin/python" }).kind, "private");
  for (const patch of [{ owned: false, venvState: "absent" }, { venvState: "broken" }, { venvState: "external" },
    { venvState: "valid", venvPython: "/peer/.venv/bin/python" }, { venvState: "valid", venvPython: "/tenant/project/../peer/python" },
    { venvState: "absent", basePython: "/usr/bin/python" }, { venvState: "absent", imageDigest: "latest" }])
    assert.throws(() => selectPythonEnvironment({ ...base, ...patch }));
});

function fixture() {
  const context = { userId: "a", instanceId: "user-a", generation: 1, sessionId: "session-a", projectId: "project-a", operation: "install", inputHash: "a".repeat(64) };
  const approvals = new EnvironmentApprovals(); const events = []; let currentHash = context.inputHash;
  const files = { inspect: async () => ({ ...base, venvState:"absent", inputHash:currentHash }),
    stage: async () => { events.push("stage"); return { stageId:"stage-a", inputHash:currentHash, imageDigest:base.imageDigest,
      lockHash:"b".repeat(64), standalone:true, stableInterpreter:true, validated:true, inventory:[{name:"fixture",version:"1.0"}] }; },
    publish: async () => { events.push("publish"); return { ...base, venvState:"valid",venvPython:"/tenant/project/.venv/bin/python" }; },
    discard: async () => events.push("discard") };
  const environments = new ProjectEnvironments({ approvals, files });
  const grant = () => { const record=approvals.request({ ...context, expiresAt:Date.now()+60000 });
    approvals.approve({id:record.id,actor:context,manual:true});return {...context,id:record.id}; };
  return { context, approvals, events, files, environments, grant, changeInput:()=>currentHash="c".repeat(64) };
}
test("managed installs validate immutable input and publish only a verified standalone environment", async () => {
  const f=fixture(); const request=f.grant();
  const installed=await f.environments.install(request);
  assert.equal(installed.selection.kind,"private");assert.equal(installed.record.lockHash,"b".repeat(64));
  assert.deepEqual(f.events,["stage","publish"]);
  await assert.rejects(f.environments.install(request),/approval/);
});
test("modified inputs and active environment leases cannot start or publish an install", async () => {
  const f=fixture();const request=f.grant();f.changeInput();
  await assert.rejects(f.environments.install(request),/input/);assert.deepEqual(f.events,[]);
  const g=fixture();const lease=g.environments.retain(g.context);
  await assert.rejects(g.environments.install(g.grant()),/busy/);assert.deepEqual(g.events,[]);
  lease.release();await g.environments.install(g.grant());
});
test("failed staging cannot replace the prior interpreter and always releases the install lock", async () => {
  const f=fixture();const stage=f.files.stage;
  f.files.stage=async()=>{throw new Error("network failed");};
  await assert.rejects(f.environments.install(f.grant()),/network/);assert.ok(!f.events.includes("publish"));
  f.files.stage=stage;await f.environments.install(f.grant());assert.equal(f.events.at(-1),"publish");
});
test("inventory or stale staging identities cause disposal rather than environment publication", async () => {
  const f=fixture();const stage=f.files.stage;
  f.files.stage=async()=>({...await stage(),stableInterpreter:false});
  await assert.rejects(f.environments.install(f.grant()),/unverified/);
  assert.deepEqual(f.events,["stage","discard"]);
});
