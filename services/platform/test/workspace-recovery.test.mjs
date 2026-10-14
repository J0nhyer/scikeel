import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, stat, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const context = { userId: "a", instanceId: "user-a", generation: 1 };
const report = (state = "healthy") => ({ context: { instanceId: "user-a", generation: 1 }, state,
  activity: "unknown", canRestart: false, retryAfterMs: 0 });
async function fixture(t, probe) {
  const { WorkspaceRecovery } = await import("../src/workspace-recovery.mjs");
  const rootDir = await mkdtemp(join(tmpdir(), "scikeel-recovery-"));
  let now = 1000;
  const owner = new WorkspaceRecovery({ rootDir, now: () => now, probe });
  t.after(async () => { owner.dispose(); await rm(rootDir, { recursive: true, force: true }); });
  return { owner, rootDir, advance: value => { now += value; }, create: () => new WorkspaceRecovery({ rootDir, now: () => now, probe }) };
}

test("liveness coalesces callers and expiry never polls without a caller", async t => {
  let calls = 0; let resolve;
  const f = await fixture(t, async () => { calls++; return new Promise(done => { resolve = done; }); });
  const a = f.owner.check(context); const b = f.owner.check(context);
  await new Promise(done => setImmediate(done));
  assert.equal(calls, 1); resolve(report());
  assert.deepEqual(await a, await b);
  await f.owner.check(context); assert.equal(calls, 1);
  f.advance(6000); await new Promise(done => setImmediate(done)); assert.equal(calls, 1);
  const next = f.owner.check(context); await new Promise(done => setImmediate(done));
  assert.equal(calls, 2); resolve(report()); await next;
});

test("one failure grants no restart; repeated verified runtime failure is generation scoped", async t => {
  let state = "unreachable";
  const f = await fixture(t, async () => report(state));
  assert.equal((await f.owner.check(context)).canRestart, false);
  f.advance(500); assert.equal((await f.owner.check(context)).canRestart, false);
  f.advance(1000); const failed = await f.owner.check(context);
  assert.equal(failed.state, "unresponsive"); assert.equal(failed.canRestart, true);
  state = "healthy"; await f.owner.check(context);
  f.owner.invalidate(context); state = "unreachable";
  assert.equal((await f.owner.check(context)).canRestart, false);
});

test("unverified identity never becomes restart authority", async t => {
  const f = await fixture(t, async () => report("unknown"));
  await f.owner.check(context); f.advance(2000);
  const value = await f.owner.check(context);
  assert.equal(value.state, "unknown"); assert.equal(value.canRestart, false);
});

test("maintenance never grants restart authority and old failures do not leak into another generation", async t => {
  const f = await fixture(t, async input => ({ ...report("unreachable"), context: { instanceId: input.instanceId, generation: input.generation }, activity: "maintenance" }));
  await f.owner.check(context); f.advance(2000);
  assert.equal((await f.owner.check(context)).canRestart, false);
  assert.equal((await f.owner.check({ ...context, generation: 2 })).state, "unreachable");
});

test("cached health is invalidated without probing until the next caller", async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return report(); });
  await f.owner.check(context); f.owner.invalidate(context);
  assert.equal(calls, 1); await f.owner.check(context); assert.equal(calls, 2);
});

test("probe deadline covers an unresolved body and invalidation rejects late publication", async t => {
  const f = await fixture(t, async () => new Promise(() => {}));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = f.owner.check(context);
  await new Promise(done => setImmediate(done));
  t.mock.timers.tick(10000);
  assert.equal((await pending).canRestart, false);
  let resolve;
  const g = await fixture(t, () => new Promise(done => { resolve = done; }));
  const obsolete = g.owner.check(context); await new Promise(done => setImmediate(done));
  g.owner.invalidate(context); resolve(report());
  await assert.rejects(obsolete, error => error.code === "stale_workspace_context");
});

test("replacement reservation persists across owners and errors retain the cooldown", async t => {
  const f = await fixture(t, async () => report());
  await f.owner.reserveReplacement(context);
  assert.equal((await stat(join(f.rootDir, "recovery", "user-a.json"))).mode & 0o777, 0o600);
  assert.equal((await stat(join(f.rootDir, "recovery"))).mode & 0o777, 0o700);
  const other = f.create(); t.after(() => other.dispose());
  assert.equal(await other.cooldown(context), 60000);
  await assert.rejects(other.reserveReplacement(context), error => error.code === "workspace_recovery_cooldown");
  f.advance(60000); await other.reserveReplacement({ ...context, generation: 2 });
  assert.equal(await f.owner.cooldown(context), 60000);
});

test("corrupt, foreign, backward-clock or unwritable recovery records fail closed", async t => {
  const f = await fixture(t, async () => report());
  await mkdir(join(f.rootDir, "recovery"));
  const path = join(f.rootDir, "recovery", "user-a.json");
  for (const text of ["broken", JSON.stringify({ version: 1, ...context, userId: "b", reservedAt: 1000 }),
    JSON.stringify({ version: 1, ...context, reservedAt: 2000 })]) {
    await writeFile(path, text);
    await assert.rejects(f.owner.reserveReplacement(context), error => error.code === "workspace_cleanup_unverified");
  }
  await rm(path); await mkdir(path);
  await assert.rejects(f.owner.reserveReplacement(context), error => error.code === "workspace_cleanup_unverified");
});

test("recovery failures expose only fixed messages and validated fields", async () => {
  const { recoveryError } = await import("../src/workspace-recovery.mjs");
  const error = recoveryError("workspace_recovery_cooldown", { context: report().context,
    action: "wait", retryAfterMs: 1234, token: "secret", error: "private path" });
  assert.equal(error.statusCode, 503); assert.equal(error.failure.retryAfterMs, 1234);
  assert.equal(error.failure.token, undefined); assert.ok(!error.message.includes("private"));
  assert.throws(() => recoveryError("arbitrary"));
});
