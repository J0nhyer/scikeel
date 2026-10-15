import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { CliRuntimeManager } from "../src/cli-runtime.mjs";
import { ModelBroker } from "../src/model-broker.mjs";

for (const version of [1, 2, 3, 4]) test(`runtime format ${version} migration keeps one configured default despite historical user choices`, async t => {
  const rootDir = await mkdtemp(join(tmpdir(), "scikeel-assistant-migration-"));
  const legacy = version === 1 ? { version, runtime: "codex" } : {
    version, defaultRuntime: "opencode", userRuntimes: { owner_a: "codex", owner_b: "claude" },
    userModels: { owner_a: { codex: "gpt-6.1-sol" } },
    managedRuntimes: { codex: { models: ["gpt-6.1-sol"], defaultModel: "gpt-6.1-sol" }, claude: { models: ["fixture-claude"], defaultModel: "fixture-claude" } },
    assistantEnabled: { codex: true, claude: true },
  };
  await writeFile(join(rootDir, "runtime.json"), JSON.stringify(legacy), { mode: 0o600 });
  const profileResolver = { refresh: async runtime => ({ runtime, status: "ready", enabledByProfile: true,
    models: [{ id: runtime === "codex" ? "gpt-6.1-sol" : "fixture-claude", variants: {} }],
    defaultModel: runtime === "codex" ? "gpt-6.1-sol" : "fixture-claude", identityRevision: "fixture-private-revision", catalogRevision: "fixture-catalog" }) };
  const manager = new CliRuntimeManager({ rootDir, runtime: "opencode", profileResolver });
  t.after(async () => { await manager.close(); await rm(rootDir, { recursive: true, force: true }); });
  await manager.init();
  for (const userId of ["owner_a", "owner_b", "new_owner"]) assert.equal(manager.runtimeForUser(userId), "opencode");
  const description = manager.adminDescribe();
  assert.equal(description.activeRuntime, "opencode");
  assert.equal(description.revision, 1);
  assert.deepEqual(description.available.filter(option => option.enabled).map(option => option.runtime), ["opencode"]);
  const persisted = JSON.parse(await readFile(join(rootDir, "runtime.json"), "utf8"));
  assert.equal(persisted.version, 5);
  if (version > 1) assert.deepEqual(persisted.userRuntimes, legacy.userRuntimes, "Historical choices are retained as data, never admission authority");
});

async function fixture(t, callbacks = {}) {
  const rootDir = await mkdtemp(join(tmpdir(), "scikeel-policy-store-"));
  const profileResolver = { refresh: async runtime => ({ runtime, status: "ready", enabledByProfile: true,
    models: [{ id: "gpt-6.1-sol", variants: {} }], defaultModel: "gpt-6.1-sol", identityRevision: "fixture-identity", catalogRevision: "fixture-catalog" }) };
  const events = [];
  const options = { rootDir, runtime: "opencode", profileResolver, assistantAuthority: {
    prepare: async runtime => { events.push(["prepare", runtime]); await callbacks.prepare?.(runtime); },
    revoke: async input => { events.push(["revoke", input]); await callbacks.revoke?.(input); },
    inventory: callbacks.inventory ?? (async () => ({ activeExecutions: [], uncertainEffects: [] })),
  } };
  let manager = new CliRuntimeManager(options);
  t.after(async () => { await manager.close(); await rm(rootDir, { recursive: true, force: true }); });
  await manager.init();
  return { rootDir, events, manager, restart: async () => { await manager.close(); manager = new CliRuntimeManager(options); await manager.init(); return manager; } };
}

