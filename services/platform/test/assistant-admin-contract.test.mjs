import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore } from "../src/auth-store.mjs";
import { CliRuntimeManager } from "../src/cli-runtime.mjs";
import { PlatformServer } from "../src/platform-server.mjs";
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
  const server = new PlatformServer({ authStore, workerManager, cliRuntime });
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
  return { base, request, admin, student, workerRequests: () => workerRequests };
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
