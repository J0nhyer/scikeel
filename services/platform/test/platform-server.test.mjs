import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

import { AuthStore } from "../src/auth-store.mjs";
import { CliRuntimeManager } from "../src/cli-runtime.mjs";
import { PlatformServer } from "../src/platform-server.mjs";
import { WorkerManager } from "../src/worker-manager.mjs";
import { TenantPolicy } from "../src/tenant-policy.mjs";

const fakeOsd = fileURLToPath(new URL("../fixtures/fake-osd.mjs", import.meta.url));
const fakeCli = fileURLToPath(new URL("../fixtures/fake-cli.mjs", import.meta.url));
const fixtures = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.server.close();
    await fixture.cliRuntime?.close();
    await fixture.manager.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

function addCookies(jar, response) {
  const cookies = response.headers.getSetCookie?.() ?? (() => {
    const combined = response.headers.get("set-cookie");
    return combined ? combined.split(/,\s*(?=[A-Za-z0-9_-]+=)/) : [];
  })();
  for (const value of cookies) {
    const [pair, ...attributes] = value.split(";");
    const separator = pair.indexOf("=");
    const name = pair.slice(0, separator);
    const cookieValue = pair.slice(separator + 1);
    const maxAge = attributes.find((attribute) => attribute.trim().toLowerCase().startsWith("max-age="));
    if (maxAge && maxAge.trim().slice(8) === "0") jar.delete(name);
    else jar.set(name, cookieValue);
  }
}

function cookieHeader(jar) {
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

function makeClient(base) {
  const jar = new Map();
  return {
    jar,
    async request(path, options = {}) {
      const headers = { ...(options.headers ?? {}) };
      const cookies = cookieHeader(jar);
      if (cookies) headers.cookie = cookies;
      const response = await fetch(`${base}${path}`, {
        redirect: "manual",
        ...options,
        headers,
      });
      addCookies(jar, response);
      return response;
    },
  };
}

async function makeFixture({ cliRuntime = null, webRoot = null, root: providedRoot = null, tenantPolicy = null, environments = null } = {}) {
  const root = providedRoot ?? (await mkdtemp(join(tmpdir(), "osd-platform-server-")));
  const authStore = new AuthStore({
    filePath: join(root, "platform", "auth.json"),
    bootstrapAdmin: { username: "admin", password: "admin-password" },
  });
  const manager = new WorkerManager({
    rootDir: join(root, "workers"),
    osdCommand: process.execPath,
    osdArgs: [fakeOsd],
    startupTimeoutMs: 5_000,
    stopTimeoutMs: 1_000,
  });
  const server = new PlatformServer({ authStore, workerManager: manager, cliRuntime, webRoot, tenantPolicy, environments });
  const address = await server.listen();
  const fixture = { root, authStore, manager, server, cliRuntime, base: `http://${address.host}:${address.port}` };
  fixtures.push(fixture);
  return fixture;
}

async function json(response) {
  return response.json();
}

async function login(client, username, password) {
  const response = await client.request("/auth/login", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(response.status, 200);
  return json(response);
}

async function waitForAssistant(client, sessionId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await client.request(`/session/${encodeURIComponent(sessionId)}/message`, {
      headers: { accept: "application/json" },
    });
    assert.equal(response.status, 200);
    const messages = await json(response);
    const assistant = messages.find(
      (message) =>
        message.info?.role === "assistant" &&
        message.parts?.some((part) => part.type === "text" && typeof part.text === "string"),
    );
    if (assistant) return assistant;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`CLI assistant response did not arrive for ${sessionId}`);
}

test("streams authenticated file downloads as named attachments while previews stay inline", async () => {
  const fixture = await makeFixture();
  const client = makeClient(fixture.base);
  const { user } = await login(client, "admin", "admin-password");
  const worker = await fixture.manager.ensureWorker({ instanceId: `user-${user.id}`, userId: user.id });
  await mkdir(join(worker.workspaceDir, "papers"));
  const pdf = Buffer.from("%PDF-test-original-bytes");
  await writeFile(join(worker.workspaceDir, "papers", "paper.pdf"), pdf);
  const preview = await client.request("/v1/fs/read?path=papers%2Fpaper.pdf");
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get("content-disposition"), null);
  const download = await client.request("/v1/fs/read?path=papers%2Fpaper.pdf&download=paper.pdf");
  assert.equal(download.status, 200);
  assert.match(download.headers.get("content-disposition"), /^attachment;.*filename="paper.pdf"/);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), pdf);
  const unicodeName = "CNN \u5b66\u4e60.pdf";
  const unicode = await client.request(`/v1/fs/read?path=papers%2Fpaper.pdf&download=${encodeURIComponent(unicodeName)}`);
  assert.ok(unicode.headers.get("content-disposition").includes(`filename*=UTF-8''${encodeURIComponent(unicodeName)}`));
  const longName = `${"a".repeat(239)}\u{1F600}.pdf`;
  const long = await client.request(`/v1/fs/read?path=papers%2Fpaper.pdf&download=${encodeURIComponent(longName)}`);
  assert.equal(long.status, 200);
  assert.ok(long.headers.get("content-disposition").includes(encodeURIComponent(`${"a".repeat(239)}\u{1F600}`)));
  const missing = await client.request("/v1/fs/read?path=missing.pdf&download=missing.pdf");
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("content-disposition"), null);
  const anonymous = makeClient(fixture.base);
  assert.equal((await anonymous.request("/v1/fs/read?path=papers%2Fpaper.pdf&download=paper.pdf")).status, 303);
});