test("the manager persists policy selection and model preferences in one versioned file across restart", async t => {
  const f = await fixture(t), selection = { runtime: "codex", expectedRevision: 1, operationId: "select_codex" };
  assert.equal(typeof f.manager.selectAssistant, "function", "The existing runtime manager must own selection persistence");
  const receipt = await f.manager.selectAssistant(selection);
  assert.deepEqual(receipt, { activeRuntime: "codex", revision: 2, operationId: "select_codex" });
  await f.manager.setUserModel("owner_a", "codex", "gpt-6.1-sol");
  const persisted = JSON.parse(await readFile(join(f.rootDir, "runtime.json"), "utf8"));
  assert.equal(persisted.version, 5); assert.equal(persisted.assistantPolicy.activeRuntime, "codex");
  assert.equal(persisted.assistantPolicy.revision, 2); assert.equal(persisted.userModels.owner_a.codex, "gpt-6.1-sol");
  const restarted = await f.restart();
  assert.equal(restarted.runtimeForUser("new_owner"), "codex");
  assert.deepEqual(await restarted.selectAssistant(selection), receipt);
  assert.equal(restarted.adminDescribe().revision, 2);
});

test("an Admin description queued during cutover reports one consistent committed snapshot", async t => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const revoking = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { revoke: async () => { entered(); await gate; } });
  const switching = f.manager.selectAssistant({ runtime: "codex", expectedRevision: 1, operationId: "queued-description" });
  await revoking;
  const reading = f.manager.freshAdminDescribe();
  await new Promise(resolve => setImmediate(resolve));
  release();
  await switching;
  const description = await reading;
  assert.equal(description.activeRuntime, "codex");
  assert.equal(description.defaultRuntime, "codex");
  assert.equal(description.revision, 2);
  assert.deepEqual(description.assistantEnabled, { claude: false, codex: true });
  assert.deepEqual(description.available.filter(option => option.enabled).map(option => option.runtime), ["codex"]);
});

test("the synchronous broker snapshot fails closed for pending cutover, unknown owned effects and shutdown", async t => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const revoking = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { revoke: async () => { entered(); await gate; } });
  assert.equal(typeof f.manager.assistantSnapshot, "function", "Broker checks need committed policy, not a caller-supplied selection");
  assert.deepEqual(f.manager.assistantSnapshot("owner_a"), { activeRuntime: "opencode", revision: 1, recoveryRequired: false });
  const switching = f.manager.selectAssistant({ runtime: "codex", expectedRevision: 1, operationId: "snapshot-cutover" });
  await revoking;
  assert.deepEqual(f.manager.assistantSnapshot("owner_a"), { activeRuntime: "opencode", revision: 1, recoveryRequired: true });
  release(); await switching;
  const lease = await f.manager.assistantPolicy.admit({ userId: "owner_a", instanceId: "instance_a", generation: 1,
    conversationId: "conversation_a", execution: 1, requestId: "request_a", policyRevision: 2, runtime: "codex" }, async () => ({}));
  await lease.settle({ cleanupVerified: false });
  assert.equal(f.manager.assistantSnapshot("owner_a").recoveryRequired, true);
  assert.equal(f.manager.assistantSnapshot("owner_b").recoveryRequired, false, "Owned uncertainty does not disable other accounts");
  await f.manager.close();
  assert.equal(f.manager.assistantSnapshot("owner_b").recoveryRequired, true);
});

