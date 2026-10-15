import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { AssistantPolicy } from "../src/assistant-policy.mjs";

async function policyFixture(options = {}) {
  const events = [];
  let saved = structuredClone(options.state ?? { schema: 1, activeRuntime: "opencode", revision: 1,
    transition: null, receipts: [], executions: {} });
  const policy = new AssistantPolicy({ state: structuredClone(saved),
    persist: async value => { await options.beforePersist?.(value); saved = structuredClone(value); events.push(["persist", structuredClone(value)]); await options.afterPersist?.(value); },
    load: async () => { await options.beforeLoad?.(); return structuredClone(saved); },
    prepare: async runtime => { events.push(["prepare", runtime]); await options.prepare?.(runtime); },
    revoke: async input => { events.push(["revoke", input]); await options.revoke?.(input); },
    inventory: options.inventory ?? (async () => ({ activeExecutions: [], uncertainEffects: [] })),
  });
  await policy.init();
  return { policy, events, saved: () => structuredClone(saved) };
}

const turn = { userId: "owner_a", instanceId: "instance_a", generation: 2, conversationId: "conversation_a",
  execution: 3, requestId: "send_a", policyRevision: 1, runtime: "opencode" };
const selection = { runtime: "codex", expectedRevision: 1, operationId: "select_codex" };

test("exclusive policy selection cannot pass an admitted execution until verified cleanup settles its lease", async () => {
  const { policy, saved } = await policyFixture();
  const reservation = { owned: true };
  const lease = await policy.admit(turn, async () => reservation);
  assert.equal(lease.reservation, reservation);
  assert.equal(Object.keys(saved().executions).length, 1, "Admission must be durable before user effects");
  await assert.rejects(policy.select(selection), { code: "assistant_busy" });
  await lease.settle({ cleanupVerified: true });
  await lease.settle({ cleanupVerified: true });
  const selected = await policy.select(selection);
  assert.equal(selected.activeRuntime, "codex"); assert.equal(selected.revision, 2);
  assert.equal(Object.keys(saved().executions).length, 0);
});

test("switch acknowledgement replay is idempotent while changed payloads and stale revisions cannot mutate selection", async () => {
  const { policy, events } = await policyFixture();
  const first = await policy.select(selection), count = events.length;
  assert.deepEqual(await policy.select(selection), first);
  assert.equal(events.length, count);
  await assert.rejects(policy.select({ ...selection, runtime: "claude" }), { code: "assistant_operation_conflict" });
  await assert.rejects(policy.select({ ...selection, expectedRevision: 2 }), { code: "assistant_operation_conflict" });
  await assert.rejects(policy.select({ ...selection, operationId: "stale_other" }), { code: "assistant_revision_conflict" });
  assert.equal((await policy.describe()).activeRuntime, "codex");
});

test("stale, disabled-runtime and malformed identities cause no workspace reservation or durable admission", async () => {
  const { policy, saved } = await policyFixture();
  let calls = 0;
  for (const patch of [{ policyRevision: 0 }, { runtime: "codex" }, { generation: 0 }, { userId: "../foreign" }, { conversationId: "" }])
    await assert.rejects(policy.admit({ ...turn, ...patch }, async () => { calls++; }));
  assert.equal(calls, 0); assert.equal(Object.keys(saved().executions).length, 0);
});

test("a selection queued during reservation cannot overtake the globally registered lease", async () => {
  const { policy } = await policyFixture();
  let release, entered;
  const reserved = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const admission = policy.admit(turn, async () => { entered(); await gate; return { owned: true }; });
  await reserved;
  const switching = policy.select(selection);
  release(); const lease = await admission;
  await assert.rejects(switching, { code: "assistant_busy" });
  await lease.settle({ cleanupVerified: true });
  assert.equal((await policy.select(selection)).revision, 2);
});

test("unverified cleanup and restart retain a durable uncertainty fence even when the loaded-account inventory is empty", async () => {
  const first = await policyFixture();
  const lease = await first.policy.admit(turn, async () => ({ owned: true }));
  await lease.settle({ cleanupVerified: false });
  await assert.rejects(first.policy.select(selection), { code: "assistant_recovery_required" });
  const restarted = await policyFixture({ state: first.saved() });
  await assert.rejects(restarted.policy.select(selection), { code: "assistant_recovery_required" });
  let reserved = false;
  await assert.rejects(restarted.policy.admit({ ...turn, requestId: "send_other" }, async () => { reserved = true; }),
    { code: "assistant_recovery_required" });
  assert.equal(reserved, false); assert.equal(Object.keys(restarted.saved().executions).length, 1);
});

