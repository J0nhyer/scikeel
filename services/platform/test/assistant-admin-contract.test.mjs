import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore } from "../src/auth-store.mjs";
import { CliRuntimeManager } from "../src/cli-runtime.mjs";
import { PlatformServer } from "../src/platform-server.mjs";
import { TenantPolicy } from "../src/tenant-policy.mjs";
import { WorkerManager } from "../src/worker-manager.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "scikeel-assistant-admin-"));
  const profiles = { refresh: async runtime => ({ runtime, status: "ready", enabledByProfile: true,
    identityRevision: `fixture-${runtime}-identity`, catalogRevision: `fixture-${runtime}-catalog`,
    models: [{ id: "gpt-6.1-sol", name: "Approved model", variants: {} }], defaultModel: "gpt-6.1-sol" }),
  copyForTurn() { throw new Error("Admin contracts must not launch a host CLI or copy credentials"); } };
  const cliRuntime = new CliRuntimeManager({ rootDir: join(root, "runtime"), runtime: "opencode", profileResolver: profiles,
    assistantAuthority: { prepare: async () => {}, revoke: async () => {},
      inventory: async () => ({ activeExecutions: [], uncertainEffects: [] }) } });
  const authStore = new AuthStore({ filePath: join(root, "auth.json"), bootstrapAdmin: { username: "admin", password: "fixture-admin-password" } });
  const workerManager = new WorkerManager({ rootDir: join(root, "workers") });
  let workerRequests = 0;
  workerManager.ensureWorker = async () => { workerRequests++; throw new Error("Assistant management must not start a tenant worker"); };
  const logs = [];
  const tenantPolicy = new TenantPolicy();
  const recoveryWorkspace = workerManager.instancePaths("user-admin-recovery-user").workspaceDir;
  tenantPolicy.registerAccount({ instanceId: "user-admin-recovery-user",
    userId: "admin-recovery-user", generation: 1, workspaceDir: recoveryWorkspace });
  const server = new PlatformServer({ authStore, workerManager, cliRuntime, tenantPolicy,
    logger: event => logs.push(event) });
  const revertCalls = [];
  server.conversationRevert = {
    discard: async (owner, input) => { revertCalls.push({ owner, input }); },
  };
  workerManager.retiredGeneration = async () => true;
  const restartRuntime = async () => {
    await cliRuntime.close();
    const restarted = new CliRuntimeManager({ rootDir: cliRuntime.rootDir, runtime: "opencode",
      profileResolver: cliRuntime.profileResolver, assistantAuthority: cliRuntime.assistantAuthority });
    await restarted.init();
    server.cliRuntime = restarted;
    t.after(() => restarted.close());
    return restarted;
  };
  t.after(async () => { await server.close(); await cliRuntime.close(); await workerManager.close(); await rm(root, { recursive: true, force: true }); });
  const address = await server.listen(), base = `http://${address.host}:${address.port}`;
  await authStore.createUser({ username: "student", password: "fixture-student-password" });
  const login = async (username, password) => {
    const response = await fetch(base + "/auth/login", { method: "POST", headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ username, password }) });
    assert.equal(response.status, 200);
    return response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
  };
  const admin = await login("admin", "fixture-admin-password"), student = await login("student", "fixture-student-password");
  const request = (path, cookie, body, extraHeaders = {}) => fetch(base + path, { method: body ? "POST" : "GET", redirect: "manual",
    headers: { accept: "application/json", "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(body ? { origin: base } : {}), ...extraHeaders },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  return { base, request, admin, student, workerRequests: () => workerRequests,
    cliRuntime, conversations: server.conversations, workerManager, revertCalls, server, logs, restartRuntime };
}

async function unknownTurn(f) {
  await f.cliRuntime.selectAssistant({ runtime: "codex", expectedRevision: 1, operationId: "fixture-codex" });
  const workspaceDir = f.workerManager.instancePaths("user-admin-recovery-user").workspaceDir;
  await mkdir(workspaceDir, { recursive: true });
  const conversationId = "recovery-conversation";
  const owner = { userId: "admin-recovery-user", instanceId: "user-admin-recovery-user",
    generation: 1, workspaceDir, directory: workspaceDir };
  const conversation = await f.conversations.create(owner, { conversationId, title: "Recovery", parentId: null, lifecycle: "active" });
  const admission = await f.cliRuntime.admitConversation({ conversations: f.conversations, owner,
    conversationId, expectedRevision: conversation.revision,
    request: { requestId: "recovery-turn", payloadHash: "a".repeat(64), policyRevision: 2,
      runtime: "codex", generation: 1, model: "gpt-6.1-sol", identityRevision: "fixture-codex-identity" } });
  await admission.settle({ cleanupVerified: false });
  await f.restartRuntime();
  return { owner, sessionId: conversationId, requestId: "recovery-turn", identity: admission.identity };
}

test("the existing Admin runtime endpoint remains authenticated and unavailable to ordinary users", async t => {
  const f = await fixture(t);
  assert.equal((await f.request("/api/admin/runtime")).status, 401);
  assert.equal((await f.request("/api/admin/runtime", f.student)).status, 403);
  assert.equal((await f.request("/api/admin/runtime", f.student, { runtime: "codex", expectedRevision: 1, operationId: "student-switch" })).status, 403);
});

test("the existing Admin runtime endpoint accepts one revisioned deployment selection", async t => {
  const f = await fixture(t);
  const initial = await (await f.request("/api/admin/runtime", f.admin)).json();
  assert.equal(initial.activeRuntime, "opencode");
  assert.equal(initial.revision, 1);
  const changed = await f.request("/api/admin/runtime", f.admin, { runtime: "codex", expectedRevision: 1, operationId: "admin-switch-1" });
  assert.equal(changed.status, 200);
  const policy = await changed.json();
  assert.equal(policy.activeRuntime, "codex");
  assert.equal(policy.revision, 2);
  for (const cookie of [f.admin, f.student]) {
    const user = await (await f.request("/api/runtime", cookie)).json();
    assert.equal(user.runtime, "codex");
    assert.equal(user.policyRevision, 2);
    assert.deepEqual(user.available.filter(option => option.enabled).map(option => option.runtime), ["codex"]);
  }
});

test("the reconciliation route is administrator-only, same-origin and reports the state", async t => {
  const f = await fixture(t);
  assert.equal((await f.request("/api/admin/runtime/reconcile")).status, 401);
  assert.equal((await f.request("/api/admin/runtime/reconcile", f.student, {})).status, 403);
  assert.equal((await f.request("/api/admin/runtime/reconcile", f.admin, {}, { origin: "http://elsewhere.invalid" })).status, 403);
  const response = await f.request("/api/admin/runtime/reconcile", f.admin, {});
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.equal(state.activeRuntime, "opencode");
  assert.equal(state.revision, 1);
});

test("legacy independent enabling cannot bypass exclusive Admin selection", async t => {
  const f = await fixture(t);
  const response = await f.request("/api/admin/runtime", f.admin, { runtime: "codex", enabled: true });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "assistant_selection_migrated");
});