test("durable global selection revokes actual broker inference without reviving old grants on switch-back", async t => {
  let broker, contacts = 0;
  const f = await fixture(t, { revoke: input => broker.revokeAssistant(input),
    inventory: async () => ({ activeExecutions: broker?.inferenceInventory() ?? [], uncertainEffects: [] }) });
  const upstream = createServer((_req, res) => { contacts++; res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => { upstream.closeAllConnections(); return new Promise(resolve => upstream.close(resolve)); });
  const context = { userId: "owner_a", instanceId: "instance_a", generation: 1 };
  broker = new ModelBroker({ identify: () => context, assistantPolicy: owned => f.manager.assistantSnapshot(owned.userId),
    logger: () => {}, providers: { fixture: { baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
      credential: "synthetic-integration-canary", enabledModels: ["gpt-6.1-sol"], routes: ["/v1/responses"] } } });
  t.after(() => broker.close());
  await broker.listen({ host: "127.0.0.1", port: 0 });
  const issue = (runtime, policyRevision) => broker.issue({ ...context, runtime, policyRevision,
    provider: "fixture", models: ["gpt-6.1-sol"], routes: ["/v1/responses"], expiresAt: Date.now() + 60000 });
  const request = async (token, path = "/v1/responses") => {
    const response = await fetch(`http://127.0.0.1:${broker.server.address().port}${path}`, { method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(path === "/v1/responses" ? { model: "gpt-6.1-sol", max_output_tokens: 1 } : { action: "state", sessionId: "owned" }) });
    await response.text(); return response.status;
  };
  const original = issue("opencode", 1);
  assert.equal(await request(original), 200);
  await f.manager.selectAssistant({ runtime: "codex", expectedRevision: 1, operationId: "broker-codex" });
  assert.equal(await request(original), 403);
  broker.renew(original, context);
  broker.collaborationHandler = async () => ({ state: "readable" });
  assert.equal(await request(original, "/collaboration"), 200);
  const codex = issue("codex", 2);
  assert.equal(await request(codex), 200);
  await f.manager.selectAssistant({ runtime: "opencode", expectedRevision: 2, operationId: "broker-return" });
  assert.equal(await request(original), 403); assert.equal(await request(codex), 403);
  assert.equal(await request(issue("opencode", 3)), 200);
  assert.equal(contacts, 3);
});

test("an unfinished manager cutover is durable before revocation and reconciles before reopening admission", async t => {
  let failing = true, root;
  const f = await fixture(t, { revoke: async () => {
    const stored = JSON.parse(await readFile(join(root, "runtime.json"), "utf8"));
    assert.equal(stored.assistantPolicy.transition.runtime, "codex");
    assert.equal(stored.assistantPolicy.activeRuntime, "opencode");
    if (failing) throw Error("synthetic-private-revocation-details");
  } });
  root = f.rootDir;
  assert.equal(typeof f.manager.selectAssistant, "function", "Cutover must be owned by the existing manager");
  const selection = { runtime: "codex", expectedRevision: 1, operationId: "unfinished_cutover" };
  await assert.rejects(f.manager.selectAssistant(selection), { code: "assistant_recovery_required" });
  assert.equal(f.manager.adminDescribe().recoveryRequired, true);
  failing = false;
  const restarted = await f.restart();
  assert.equal(restarted.adminDescribe().recoveryRequired, false);
  assert.equal(restarted.adminDescribe().activeRuntime, "codex");
  assert.equal((await restarted.selectAssistant(selection)).revision, 2);
});

test("legacy enabling and per-user runtime changes cannot regain selection authority", async t => {
  const { manager } = await fixture(t);
  await assert.rejects(manager.setAssistantEnabled("codex", true), { code: "assistant_selection_migrated", status: 409 });
  await assert.rejects(manager.setUserRuntime("owner_a", "codex", "gpt-6.1-sol"), { code: "assistant_selection_admin_only", status: 403 });
  assert.equal(manager.runtimeForUser("owner_a"), "opencode");
});

test("a profile catalog alone cannot make an unmeasured assistant selectable", async t => {
  const { rootDir, manager } = await fixture(t);
  await manager.close();
  const unmeasured = new CliRuntimeManager({ rootDir, runtime: "opencode", profileResolver: manager.profileResolver,
    assistantAuthority: { inventory: async () => ({ activeExecutions: [], uncertainEffects: [] }) } });
  t.after(() => unmeasured.close());
  await unmeasured.init();
  assert.equal(typeof unmeasured.selectAssistant, "function", "Readiness must be separate from catalog presence");
  await assert.rejects(unmeasured.selectAssistant({ runtime: "codex", expectedRevision: 1, operationId: "unmeasured_target" }),
    { code: "assistant_unavailable", status: 503 });
  assert.equal(unmeasured.adminDescribe().activeRuntime, "opencode");
});

test("manager policy persistence syncs the private file before rename and its directory before acknowledgement", async t => {
  const events = [], open = fs.open, rename = fs.rename;
  fs.open = async function(path, ...args) {
    const file = await open.call(this, path, ...args), sync = file.sync;
    const target = String(path);
    file.sync = async function(...values) {
      if (target.includes("runtime.json.") && target.endsWith(".tmp")) events.push(["file_sync", (await file.stat()).mode & 0o777]);
      else if (target.includes("scikeel-policy-store-")) events.push(["directory_sync"]);
      return sync.apply(this, values);
    };
    return file;
  };
  fs.rename = async function(source, destination) {
    if (String(destination).endsWith("/runtime.json")) events.push(["rename"]);
    return rename.call(this, source, destination);
  };
  t.after(() => { fs.open = open; fs.rename = rename; });
  const { manager } = await fixture(t);
  assert.deepEqual(events, [["file_sync", 0o600], ["rename"], ["directory_sync"]],
    "Version migration must be durable, not only a successful rename");
  events.length = 0;
  await manager.selectAssistant({ runtime: "codex", expectedRevision: 1, operationId: "durable_selection" });
  assert.deepEqual(events, [["file_sync", 0o600], ["rename"], ["directory_sync"],
    ["file_sync", 0o600], ["rename"], ["directory_sync"]], "Both pending and committed policy boundaries must be durable");
});

test("an uncertain policy commit cannot be overwritten by an ordinary configuration save before reconciliation", async t => {
  const f = await fixture(t), open = fs.open;
  let syncs = 0;
  fs.open = async function(path, ...args) {
    const file = await open.call(this, path, ...args);
    if (String(path) === f.rootDir) {
      const sync = file.sync;
      file.sync = async function(...values) {
        if (++syncs === 2) throw Error("synthetic directory acknowledgement failure");
        return sync.apply(this, values);
      };
    }
    return file;
  };
  t.after(() => { fs.open = open; });
  const selection = { runtime: "codex", expectedRevision: 1, operationId: "uncertain_disk_commit" };
  await assert.rejects(f.manager.selectAssistant(selection), { code: "assistant_persistence_uncertain" });
  const committed = await readFile(join(f.rootDir, "runtime.json"), "utf8");
  assert.equal(JSON.parse(committed).assistantPolicy.activeRuntime, "codex");
  await assert.rejects(f.manager.persistRuntime(), { code: "assistant_recovery_required" });
  assert.equal(await readFile(join(f.rootDir, "runtime.json"), "utf8"), committed);
  assert.equal(typeof f.manager.reconcileAssistant, "function", "The same runtime store must reconcile uncertain commits");
  await f.manager.reconcileAssistant();
  assert.deepEqual(await f.manager.selectAssistant(selection), { activeRuntime: "codex", revision: 2, operationId: selection.operationId });
  await f.manager.setUserModel("owner_a", "codex", "gpt-6.1-sol");
  assert.equal(JSON.parse(await readFile(join(f.rootDir, "runtime.json"), "utf8")).assistantPolicy.revision, 2);
});

test("restart retains unknown execution fences and a closed writer cannot acknowledge an obsolete lease", async t => {
  const f = await fixture(t), old = f.manager;
  const lease = await old.assistantPolicy.admit({ userId: "owner_a", instanceId: "instance_a", generation: 1,
    conversationId: "conversation_a", execution: 1, requestId: "request_a", policyRevision: 1, runtime: "opencode" }, async () => ({}));
  const restarted = await f.restart();
  const path = join(f.rootDir, "runtime.json"), before = await readFile(path, "utf8");
  assert.equal(Object.values(JSON.parse(before).assistantPolicy.executions)[0].status, "unknown");
  await assert.rejects(restarted.selectAssistant({ runtime: "codex", expectedRevision: 1, operationId: "unsafe_after_restart" }),
    { code: "assistant_recovery_required" });
  await assert.rejects(lease.settle({ cleanupVerified: true }), { code: "assistant_persistence_uncertain" });
  await assert.rejects(old.persistRuntime(), { code: "assistant_closed" });
  await assert.rejects(old.selectAssistant({ runtime: "codex", expectedRevision: 1, operationId: "obsolete_writer" }), { code: "assistant_closed" });
  assert.equal(await readFile(path, "utf8"), before, "Only the current reader may reconcile a durable execution fence");
});

test("a failed manager cutover closes native reservation before workspace access", async t => {
  let failing = false;
  const f = await fixture(t, { revoke: async () => { if (failing) throw Error("unverified revocation"); } });
  await f.manager.selectAssistant({ runtime: "codex", expectedRevision: 1, operationId: "initial_native" });
  const session = await f.manager.createSession({ userId: "owner_a", workspaceDir: f.rootDir });
  failing = true;
  await assert.rejects(f.manager.selectAssistant({ runtime: "opencode", expectedRevision: 2, operationId: "failed_cutover" }),
    { code: "assistant_recovery_required" });
  let accessed = 0;
  f.manager.workspaceAccess = async () => { accessed++; };
  await assert.rejects(f.manager.reservePrompt({ userId: "owner_a", sessionId: session.id, text: "must not reserve" }),
    { code: "assistant_recovery_required" });
  assert.equal(accessed, 0); assert.equal(session.history.length, 0); assert.equal(f.manager.turnReservations.size, 0);
});

test("migration with a missing native profile retains history choices without promoting the legacy enable flag", async t => {
  const rootDir = await mkdtemp(join(tmpdir(), "scikeel-missing-profile-"));
  await writeFile(join(rootDir, "runtime.json"), JSON.stringify({ version: 4, defaultRuntime: "opencode",
    userRuntimes: { owner_a: "codex" }, userModels: { owner_a: { codex: "gpt-6.1-sol" } }, assistantEnabled: { codex: true, claude: false } }));
  let prepared = 0;
  const manager = new CliRuntimeManager({ rootDir, profileResolver: { refresh: async runtime => ({ runtime, status: "unavailable",
    enabledByProfile: false, models: [], defaultModel: null }) }, assistantAuthority: { prepare: async () => { prepared++; },
    revoke: async () => {}, inventory: async () => ({ activeExecutions: [], uncertainEffects: [] }) } });
  t.after(async () => { await manager.close(); await rm(rootDir, { recursive: true, force: true }); });
  await manager.init();
  assert.equal(manager.runtimeForUser("owner_a"), "opencode");
  assert.equal(manager.adminDescribe().available.find(value => value.runtime === "codex").enabled, false);
  await assert.rejects(manager.selectAssistant({ runtime: "codex", expectedRevision: 1, operationId: "missing_profile" }), { code: "assistant_unavailable" });
  assert.equal(prepared, 0);
  const stored = JSON.parse(await readFile(join(rootDir, "runtime.json"), "utf8"));
  assert.equal(stored.assistantPolicy.activeRuntime, "opencode");
  assert.equal(stored.userRuntimes.owner_a, "codex"); assert.equal(stored.userModels.owner_a.codex, "gpt-6.1-sol");
});

test("an initial file-sync failure leaves the previous policy bytes and selection intact without revocation", async t => {
  const f = await fixture(t), path = join(f.rootDir, "runtime.json"), before = await readFile(path, "utf8"), open = fs.open;
  let failing = true;
  fs.open = async function(target, ...args) {
    const file = await open.call(this, target, ...args), sync = file.sync;
    if (String(target).startsWith(path + ".")) file.sync = async function(...values) {
      if (failing) throw Error("synthetic initial file-sync failure");
      return sync.apply(this, values);
    };
    return file;
  };
  t.after(() => { fs.open = open; });
  await assert.rejects(f.manager.selectAssistant({ runtime: "codex", expectedRevision: 1, operationId: "initial_sync_failure" }),
    { code: "assistant_persistence_uncertain" });
  assert.equal(await readFile(path, "utf8"), before);
  assert.equal(f.manager.adminDescribe().activeRuntime, "opencode");
  assert(!f.events.some(([kind]) => kind === "revoke"));
  assert(!(await fs.readdir(f.rootDir)).some(name => name.endsWith(".tmp")));
  failing = false;
  await f.manager.reconcileAssistant();
  assert.equal(f.manager.adminDescribe().recoveryRequired, false);
  assert.equal(f.manager.adminDescribe().activeRuntime, "opencode");
});