test("authenticates users, routes each one to an isolated worker, and rewrites upstream auth", async () => {
  const fixture = await makeFixture();
  const admin = makeClient(fixture.base);
  const adminLogin = await login(admin, "admin", "admin-password");

  const me = await admin.request("/api/me", { headers: { accept: "application/json" } });
  assert.equal(me.status, 200);
  assert.equal((await json(me)).user.id, adminLogin.user.id);

  const firstBootstrap = await admin.request("/");
  assert.equal(firstBootstrap.status, 303);
  const firstLocation = firstBootstrap.headers.get("location");
  assert.match(firstLocation, /^\/#token=[A-Za-z0-9_-]+$/);
  const firstToken = decodeURIComponent(firstLocation.split("#token=")[1]);
  assert.equal(firstToken, fixture.manager.getWorkerAccess(`user-${adminLogin.user.id}`).token);
  assert.doesNotMatch(firstLocation, /apiKey|secret|password/i);

  const firstRoot = await admin.request("/");
  assert.equal(firstRoot.status, 200);
  const firstWorkspace = await firstRoot.text();
  assert.match(firstWorkspace, /worker:/);

  const whoami = await admin.request("/v1/whoami", {
    headers: { accept: "application/json" },
  });
  assert.equal(whoami.status, 200);
  const firstWhoami = await json(whoami);
  assert.equal(firstWhoami.authorization, `Bearer ${firstToken}`);
  assert.equal(firstWhoami.directory, fixture.manager.getWorker(`user-${adminLogin.user.id}`).workspaceDir);

  const echo = await admin.request("/echo", { headers: { accept: "application/json" } });
  assert.equal(echo.status, 200);
  assert.deepEqual(await json(echo), {
    authorization: `Basic ${Buffer.from(`opencode:${firstToken}`).toString("base64")}`,
    cookie: null,
  });

  const event = await admin.request("/event");
  assert.equal(event.status, 200);
  const eventPayload = JSON.parse(await event.text());
  assert.equal(eventPayload.authorization, `Basic ${Buffer.from(`opencode:${firstToken}`).toString("base64")}`);
  assert.match(eventPayload.query, /auth_token=/);

  const created = await admin.request("/api/admin/users", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ username: "student", password: "student-password" }),
  });
  assert.equal(created.status, 201);
  const studentUser = (await json(created)).user;

  const student = makeClient(fixture.base);
  const studentLogin = await login(student, "student", "student-password");
  assert.equal(studentLogin.user.id, studentUser.id);
  const studentBootstrap = await student.request("/");
  assert.equal(studentBootstrap.status, 303);
  const studentToken = decodeURIComponent(studentBootstrap.headers.get("location").split("#token=")[1]);
  assert.notEqual(studentToken, firstToken);
  const studentWhoami = await student.request("/v1/whoami");
  assert.equal(studentWhoami.status, 200);
  assert.notEqual((await json(studentWhoami)).directory, firstWhoami.directory);

  const studentAdminAttempt = await student.request("/api/admin/users", {
    headers: { accept: "application/json" },
  });
  assert.equal(studentAdminAttempt.status, 403);

  const disabled = await admin.request(`/api/admin/users/${studentUser.id}/disable`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ disabled: true }),
  });
  assert.equal(disabled.status, 200);
  assert.equal(fixture.manager.getWorker(`user-${studentUser.id}`).status, "stopped");
  const disabledMe = await student.request("/api/me", { headers: { accept: "application/json" } });
  assert.equal(disabledMe.status, 401);
});