test("cold account activity and unknown external effects fence cutover independently of in-memory leases", async () => {
  for (const [inventory, code] of [
    [{ activeExecutions: [{ userId: "cold_owner", generation: 7 }], uncertainEffects: [] }, "assistant_busy"],
    [{ activeExecutions: [], uncertainEffects: [{ userId: "cold_owner", requestId: "unverified_write" }] }, "assistant_recovery_required"],
  ]) {
    const { policy } = await policyFixture({ inventory: async () => inventory });
    await assert.rejects(policy.select(selection), { code });
    assert.equal((await policy.describe()).activeRuntime, "opencode");
  }
});

test("preparation and initial persistence failure keep the previous committed selection without revoking it", async () => {
  for (const options of [{ prepare: async () => { throw Object.assign(Error("not ready"), { code: "assistant_unavailable" }); } },
    { beforePersist: async () => { throw Object.assign(Error("disk failure"), { code: "EIO" }); } }]) {
    const { policy, saved, events } = await policyFixture(options);
    await assert.rejects(policy.select(selection));
    assert.equal((await policy.describe()).activeRuntime, "opencode");
    assert.equal(saved().revision, 1); assert.equal(saved().transition, null);
    assert(!events.some(([kind]) => kind === "revoke"));
  }
});

test("the pending cutover is durable before revocation and failed commit recovers without dual admission", async () => {
  let writes = 0;
  const first = await policyFixture({ beforePersist: async () => { if (++writes === 2) throw Error("commit acknowledgement lost"); } });
  await assert.rejects(first.policy.select(selection));
  const saved = first.saved();
  assert(saved.transition, "An uncertain committed boundary must be recoverable");
  const prepared = first.events.findIndex(([kind, state]) => kind === "persist" && state.transition);
  const revoked = first.events.findIndex(([kind]) => kind === "revoke");
  assert(prepared >= 0 && revoked > prepared);
  await assert.rejects(first.policy.admit(turn, async () => ({})), { code: "assistant_recovery_required" });
  const restarted = await policyFixture({ state: saved });
  assert.equal((await restarted.policy.describe()).activeRuntime, "codex");
  assert.equal((await restarted.policy.describe()).revision, 2);
  assert.equal(restarted.saved().transition, null);
  assert(restarted.events.some(([kind]) => kind === "revoke"));
  await assert.rejects(restarted.policy.admit(turn, async () => ({})), { code: "assistant_revision_conflict" });
});

test("a lost durable commit acknowledgement is reconciled before returning the identical operation receipt", async () => {
  let writes = 0;
  const { policy, saved } = await policyFixture({ afterPersist: async () => { if (++writes === 2) throw Error("lost disk acknowledgement"); } });
  await assert.rejects(policy.select(selection), { code: "assistant_persistence_uncertain" });
  assert.equal(saved().activeRuntime, "codex");
  await assert.rejects(policy.admit(turn, async () => ({})), { code: "assistant_recovery_required" });
  assert.equal(typeof policy.reconcile, "function", "Unknown persistence must be reconciled against the same durable store");
  await policy.reconcile();
  const receipt = await policy.select(selection);
  assert.equal(receipt.activeRuntime, "codex"); assert.equal(receipt.revision, 2);
  assert.equal(writes, 2, "Receipt replay cannot create another transition or execution");
});

test("a failed policy reload cannot reopen admission after uncertain persistence", async () => {
  const { policy } = await policyFixture({ beforePersist: async () => { throw Error("uncertain write"); },
    beforeLoad: async () => { throw Error("unreadable durable store"); } });
  await assert.rejects(policy.select(selection), { code: "assistant_persistence_uncertain" });
  assert.equal(typeof policy.reconcile, "function", "Unknown persistence must retain a recovery operation");
  await assert.rejects(policy.reconcile(), { code: "assistant_recovery_required" });
  await assert.rejects(policy.admit(turn, async () => ({})), { code: "assistant_recovery_required" });
});

test("failed reconciliation revocation remains mandatory on every subsequent recovery attempt", async () => {
  let writes = 0, revocations = 0, failing = false;
  const { policy } = await policyFixture({ afterPersist: async () => { if (++writes === 2) throw Error("lost disk acknowledgement"); },
    revoke: async () => { revocations++; if (failing) throw Error("revocation not confirmed"); } });
  await assert.rejects(policy.select(selection), { code: "assistant_persistence_uncertain" });
  failing = true;
  await assert.rejects(policy.reconcile(), { code: "assistant_recovery_required" });
  await assert.rejects(policy.reconcile(), { code: "assistant_recovery_required" });
  assert.equal(revocations, 3, "A failed cleanup cannot be forgotten by adopting a newer in-memory revision");
  failing = false;
  await policy.reconcile();
  assert.equal(revocations, 4);
  assert.equal((await policy.describe()).recoveryRequired, false);
});

