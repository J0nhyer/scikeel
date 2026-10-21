import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { HostAdmission, hostPressure } from "../src/host-admission.mjs";

test("sandbox lifetime and heavy builds cannot acquire the same kernel lock", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "scikeel-admission-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const admission = new HostAdmission({ lockPath: join(root, "build.lock") });
  const first = await admission.acquire(); t.after(() => first.release());
  assert.equal(spawnSync("/usr/bin/flock", ["-n", join(root, "build.lock"), "/usr/bin/true"]).status, 1);
  await assert.rejects(admission.acquire(), error=>error.capacityReason==="build_lock" && error.failure.retryAfterMs===5000);
  await first.release(); await first.release();
  const second = await admission.acquire(); await second.release();
});
test("cancelled admission cannot hold a host resource lock", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "scikeel-admission-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const admission = new HostAdmission({ lockPath: join(root, "build.lock") });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(admission.acquire({ signal: controller.signal }), /cancel/);
  const lease = await admission.acquire(); await lease.release();
});
test('resident environments share admission while excluding heavy builds',async t=>{
  const root=await mkdtemp(join(tmpdir(),'scikeel-admission-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const admission=new HostAdmission({lockPath:join(root,'build.lock')});
  const first=await admission.acquire({shared:true});t.after(()=>first.release());
  const second=await admission.acquire({shared:true});t.after(()=>second.release());
  assert.equal(spawnSync('/usr/bin/flock',['-n',join(root,'build.lock'),'/usr/bin/true']).status,1);
  await first.release();
  assert.equal(spawnSync('/usr/bin/flock',['-n',join(root,'build.lock'),'/usr/bin/true']).status,1);
  await second.release();
  assert.equal(spawnSync('/usr/bin/flock',['-n',join(root,'build.lock'),'/usr/bin/true']).status,0);
});
test("host pressure comes from available kernel memory rather than total memory", async () => {
  const pressure = await hostPressure();
  assert.ok(Number.isSafeInteger(pressure.availableBytes));
  assert.equal(pressure.buildActive, false);
});