test("does not expose worker routes without a platform session", async () => {
  const fixture = await makeFixture();
  const anonymous = makeClient(fixture.base);
  const response = await anonymous.request("/v1/whoami", { headers: { accept: "application/json" } });
  assert.equal(response.status, 401);
  assert.equal(fixture.manager.listWorkers().length, 0);
});

test("logs out through a browser form and revokes the platform session", async () => {
  const fixture = await makeFixture();
  const admin = makeClient(fixture.base);
  await login(admin, "admin", "admin-password");

  const logout = await admin.request("/auth/logout", { method: "POST" });
  assert.equal(logout.status, 303);
  assert.equal(logout.headers.get("location"), "/login");
  assert.equal(admin.jar.has("osd_session"), false);
  assert.equal(admin.jar.has("osd_worker_bootstrap"), false);

  const me = await admin.request("/api/me", { headers: { accept: "application/json" } });
  assert.equal(me.status, 401);
});

test("keeps OpenCode per user while exposing administrator-managed Claude and Codex CLIs", async () => {
  const root = await mkdtemp(join(tmpdir(), "osd-platform-cli-"));
  const webRoot = join(root, "web");
  const adminClaude = join(root, "admin-claude");
  const adminCodex = join(root, "admin-codex");
  await mkdir(adminClaude, { recursive: true });
  await mkdir(adminCodex, { recursive: true });
  await writeFile(join(adminClaude, "settings.json"), JSON.stringify({ model: "admin-model" }));
  await writeFile(join(adminCodex, "auth.json"), '{"auth":true}\n');
  await writeFile(join(adminCodex, "config.toml"), 'model = "gpt-fast"\nmodel_catalog_json = "codex-models.json"\n');
  await writeFile(join(adminCodex, "codex-models.json"), JSON.stringify({ models: ["gpt-fast", "gpt-deep"] }));
  await mkdir(join(webRoot, "assets"), { recursive: true });
  await writeFile(join(webRoot, "index.html"), "<!doctype html><html><head></head><body>web</body></html>");
  await writeFile(join(webRoot, "assets", "app.js"), "console.log('web');\n");

  const cliRuntime = new CliRuntimeManager({
    rootDir: join(root, "cli-runtime"),
    runtime: "opencode",
    claudeCommand: process.execPath,
    claudeArgs: [fakeCli, "claude"],
    codexCommand: process.execPath,
    codexArgs: [fakeCli, "codex"],
    claudeConfigDir: adminClaude,
    codexHome: adminCodex,
    turnTimeoutMs: 5_000,
  });
  const fixture = await makeFixture({ cliRuntime, webRoot, root });

  const admin = makeClient(fixture.base);
  const adminLogin = await login(admin, "admin", "admin-password");
  const runtime = await admin.request("/api/runtime", { headers: { accept: "application/json" } });
  assert.equal(runtime.status, 200);
  const initialRuntime = await json(runtime);
  assert.equal(initialRuntime.runtime, "opencode");
  assert.deepEqual(initialRuntime.available.map((option) => option.runtime), ["opencode", "claude", "codex"]);

  const bootstrap = await admin.request("/");
  assert.equal(bootstrap.status, 303);
  const web = await admin.request("/");
  assert.equal(web.status, 200);
  assert.match(await web.text(), /window\.__OS_WEB__=true/);
  const asset = await admin.request("/assets/app.js");
  assert.equal(asset.status, 200);
  assert.equal(await asset.text(), "console.log('web');\n");
  const workspace = fixture.manager.getWorker(`user-${adminLogin.user.id}`).workspaceDir;

  const created = await admin.request("/api/admin/users", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ username: "student", password: "student-password" }),
  });
  assert.equal(created.status, 201);
  const student = makeClient(fixture.base);
  await login(student, "student", "student-password");
  const studentBootstrap = await student.request("/");
  assert.equal(studentBootstrap.status, 303);
  const studentRuntime = await student.request("/api/runtime", { headers: { accept: "application/json" } });
  assert.equal((await json(studentRuntime)).runtime, "opencode");

  const configuredCodex = await admin.request("/api/admin/runtime", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ runtime: "codex", enabled: true }),
  });
  assert.equal(configuredCodex.status, 200);
  assert.equal((await json(configuredCodex)).assistantEnabled.codex, true);

  const invalidCatalog = await admin.request("/api/admin/runtime", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      runtime: "codex",
      models: ["gpt-fast"],
      defaultModel: "gpt-missing",
    }),
  });
  assert.equal(invalidCatalog.status, 400);
  const unchangedCatalog = await admin.request("/api/admin/runtime", {
    headers: { accept: "application/json" },
  });
  assert.equal((await json(unchangedCatalog)).assistantEnabled.codex, true);

  const studentAdminAttempt = await student.request("/api/admin/runtime", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      runtime: "codex",
      models: ["forbidden"],
      defaultModel: "forbidden",
    }),
  });
  assert.equal(studentAdminAttempt.status, 403);

  const selectClaude = await admin.request("/api/runtime", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ runtime: "claude" }),
  });
  assert.equal(selectClaude.status, 200);
  assert.equal((await json(selectClaude)).runtime, "claude");
  const unchangedStudentRuntime = await student.request("/api/runtime", { headers: { accept: "application/json" } });
  assert.equal((await json(unchangedStudentRuntime)).runtime, "opencode");
  const studentOpenCode = await student.request("/echo", { headers: { accept: "application/json" } });
  assert.equal(studentOpenCode.status, 200);

  const eventResponse = await admin.request(`/event?directory=${encodeURIComponent(workspace)}`);
  assert.equal(eventResponse.status, 200);
  const eventReader = eventResponse.body.getReader();
  const connected = await eventReader.read();
  assert.match(new TextDecoder().decode(connected.value), /connected/);

  const claudeSessionResponse = await admin.request(`/session?directory=${encodeURIComponent(workspace)}`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ title: "Claude test" }),
  });
  assert.equal(claudeSessionResponse.status, 200);
  const claudeSession = await json(claudeSessionResponse);
  assert.match(claudeSession.id, /^ses_cli_/);
  const claudePrompt = await admin.request(`/session/${claudeSession.id}/prompt_async`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ parts: [{ type: "text", text: "hello Claude" }] }),
  });
  assert.equal(claudePrompt.status, 202);
  const claudeAssistant = await waitForAssistant(admin, claudeSession.id);
  assert.match(
    claudeAssistant.parts.find((part) => part.type === "text").text,
    /Claude\[admin-model\]: hello Claude/,
  );
  let streamed = "";
  for (let attempt = 0; attempt < 10 && !/session\.idle/.test(streamed); attempt += 1) {
    const eventChunk = await eventReader.read();
    streamed += new TextDecoder().decode(eventChunk.value);
  }
  assert.match(streamed, /session\.idle/);
  await eventReader.cancel();

  const switchRuntime = await admin.request("/api/runtime", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ runtime: "codex", model: "gpt-deep" }),
  });
  assert.equal(switchRuntime.status, 200);
  assert.equal((await json(switchRuntime)).model, "gpt-deep");
  const stillUnchangedStudentRuntime = await student.request("/api/runtime", { headers: { accept: "application/json" } });
  assert.equal((await json(stillUnchangedStudentRuntime)).runtime, "opencode");
  const adminManagedConfig = await admin.request("/global/config", {
    headers: { accept: "application/json" },
  });
  assert.deepEqual(await json(adminManagedConfig), { model: "codex/gpt-deep" });
  const codexProviders = await admin.request("/config/providers", {
    headers: { accept: "application/json" },
  });
  assert.deepEqual(await json(codexProviders), {
    providers: [{
      id: "codex",
      name: "Codex",
      models: {
        "gpt-fast": { name: "gpt-fast", variants: {}, limit: { context: 0 } },
        "gpt-deep": { name: "gpt-deep", variants: {}, limit: { context: 0 } },
      },
    }],
  });
  const codexSessionsBefore = await admin.request("/experimental/session", {
    headers: { accept: "application/json" },
  });
  assert.deepEqual(await json(codexSessionsBefore), []);
  assert.equal(JSON.parse(await readFile(join(root, "cli-runtime", "users", adminLogin.user.id, "claude-config", "profiles", cliRuntime.profiles.get("claude").identityRevision, cliRuntime.profiles.get("claude").sourceRevision, "settings.json"), "utf8")).model, "admin-model");

  const codexSessionResponse = await admin.request(`/session?directory=${encodeURIComponent(workspace)}`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ title: "Codex test" }),
  });
  assert.equal(codexSessionResponse.status, 200);
  const codexSession = await json(codexSessionResponse);
  const invalidPrompt = await admin.request(`/session/${codexSession.id}/prompt_async`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ parts: [{ type: "text", text: "  " }] }),
  });
  assert.equal(invalidPrompt.status, 400);
  const invalidModel = await admin.request(`/session/${codexSession.id}/prompt_async`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ model: { providerID: "codex", modelID: "unavailable" }, parts: [{ type: "text", text: "hello" }] }),
  });
  assert.equal(invalidModel.status, 400);
  const invalidMessages = await admin.request(`/session/${codexSession.id}/message`);
  assert.deepEqual(await json(invalidMessages), []);
  const codexPrompt = await admin.request(`/session/${codexSession.id}/prompt_async`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ parts: [{ type: "text", text: "hello Codex" }] }),
  });
  assert.equal(codexPrompt.status, 202);
  const overlappingPrompt = await admin.request(`/session/${codexSession.id}/prompt_async`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ parts: [{ type: "text", text: "should not overlap" }] }),
  });
  assert.equal(overlappingPrompt.status, 409);
  const codexAssistant = await waitForAssistant(admin, codexSession.id);
  assert.match(
    codexAssistant.parts.find((part) => part.type === "text").text,
    /Codex\[gpt-deep\]: hello Codex/,
  );

  const codexFollowUp = await admin.request(`/session/${codexSession.id}/prompt_async`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ parts: [{ type: "text", text: "continue Codex" }] }),
  });
  assert.equal(codexFollowUp.status, 202);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const messagesResponse = await admin.request(`/session/${codexSession.id}/message`, {
      headers: { accept: "application/json" },
    });
    const messages = await json(messagesResponse);
    if (messages.some((message) => message.parts?.some((part) => /Codex\[gpt-deep\]: continue Codex/.test(part.text ?? "")))) {
      assert.equal(messages.some((message) => message.info?.error), false);
      break;
    }
    if (attempt === 99) assert.fail("Codex follow-up did not finish");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  const selectStudentCodex = await student.request("/api/runtime", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ runtime: "codex", model: "gpt-fast" }),
  });
  assert.equal(selectStudentCodex.status, 200);
  assert.equal((await json(selectStudentCodex)).model, "gpt-fast");
  const studentManagedConfig = await student.request("/global/config", {
    headers: { accept: "application/json" },
  });
  assert.deepEqual(await json(studentManagedConfig), { model: "codex/gpt-fast" });
  const adminStillDeep = await admin.request("/global/config", {
    headers: { accept: "application/json" },
  });
  assert.deepEqual(await json(adminStillDeep), { model: "codex/gpt-deep" });

  const patchAdminModel = await admin.request("/global/config", {
    method: "PATCH",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ model: "codex/gpt-fast" }),
  });
  assert.equal(patchAdminModel.status, 200);
  assert.deepEqual(await json(patchAdminModel), { model: "codex/gpt-fast" });
  const adminAfterPatch = await admin.request("/global/config", {
    headers: { accept: "application/json" },
  });
  assert.deepEqual(await json(adminAfterPatch), { model: "codex/gpt-fast" });

  const switchBack = await admin.request("/api/runtime", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ runtime: "claude" }),
  });
  assert.equal(switchBack.status, 200);
  const restoredClaudeSessions = await admin.request("/experimental/session", {
    headers: { accept: "application/json" },
  });
  assert.deepEqual((await json(restoredClaudeSessions)).map((session) => session.id), [claudeSession.id]);
});