test("a failed reservation retains uncertainty but another account can continue on the same committed assistant", async () => {
  const { policy, saved } = await policyFixture();
  await assert.rejects(policy.admit(turn, async () => { throw Error("reservation ownership is not confirmed"); }));
  assert.equal(Object.values(saved().executions)[0].status, "unknown");
  await assert.rejects(policy.admit({ ...turn, requestId: "send_other" }, async () => ({})), { code: "assistant_recovery_required" });
  const other = await policy.admit({ ...turn, userId: "other_owner", instanceId: "other_instance" }, async () => ({}));
  await other.settle({ cleanupVerified: true });
  await assert.rejects(policy.select(selection), { code: "assistant_recovery_required" });
});

test("failed revocation retains the durable cutover and never leaks private failure details", async () => {
  const { policy, saved } = await policyFixture({ revoke: async () => { throw Error("synthetic-private-revocation-canary"); } });
  const failure = await policy.select(selection).then(() => null, error => error);
  assert.equal(failure?.code, "assistant_recovery_required");
  assert(!failure.message.includes("synthetic-private"));
  assert(saved().transition);
  await assert.rejects(policy.admit(turn, async () => ({})), { code: "assistant_recovery_required" });
});

test("an effect discovered during revocation blocks final commit and admission", async () => {
  let unknown = false;
  const { policy, saved } = await policyFixture({ revoke: async () => { unknown = true; }, inventory: async () => ({
    activeExecutions: [], uncertainEffects: unknown ? [{ userId: "cold_owner", requestId: "late_effect" }] : [],
  }) });
  await assert.rejects(policy.select(selection), { code: "assistant_recovery_required" });
  assert.equal(saved().activeRuntime, "opencode"); assert(saved().transition);
  await assert.rejects(policy.admit(turn, async () => ({})), { code: "assistant_recovery_required" });
});

test("a target that loses readiness before commit stays pending without leaking preparation failures", async () => {
  let revoked = false;
  const { policy, saved } = await policyFixture({ revoke: async () => { revoked = true; },
    prepare: async () => { if (revoked) throw Error("synthetic-private-profile-canary"); } });
  const failure = await policy.select(selection).then(() => null, error => error);
  assert.equal(failure?.code, "assistant_unavailable"); assert(!failure.message.includes("synthetic-private"));
  assert.equal(saved().activeRuntime, "opencode"); assert(saved().transition);
});

for (const [label, corrupt] of [
  ["unknown receipt fields", state => { state.receipts[0].hidden = true; }],
  ["mismatched receipt operation", state => { state.receipts[0].result.operationId = "different_operation"; }],
  ["mismatched receipt payload", state => { state.receipts[0].result.activeRuntime = "claude"; }],
  ["duplicate receipt identity", state => { state.receipts.push(structuredClone(state.receipts[0])); }],
  ["unrecognized execution fields", state => { state.executions.lease_a.extra = true; }],
  ["unrecognized turn identity fields", state => { state.executions.lease_a.identity.extra = true; }],
  ["foreign execution policy", state => { state.executions.lease_a.identity.runtime = "claude"; }],
  ["stale execution revision", state => { state.executions.lease_a.identity.policyRevision = 1; }],
  ["invalid persisted turn identity", state => { state.executions.lease_a.identity.userId = "../foreign"; }],
  ["unrecognized pending transition fields", state => {
    state.executions = {}; state.receipts = []; state.transition = { ...selection, expectedRevision: 2,
      payloadHash: createHash("sha256").update(JSON.stringify([selection.runtime, 2])).digest("hex"), hidden: true };
  }],
]) test(`corrupt durable assistant policy rejects ${label} before callbacks`, async () => {
  const committed = await policyFixture(); await committed.policy.select(selection);
  const state = committed.saved();
  state.executions.lease_a = { status: "active", identity: { ...turn, runtime: "codex", policyRevision: 2 } };
  corrupt(state);
  let callbacks = 0;
  assert.throws(() => new AssistantPolicy({ state, persist: async () => { callbacks++; },
    prepare: async () => { callbacks++; }, revoke: async () => { callbacks++; }, inventory: async () => { callbacks++; } }),
  { code: "invalid_assistant_policy", status: 503 });
  assert.equal(callbacks, 0);
});