test("ordinary users cannot change the deployment assistant through the existing runtime endpoint", async t => {
  const f = await fixture(t);
  const response = await f.request("/api/runtime", f.student, { runtime: "codex", model: "gpt-6.1-sol" });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, "assistant_selection_admin_only");
});

test("Admin selection rejects a different origin scheme even when the host matches", async t => {
  const f = await fixture(t);
  const response = await f.request("/api/admin/runtime", f.admin, { runtime: "codex", expectedRevision: 1, operationId: "foreign-scheme" },
    { origin: f.base.replace("http:", "https:") });
  assert.equal(response.status, 403);
});

test("Admin selection is idempotent and its outcome can be read after an acknowledgement is lost", async t => {
  const f = await fixture(t);
  const input = { runtime: "codex", expectedRevision: 1, operationId: "lost-ack" };
  assert.equal((await f.request("/api/admin/runtime", f.admin, input)).status, 200);
  const outcome = await (await f.request("/api/admin/runtime?operationId=lost-ack", f.admin)).json();
  assert.deepEqual(outcome.operation, { operationId: "lost-ack", state: "committed",
    result: { activeRuntime: "codex", revision: 2, operationId: "lost-ack" } });
  const retried = await f.request("/api/admin/runtime", f.admin, input);
  assert.equal(retried.status, 200);
  assert.equal((await retried.json()).revision, 2);
  const conflict = await f.request("/api/admin/runtime", f.admin, { ...input, runtime: "opencode" });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, "assistant_operation_conflict");
  const stale = await f.request("/api/admin/runtime", f.admin, { ...input, operationId: "stale-selection" });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, "assistant_revision_conflict");
  const unknown = await (await f.request("/api/admin/runtime?operationId=unknown", f.admin)).json();
  assert.deepEqual(unknown.operation, { operationId: "unknown", state: "unknown" });
});

test("selection does not accept extra configuration fields or leak another operation through malformed queries", async t => {
  const f = await fixture(t);
  for (const extra of [{ models: ["unapproved"] }, { enabled: true }, { credential: "fixture-only-canary" }]) {
    const response = await f.request("/api/admin/runtime", f.admin,
      { runtime: "codex", expectedRevision: 1, operationId: "extra-fields", ...extra });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "invalid_assistant_selection");
  }
  for (const query of ["operationId=bad%2Fid", "operationId=one&operationId=two", "other=one"]) {
    const response = await f.request(`/api/admin/runtime?${query}`, f.admin);
    assert.equal(response.status, 400);
  }
});

test("runtime mutations require an exact same origin and cannot trust forwarded scheme headers", async t => {
  const f = await fixture(t);
  for (const extra of [{ origin: "" }, { origin: "null" }, { origin: `${f.base}/path` },
    { origin: "http://elsewhere.invalid" }, { "sec-fetch-site": "cross-site" },
    { origin: f.base.replace("http:", "https:"), "x-forwarded-proto": "https" }]) {
    for (const [path, cookie, body] of [["/api/admin/runtime", f.admin,
      { runtime: "codex", expectedRevision: 1, operationId: "foreign-origin" }],
    ["/api/runtime", f.student, { runtime: "opencode" }]]) {
      const response = await f.request(path, cookie, body, extra);
      assert.equal(response.status, 403);
    }
  }
});