function expectRuntime({ runtime, model }) {
  return {
    runtime,
    kind: "server",
    managed: true,
    label: runtime === "codex" ? "Codex" : "Claude Code",
    enabled: true,
    models: runtime === "codex" ? ["gpt-fast", "gpt-deep"] : ["admin-model"],
    defaultModel: runtime === "codex" ? "gpt-fast" : "admin-model",
    selectedModel: model,
    model,
    available: [
      {
        runtime: "opencode",
        kind: "opencode",
        managed: false,
        label: "OpenCode",
        enabled: true,
        models: [],
        defaultModel: null,
        selectedModel: null,
      },
      {
        runtime: "claude",
        kind: "server",
        managed: true,
        label: "Claude Code",
        enabled: true,
        models: ["admin-model"],
        defaultModel: "admin-model",
        selectedModel: "admin-model",
      },
      {
        runtime: "codex",
        kind: "server",
        managed: true,
        label: "Codex",
        enabled: true,
        models: ["gpt-fast", "gpt-deep"],
        defaultModel: "gpt-fast",
        selectedModel: model,
      },
    ],
  };
}

test("managed runtime proxy rejects raw paths, peer directories, unknown sessions and foreign origins", async () => {
  const policy = new TenantPolicy();
  const fixture = await makeFixture({ tenantPolicy: policy });
  const client = makeClient(fixture.base);
  const { user } = await login(client, "admin", "admin-password");
  const instanceId = `user-${user.id}`;
  const worker = await fixture.manager.ensureWorker({ instanceId, userId: user.id });
  policy.registerAccount({ userId: user.id, instanceId, generation: 1, workspaceDir: worker.workspaceDir });
  // The fake legacy worker has no managed generation and must never be trusted.
  fixture.manager.getWorker = ((original) => (id) => ({ ...original.call(fixture.manager, id), generation: 1 }))(fixture.manager.getWorker);
  for (const path of ["/file/content", "/find/file", "/path", "/pty", "/global/config/auth", "/session/a%252fb", "/v1/sessions", "/v1/events"])
    assert.equal((await client.request(path)).status, 404, path);
  assert.equal((await client.request("/event?directory=%2Fetc")).status, 403);
  assert.equal((await client.request("/session/unknown")).status, 404);
  assert.equal((await client.request("/event?directory=a&directory=b")).status, 400);
  assert.equal((await client.request("/event", { headers: { "x-opencode-directory": "/etc" } })).status, 400);
  assert.equal((await client.request("/session", { method: "POST", headers: {
    "content-type": "application/json", origin: "https://foreign.invalid" }, body: "{}" })).status, 403);
  assert.equal((await client.request("/global/config")).status, 200);
  assert.deepEqual(await json(await client.request("/global/config")), { model: null });
  // Secret-bearing diagnostic SSE from this legacy fixture must not pass through.
  const events = await client.request("/event");
  assert.equal(events.status, 200);
  const text = await events.text();
  assert.ok(!text.includes("Basic "));
});
test("worker operation leases cover proxy responses and release when they finish", async () => {
  const fixture = await makeFixture(); const client = makeClient(fixture.base);
  await login(client, "admin", "admin-password");
  let retained = 0; let released = 0;
  fixture.manager.retainWorker = () => { retained++; return { release: () => released++ }; };
  const response = await client.request("/v1/health"); assert.equal(response.status, 200); await response.text();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(retained, 1); assert.equal(released, 1);
});
test("managed users can load the Web client without admitting a sandbox or exposing its token", async () => {
  const root = await mkdtemp(join(tmpdir(), "osd-static-managed-"));
  const webRoot = join(root, "web"); await mkdir(webRoot);
  await writeFile(join(webRoot, "index.html"), "<html><head></head><body>static client</body></html>");
  const fixture = await makeFixture({ root, webRoot, tenantPolicy: new TenantPolicy() });
  const client = makeClient(fixture.base); await login(client, "admin", "admin-password");
  fixture.manager.ensureWorker = async () => { throw new Error("sandbox must not start for static assets"); };
  const response = await client.request("/");
  assert.equal(response.status, 200); assert.match(await response.text(), /static client/);
  assert.equal(response.headers.get("location"), null);
});
test("private environment endpoints require an owned session and explicit manual approval without caller file paths", async () => {
  const policy=new TenantPolicy(); const calls=[];
  const environments={describe:async(context,sessionId)=>{calls.push(["describe",context,sessionId]);return {venvState:"absent"};},
    request:async(context,sessionId)=>{calls.push(["request",context,sessionId]);return {id:"a".repeat(64),permission:"dependency_install"};},
    install:async(context,sessionId,value)=>{calls.push(["install",context,sessionId]);assert.equal(value.manual,true);return {selection:{kind:"private"}};}};
  const fixture=await makeFixture({tenantPolicy:policy,environments}); const client=makeClient(fixture.base);
  assert.equal((await client.request("/api/environments/owned")).status,401);
  const {user}=await login(client,"admin","admin-password");const instanceId=`user-${user.id}`;
  const worker=await fixture.manager.ensureWorker({instanceId,userId:user.id});
  fixture.manager.getWorker=((original)=>(id)=>({...original.call(fixture.manager,id),generation:1}))(fixture.manager.getWorker);
  const context={userId:user.id,instanceId,generation:1,workspaceDir:worker.workspaceDir};
  policy.registerAccount(context);policy.registerSession(context,{id:"owned",directory:worker.workspaceDir+"/project"});
  const post=(path,body={},headers={})=>client.request(path,{method:"POST",headers:{"content-type":"application/json",...headers},body:JSON.stringify(body)});
  assert.equal((await client.request("/api/environments/foreign")).status,404);
  assert.equal((await client.request("/api/environments/owned?project=peer")).status,400);
  assert.equal((await post("/api/environments/owned/request",{project:"peer"})).status,400);
  assert.equal((await post("/api/environments/owned/request",{}, {origin:"https://foreign.invalid"})).status,403);
  assert.equal((await post("/api/environments/owned/install",{id:"a".repeat(64),manual:false})).status,400);
  assert.deepEqual(calls,[]);
  assert.equal((await client.request("/api/environments/owned")).status,200);
  assert.equal((await post("/api/environments/owned/request")).status,200);
  assert.equal((await post("/api/environments/owned/install",{id:"a".repeat(64),manual:true})).status,200);
  assert.deepEqual(calls.map(value=>value[0]),["describe","request","install"]);
  assert.ok(calls.every(([,owner])=>owner.userId===user.id && owner.instanceId===instanceId && owner.generation===1));
});