test("stale and missing assistant revisions reject every execution or reply before tenant worker admission", async t => {
  const f = await fixture(t);
  assert.equal((await f.request("/api/admin/runtime", f.admin,
    { runtime: "codex", expectedRevision: 1, operationId: "before-execution" })).status, 200);
  const routes = ["/session/owned/prompt_async", "/session/owned/message", "/session/owned/command",
    "/session/owned/shell", "/session/owned/summarize", "/session/owned/fork", "/session/owned/revert",
    "/session/owned/unrevert", "/question/pending/reply", "/question/pending/reject", "/permission/pending/reply"];
  for (const path of routes) {
    for (const revision of [undefined, "1", "02", "2.0", "2,2"]) {
      const response = await f.request(path, f.student, {},
        revision === undefined ? {} : { "x-scikeel-assistant-revision": revision });
      assert.equal(response.status, 409, `${path}: ${revision}`);
      assert.equal((await response.json()).code, "assistant_revision_conflict");
    }
  }
  assert.equal(f.workerRequests(), 0);
});

test("a stale page may still look up Stop for its captured execution", async t => {
  const f = await fixture(t);
  assert.equal((await f.request("/api/admin/runtime", f.admin,
    { runtime: "codex", expectedRevision: 1, operationId: "before-stop" })).status, 200);
  const response = await f.request("/session/owned/abort", f.student, {}, { "x-scikeel-assistant-revision": "1" });
  assert.equal(response.status, 500);
  assert.equal(f.workerRequests(), 1);
});

test("an interrupted accepted turn is recovered through one explicit Admin request", async t => {
  const f = await fixture(t);
  const turn = await unknownTurn(f);
  const policy = await (await f.request("/api/admin/runtime", f.admin)).json();
  assert.equal(policy.recoveryRequired, true);
  assert.deepEqual(policy.recoverable.identity, turn.identity);
  const response = await f.request("/api/admin/runtime/recover", f.admin,
    { identity: turn.identity, expectedRevision: policy.revision });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { activeRuntime: policy.activeRuntime,
    revision: policy.revision, recovered: true });
  assert.equal((await f.conversations.open(turn.owner, turn.sessionId)).turns[turn.requestId].state, "settled");
  assert.equal((await f.conversations.open(turn.owner, turn.sessionId)).turns[turn.requestId].cleanupVerified, true);
  assert.equal(f.revertCalls.length, 1);
  assert.equal((await (await f.request("/api/admin/runtime", f.admin)).json()).recoveryRequired, false);
  assert(f.logs.some(event => event.type === "assistant.recovery" && event.outcome === "committed"));
});

test("recovery is authenticated, same-origin, revisioned and idempotent", async t => {
  const f = await fixture(t);
  const turn = await unknownTurn(f);
  const body = { identity: turn.identity, expectedRevision: 2 };
  assert.equal((await f.request("/api/admin/runtime/recover")).status, 401);
  assert.equal((await f.request("/api/admin/runtime/recover", f.student, body)).status, 403);
  assert.equal((await f.request("/api/admin/runtime/recover", f.admin, body,
    { origin: "http://elsewhere.invalid" })).status, 403);
  assert.equal((await f.request("/api/admin/runtime/recover", f.admin,
    { ...body, expectedRevision: 1 })).status, 409);
  assert.equal((await f.request("/api/admin/runtime/recover", f.admin, { identity: turn.identity })).status, 400);
  assert.equal((await f.request("/api/admin/runtime/recover", f.admin, body)).status, 200);
  assert.equal((await f.request("/api/admin/runtime/recover", f.admin, body)).status, 200);
  assert.equal(f.revertCalls.length, 1, "A retry must not discard the receipt again");
});

test("recovery fails closed when the revert receipt holds accepted effects", async t => {
  const f = await fixture(t);
  const turn = await unknownTurn(f);
  f.server.conversationRevert = { discard: async () => { throw Object.assign(Error("revert snapshot conflict"), { code: "revert_snapshot_conflict", statusCode: 409 }); } };
  const response = await f.request("/api/admin/runtime/recover", f.admin,
    { identity: turn.identity, expectedRevision: 2 });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "assistant_recovery_required");
  assert.equal((await (await f.request("/api/admin/runtime", f.admin)).json()).recoveryRequired, true);
  f.server.conversationRevert = { discard: async () => {} };
  assert.equal((await f.request("/api/admin/runtime/recover", f.admin,
    { identity: turn.identity, expectedRevision: 2 })).status, 200);
});

test("recovery refuses while the launcher account is not verifiably retired", async t => {
  const f = await fixture(t);
  const turn = await unknownTurn(f);
  f.workerManager.retiredGeneration = async () => false;
  const response = await f.request("/api/admin/runtime/recover", f.admin,
    { identity: turn.identity, expectedRevision: 2 });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "assistant_unavailable");
  assert.equal((await (await f.request("/api/admin/runtime", f.admin)).json()).recoveryRequired, true);
});
