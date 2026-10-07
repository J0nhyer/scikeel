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

async function makeFixture({ cliRuntime = null, webRoot = null, root: providedRoot = null, tenantPolicy = null, environments = null, workspaceFiles = null } = {}) {
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
  const server = new PlatformServer({ authStore, workerManager: manager, cliRuntime, webRoot, tenantPolicy, environments, workspaceFiles });
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

test("localized login keeps credentials private and preserves the destination on retries", async () => {
  const f = await makeFixture();
  const page = await fetch(`${f.base}/login?next=${encodeURIComponent('/files?view="recent"')}`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("cache-control"), "no-store");
  const html = await page.text();
  assert.match(html, /<html lang="zh-Hans">/);
  assert.match(html, /name="next" value="\/files\?view=&quot;recent&quot;"/);
  const english = await fetch(`${f.base}/login?lang=en`);
  assert.match(await english.text(), /<html lang="en">/);
  const username = '<img src=x onerror="alert(1)">';
  const invalid = await fetch(`${f.base}/auth/login`, {
    method: "POST",
    body: new URLSearchParams({ username, password: "never-render-this-password", lang: "en", next: "/files" }),
  });
  assert.equal(invalid.status, 401);
  const retry = await invalid.text();
  assert.match(retry, /role="alert"/);
  assert.match(retry, /value="&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;"/);
  assert.doesNotMatch(retry, /never-render-this-password/);
  assert.match(retry, /name="next" value="\/files"/);
  const success = await fetch(`${f.base}/auth/login`, {
    method: "POST", redirect: "manual",
    body: new URLSearchParams({ username: "admin", password: "admin-password", lang: "zh-Hans", next: "/files" }),
  });
  assert.equal(success.status, 303);
  assert.equal(success.headers.get("location"), "/files");
  assert.match(success.headers.get("set-cookie"), /osd_session=/);
});

test("research tasks validate ownership, bind context to a confirmed brief, and stop on page release", async () => {
  const root = await mkdtemp(join(tmpdir(), "scikeel-research-platform-"));
  const home = join(root, "admin-codex");
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "auth.json"), '{"auth":true}');
  await writeFile(join(home, "config.toml"), 'model = "gpt-fast"\nmodel_catalog_json = "models.json"\n');
  await writeFile(join(home, "models.json"), JSON.stringify({ models: ["gpt-fast"] }));
  const cliRuntime = new CliRuntimeManager({ rootDir: join(root, "cli"), codexHome: home, codexCommand: process.execPath, codexArgs: [fakeCli, "codex"] });
  const f = await makeFixture({ root, cliRuntime });
  const admin = makeClient(f.base);
  const account = await login(admin, "admin", "admin-password");
  await cliRuntime.setUserRuntime(account.user.id, "codex", "gpt-fast");
  const post = (path, body) => admin.request(path, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(body) });
  const session = await json(await post("/session", { title: "Research task" }));
  const path = `/api/research/${session.id}`;
  assert.equal((await fetch(`${f.base}${path}`, { headers: { accept: "application/json" } })).status, 401);
  assert.equal((await admin.request(path)).status, 200);
  assert.equal((await post("/api/research/ses_cli_foreign_session_fixture_1234", { action: "create" })).status, 404);
  const created = await post(path, { action: "create", objective: "Make a traceable baseline report", mode: "guided", goal: "thesis", inputs: [], deliverables: ["report.md"], pageId: "page-test", directory: "/another/account" });
  assert.equal(created.status, 201);
  const task = (await json(created)).task;
  assert.notEqual(task.directory, "/another/account");
  assert.equal(task.authorization, "existing-runtime-workspace-policy");
  assert.equal((await post(`/session/${session.id}/prompt_async`, { parts: [{ type: "text", text: "Begin" }] })).status, 202);
  await admin.request("/");
  const answer = await waitForAssistant(admin, session.id);
  assert.match(answer.parts.find((part) => part.type === "text").text, /research-workflow/);
  assert.match(answer.parts.find((part) => part.type === "text").text, /guided/);
  assert.match(answer.parts.find((part) => part.type === "text").text, /Make a traceable baseline report/);
  const history = await json(await admin.request(`/session/${session.id}/message`));
  assert.equal(history[0].parts[0].text, "Begin");
  assert.equal((await post(path, { action: "release", pageId: "page-test" })).status, 200);
  assert.equal((await post(`/session/${session.id}/prompt_async`, { parts: [{ type: "text", text: "Continue" }] })).status, 409);
  const reopened = await post(path, { action: "heartbeat", pageId: "page-new" });
  assert.equal(reopened.status, 200);
  const stopped = (await json(await admin.request(path))).task;
  assert.notEqual(stopped.status, "running");
  assert.equal(stopped.execution, 1);
  const fork = await json(await post(`/session/${session.id}/fork`, {}));
  await post(path, { action: "release", pageId: "page-new" });
  f.server.researchTasks.records.clear();
  assert.equal((await post(`/session/${fork.id}/prompt_async`, { parts: [{ type: "text", text: "Detached research review" }] })).status, 409);
});

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
  assert.equal(response.headers.get("x-scikeel-auth"), "session-required");
  const withoutAccept = await anonymous.request("/v1/whoami");
  assert.equal(withoutAccept.status, 401);
  assert.equal(withoutAccept.headers.get("x-scikeel-auth"), "session-required");
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
  const webHtml = await web.text();
  assert.match(webHtml, /window\.__OS_WEB__=true/);
  assert.match(webHtml, /window\.__OS_PLATFORM__=true/);
  assert.equal((await admin.request("/")).status, 200);
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

  const studentSwitchAttempt = await student.request("/api/admin/runtime", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ runtime: "codex", enabled: false }),
  });
  assert.equal(studentSwitchAttempt.status, 403);
  assert.equal((await json(await admin.request("/api/admin/runtime", {
    headers: { accept: "application/json" },
  }))).assistantEnabled.codex, true);

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
  const context={userId:user.id,instanceId,generation:1};
  policy.registerSession(context,{id:"owned",directory:worker.workspaceDir});
  const deletion={method:"DELETE",headers:{origin:fixture.base}};
  assert.equal((await client.request("/session/owned",deletion)).status,403);
  const approved=await client.request("/session/owned",{...deletion,headers:{...deletion.headers,"x-scikeel-manual-approval":"1"}});
  assert.notEqual(approved.status,403);
  const foreign=await client.request("/session/owned",{...deletion,headers:{origin:"https://foreign.invalid","x-scikeel-manual-approval":"1"}});
  assert.equal(foreign.status,403);
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
test("conversation attachments persist on real managed messages and reject another user", async () => {
  const root = await mkdtemp(join(tmpdir(), "scikeel-attachment-platform-"));
  const home = join(root, "codex-home"); await mkdir(home);
  await writeFile(join(home, "auth.json"), '{"auth":true}');
  await writeFile(join(home, "config.toml"), 'model = "fixture-model"\n');
  const cliRuntime = new CliRuntimeManager({ rootDir: join(root, "cli"), codexHome: home,
    codexCommand: process.execPath, codexArgs: [fakeCli, "codex"] });
  const f = await makeFixture({ root, cliRuntime }); const client = makeClient(f.base);
  const account = await login(client, "admin", "admin-password"); await client.request("/"); await cliRuntime.setUserRuntime(account.user.id, "codex");
  const post = (path, value) => client.request(path, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(value) });
  const draft = await json(await post("/api/attachments/drafts", {}));
  const upload = await client.request(`/api/attachments/upload?draftId=${draft.id}&name=data.csv`, { method: "POST", body: "value\n2\n4\n" });
  assert.equal(upload.status, 201); const file = await upload.json();
  const session = await json(await post("/session", { title: "Attachment fixture" }));
  const prompt = { parts: [{ type: "text", text: "Read data.csv" }], attachmentTurn: { draftId: draft.id, turnId: "turn_fixture", attachmentIds: [file.id] } };
  assert.equal((await post(`/session/${session.id}/prompt_async`, prompt)).status, 202);
  let history;
  for (let n = 0; n < 100; n++) {
    history = await json(await client.request(`/session/${session.id}/message`));
    if (history.length > 1) break; await new Promise((done) => setTimeout(done, 20));
  }
  assert.equal(history[0].attachments[0].id, file.id); assert.equal(history[0].parts[0].text, "Read data.csv");
  assert.equal((await post(`/session/${session.id}/prompt_async`, prompt)).status, 202);
  assert.equal((await cliRuntime.getOwnedSession(account.user.id, session.id)).session.history.filter((m) => m.info.role === "user").length, 1);
  const follow = await post(`/session/${session.id}/prompt_async`, { parts: [{ type: "text", text: "Read it again" }], attachmentTurn: { turnId: "turn_follow", attachmentIds: [] } });
  assert.equal(follow.status, 202);
  await f.authStore.createUser({ username: "other", password: "other-password" }); const other = makeClient(f.base); await login(other, "other", "other-password");
  assert.equal((await other.request(`/api/attachments?sessionId=${session.id}`)).status, 404);
  const copy = await json(await post(`/session/${session.id}/fork`, {}));
  const removed = await client.request(`/session/${session.id}`, { method: "DELETE" }); assert.equal(removed.status, 200);
  assert.equal((await client.request(`/api/attachments?sessionId=${session.id}`)).status, 404);
  const forked = await json(await client.request(`/api/attachments?sessionId=${copy.id}`)); assert.equal(forked.attachments[0].sha256, file.sha256);
});
test("sandbox conversations send owned attachment copies and retain decorated history through the managed runtime proxy",async()=>{
  const policy=new TenantPolicy();const writes=[];
  const workspaceFiles={call:async(context,value)=>{assert.ok(policy.account(context));writes.push(value);return {};}};
  const f=await makeFixture({tenantPolicy:policy,workspaceFiles});const client=makeClient(f.base);
  const {user}=await login(client,"admin","admin-password");const instanceId=`user-${user.id}`;
  const worker=await f.manager.ensureWorker({instanceId,userId:user.id});
  f.manager.getWorker=((original)=>(id)=>({...original.call(f.manager,id),generation:1}))(f.manager.getWorker);
  const account={userId:user.id,instanceId,generation:1,workspaceDir:worker.workspaceDir};policy.registerAccount(account);
  policy.registerSession(account,{id:"owned",directory:worker.workspaceDir+"/project"});
  const post=(path,value)=>client.request(path,{method:"POST",headers:{"content-type":"application/json",origin:f.base},body:JSON.stringify(value)});
  const draft=await json(await post("/api/attachments/drafts",{}));
  const file=await json(await client.request(`/api/attachments/upload?draftId=${draft.id}&name=data.csv`,{method:"POST",body:"x,y\n1,2\n"}));
  const prompt={parts:[{type:"text",text:"Read the actual data"}],attachmentTurn:{draftId:draft.id,turnId:"turn-a",attachmentIds:[file.id]}};
  const response=await post("/session/owned/prompt_async",prompt);assert.equal(response.status,202,await response.text());
  const history=await json(await client.request("/session/owned/message"));
  assert.equal(history[0].attachments[0].id,file.id);
  assert.ok(history[0].fixtureSystem.includes(`${worker.workspaceDir}/.scikeel/attachments/owned/`));
  assert.ok(!history[0].fixtureSystem.includes("/attachments/users/"));
  const chunks=writes.filter(value=>value.operation==="writeChunk");assert.equal(Buffer.from(chunks[0].bytes).toString(),"x,y\n1,2\n");
  assert.equal((await post("/session/owned/prompt_async",prompt)).status,202);
  assert.equal((await json(await client.request("/session/owned/message"))).length,1);
});


test("managed Web identifies cookie authentication without exposing a worker token", async () => {
  const root = await mkdtemp(join(tmpdir(), "osd-platform-cookie-web-"));
  const webRoot = join(root, "web");
  await mkdir(webRoot);
  await writeFile(join(webRoot, "index.html"), "<!doctype html><html><head></head><body>web</body></html>");
  const fixture = await makeFixture({ root, webRoot, tenantPolicy: {} });
  const admin = makeClient(fixture.base);
  await login(admin, "admin", "admin-password");
  for (let reload = 0; reload < 2; reload++) {
    const web = await admin.request("/live");
    assert.equal(web.status, 200);
    assert.equal(web.headers.get("location"), null);
    assert.match(await web.text(), /window\.__OS_PLATFORM__=true/);
    assert.equal(admin.jar.has("osd_worker_bootstrap"), false);
  }
  assert.equal(fixture.manager.listWorkers().length, 0);
});

test("managed model routes use the current tenant's OpenCode catalog and report failures without static fallback", async () => {
  const policy = new TenantPolicy();
  const fixture = await makeFixture({ tenantPolicy: policy });
  const client = makeClient(fixture.base);
  const { user } = await login(client, "admin", "admin-password");
  const instanceId = `user-${user.id}`;
  const worker = await fixture.manager.ensureWorker({ instanceId, userId: user.id });
  policy.registerAccount({ userId: user.id, instanceId, generation: 1, workspaceDir: worker.workspaceDir });
  fixture.manager.getWorker = ((original) => (id) => ({ ...original.call(fixture.manager, id), generation: 1 }))(fixture.manager.getWorker);
  let calls = 0;
  fixture.server.runtimeCatalog = async (context, { access }) => {
    assert.equal(context.userId, user.id);
    assert.equal(context.workspaceDir, worker.workspaceDir);
    assert.equal(context.generation, 1);
    assert.equal(typeof access.token, "string");
    calls++;
    return { model: "research/live-model", providers: [{ id: "research", name: "Research", models: {
      "live-model": { id: "live-model", name: "Live Model", providerID: "research" },
    } }], connected: ["research"], defaults: { research: "live-model" } };
  };
  assert.deepEqual(await json(await client.request("/global/config")), { model: "research/live-model" });
  const catalog = await json(await client.request("/config/providers"));
  assert.equal(catalog.providers[0].models["live-model"].name, "Live Model");
  assert.deepEqual(catalog.default, { research: "live-model" });
  const providers = await json(await client.request("/provider"));
  assert.deepEqual(providers.connected, ["research"]);
  assert.equal(calls, 3);
  fixture.server.runtimeCatalog = async () => { throw Object.assign(new Error("OpenCode model catalog unavailable"), { statusCode: 503 }); };
  const failed = await client.request("/config/providers");
  assert.equal(failed.status, 503);
  assert.deepEqual(await json(failed), { error: "managed runtime unavailable" });
});

test("login preloads public client assets without starting a workspace, and the authenticated app includes a login preparation screen", async () => {
  const root = await mkdtemp(join(tmpdir(), "scikeel-login-preparation-"));
  const webRoot = join(root, "web");
  await mkdir(join(webRoot, "assets"), { recursive: true });
  await writeFile(join(webRoot, "index.html"), '<html><head><script type="module" src="/assets/app.js"></script><link rel="stylesheet" href="/assets/app.css"></head><body><div id="root"></div></body></html>');
  await writeFile(join(webRoot, "assets/app.js"), 'window.fixtureClient = true;');
  const fixture = await makeFixture({ root, webRoot });
  const page = await fetch(fixture.base + "/login");
  const html = await page.text();
  assert.match(html, /rel="modulepreload" href="\/assets\/app.js"/);
  assert.match(html, /scikeel.login.pending/);
  const asset = await fetch(fixture.base + "/assets/app.js", { redirect: "manual" });
  assert.equal(asset.status, 200);
  assert.equal(await asset.text(), 'window.fixtureClient = true;');
  assert.equal(fixture.manager.listWorkers().length, 0);
  const unauthenticated = await fetch(fixture.base + "/v1/whoami", { redirect: "manual" });
  assert.equal(unauthenticated.status, 401);
  const client = makeClient(fixture.base);
  await login(client, "admin", "admin-password");
  await client.request("/");
  const app = await client.request("/");
  assert.equal(app.status, 200);
  assert.match(await app.text(), /scikeel:login-ready/);
});

test('conversation collaboration defaults are owned, unavailable without runtime, and proposals cannot approve',async()=>{
  const f=await makeFixture();const c=makeClient(f.base);await login(c,'admin','admin-password');
  await c.request('/v1/health');const session={id:'owned'};
  const r=await c.request(`/api/collaboration/${session.id}`);assert.equal(r.status,200);const body=await r.json();assert.equal(body.state.mode,'collaborative');assert.equal(body.available,false);
  const missing=await c.request('/api/collaboration/ses_missing');assert.equal(missing.status,404);
  const invalid=await c.request(`/api/collaboration/${session.id}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'mode',mode:'unknown',revision:0})});assert.equal(invalid.status,400);
});

for(const mode of ["collaborative","guided","delegated"]) test(`managed ${mode} enforces pending decisions on ordinary prompts and preserves confirmed context`,async(t)=>{
 const policy=new TenantPolicy();const f=await makeFixture({tenantPolicy:policy});const c=makeClient(f.base);
 const {user}=await login(c,"admin","admin-password");const instanceId=`user-${user.id}`;
 const w=await f.manager.ensureWorker({instanceId,userId:user.id});
 let reportedStatus='starting';
 f.manager.getWorker=((original)=>(id)=>({...original.call(f.manager,id),userId:user.id,generation:1,status:reportedStatus}))(f.manager.getWorker);
 const account={userId:user.id,instanceId,generation:1,workspaceDir:w.workspaceDir};policy.registerAccount(account);policy.registerSession(account,{id:"owned",directory:w.workspaceDir+"/project"});
 const post=(path,value)=>c.request(path,{method:"POST",headers:{"content-type":"application/json",origin:f.base},body:JSON.stringify(value)});
 await f.server.runtimeCollaboration(account,{action:"capability",sessionId:"capability"});
 await assert.rejects(f.server.runtimeCollaboration(account,{action:"guard",sessionId:"owned"}),/unavailable/);
 reportedStatus="running";
 const loaded=await c.request('/api/collaboration/owned');assert.equal(loaded.status,200,await loaded.clone().text());assert.equal((await json(loaded)).available,true);
 await post('/api/collaboration/owned',{action:'heartbeat',pageId:'page'});
 if(mode!=='collaborative')assert.equal((await post('/api/collaboration/owned',{action:'mode',mode,revision:0})).status,200);
 const prompt={parts:[{type:'text',text:'Research'}],system:'Retain this context'};
 assert.equal((await post('/session/owned/prompt_async',prompt)).status,202);
 const guarded=await f.server.runtimeCollaboration(account,{action:'guard',sessionId:'owned'});assert.ok(guarded.policy.includes('mode: '+mode));
 const waiting=await f.server.runtimeCollaboration(account,{action:'checkpoint',sessionId:'owned',kind:mode==='guided'?'step':'method',question:'Which method?',suggestedAnswer:'Method A'});
 assert.equal((await f.server.runtimeCollaboration(account,{action:'guard',sessionId:'owned'})).blocked,true);
 const nativeFetch=globalThis.fetch;
 const access=f.manager.getWorkerAccess(instanceId);
 globalThis.fetch=async(input,options)=>{
   const url=new URL(String(input));
   if(url.origin===new URL(access.url).origin&&['/session/child','/session/grandchild'].includes(url.pathname))return new Response(JSON.stringify({id:url.pathname.endsWith('/grandchild')?'grandchild':'child',parentID:url.pathname.endsWith('/grandchild')?'child':'owned',directory:w.workspaceDir+'/project'}),{headers:{'content-type':'application/json'}});
   return nativeFetch(input,options);
 };
 t.after(()=>{globalThis.fetch=nativeFetch;});
 assert.equal((await f.server.runtimeCollaboration(account,{action:'guard',sessionId:'grandchild'})).blocked,true);
 assert.equal((await post('/session/grandchild/prompt_async',prompt)).status,409);

 assert.equal((await post('/session/owned/prompt_async',prompt)).status,409);
 await assert.rejects(f.server.runtimeCollaboration(account,{action:'answer',sessionId:'owned',answer:'Method A'}),/denied/);
 const pending=waiting.state.pending;
 assert.equal((await post('/api/collaboration/owned',{action:'answer',id:pending.id,execution:pending.execution,revision:waiting.state.revision,answer:'Method B'})).status,200);
 assert.equal((await f.server.runtimeCollaboration(account,{action:'guard',sessionId:'owned'})).blocked,false);
 await f.server.collaboration.settled({userId:user.id,sessionId:'owned'});
 assert.equal((await post('/session/owned/prompt_async',prompt)).status,202);
 const history=await json(await c.request('/session/owned/message'));
 const bashRule=history[0].fixturePermission.filter(rule=>rule.permission==="bash"||rule.permission==="*").at(-1);
 assert.equal(bashRule.action,mode==="delegated"?"allow":"ask");
 assert.ok(history[0].fixtureSystem.includes('Retain this context'));assert.ok(history[0].fixtureSystem.includes('mode: '+mode));assert.ok(history.some(message=>message.fixtureSystem?.includes('Method B')));
 assert.equal((await c.request('/api/collaboration/owned',{method:'POST',headers:{'content-type':'application/json','sec-fetch-site':'cross-site'},body:'{"action":"pause"}'})).status,403);
});

test("disconnecting during worker startup cannot leave an orphaned operation lease", async () => {
  const f=await makeFixture();const client=makeClient(f.base);await login(client,"admin","admin-password");
  await client.request("/v1/health");
  const original=f.manager.ensureWorker.bind(f.manager);
  let enter,continueStartup;
  const entered=new Promise(resolve=>{enter=resolve;});
  const resumed=new Promise(resolve=>{continueStartup=resolve;});
  f.manager.ensureWorker=async input=>{enter();await resumed;return original(input);};
  let retained=0;f.manager.retainWorker=()=>{retained++;return {release(){}};};
  const abort=new AbortController();
  const request=client.request("/v1/health",{signal:abort.signal}).catch(()=>{});
  await entered;abort.abort();await request;
  await new Promise(resolve=>setTimeout(resolve,30));continueStartup();
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(retained,0);
});


test("completed managed synchronous replies allow the next turn without settling active parents", async (t) => {
  const policy = new TenantPolicy();
  const f = await makeFixture({ tenantPolicy: policy });
  const c = makeClient(f.base);
  const { user } = await login(c, "admin", "admin-password");
  const instanceId = `user-${user.id}`;
  const w = await f.manager.ensureWorker({ instanceId, userId: user.id });
  f.manager.getWorker = ((original) => (id) => ({ ...original.call(f.manager, id), userId: user.id, generation: 1, status: "running" }))(f.manager.getWorker);
  const owner = { userId: user.id, instanceId, generation: 1, workspaceDir: w.workspaceDir };
  policy.registerAccount(owner);
  policy.registerSession(owner, { id: "owned", directory: w.workspaceDir + "/project" });
  await f.server.runtimeCollaboration(owner, { action: "capability", sessionId: "capability" });
  const access = f.manager.getWorkerAccess(instanceId);
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin === new URL(access.url).origin && url.pathname === "/session/child")
      return new Response(JSON.stringify({ id: "child", parentID: "owned", directory: w.workspaceDir + "/project" }));
    if (url.origin === new URL(access.url).origin && ["/session/owned/message", "/session/child/message"].includes(url.pathname) && init?.method === "POST")
      return new Response(JSON.stringify({ info: { id: "msg_finished", role: "assistant", sessionID: url.pathname.split("/")[2], time: { completed: Date.now() } }, parts: [{ type: "text", text: "Done" }] }), { headers: { "content-type": "application/json" } });
    return nativeFetch(input, init);
  };
  t.after(() => { globalThis.fetch = nativeFetch; });
  const post = (path, body) => c.request(path, { method: "POST", headers: { "content-type": "application/json", origin: f.base }, body: JSON.stringify(body) });
  await post("/api/collaboration/owned", { action: "heartbeat", pageId: "page" });
  const prompt = { parts: [{ type: "text", text: "Reply" }] };
  for (let i = 0; i < 2; i++) {
    const r = await post("/session/owned/message", prompt);
    assert.equal(r.status, 200, await r.text());
    assert.equal((await json(await c.request("/api/collaboration/owned"))).state.phase, "idle");
  }
  const current = (await json(await c.request("/api/collaboration/owned"))).state;
  await f.server.collaboration.begin(current, current.revision);
  policy.registerSession(owner, { id: "child", parentID: "owned", directory: w.workspaceDir + "/project" });
  const childReply = await post("/session/child/message", prompt);
  assert.equal(childReply.status, 200, await childReply.text());
  assert.equal((await json(await c.request("/api/collaboration/owned"))).state.phase, "running");
});

test('managed network binds a running owned call, current execution and real permission reply', async t => {
  const policy = new TenantPolicy(); const f = await makeFixture({ tenantPolicy: policy });
  const c = makeClient(f.base); const { user } = await login(c, 'admin', 'admin-password');
  const instanceId = `user-${user.id}`; const w = await f.manager.ensureWorker({ instanceId, userId: user.id });
  f.manager.getWorker = ((original) => id => ({ ...original.call(f.manager, id), userId: user.id, generation: 1, status: 'running' }))(f.manager.getWorker);
  const context = { userId: user.id, instanceId, generation: 1, workspaceDir: w.workspaceDir };
  policy.registerAccount(context); policy.registerSession(context, { id: 'owned', directory: w.workspaceDir + '/project' });
  const grants = [], revoked = [];
  f.server.configureNetwork({ grant(value) { grants.push(value); return { id: String(grants.length).padStart(64, '0'), expiresAt: value.expiresAt }; }, revokeGrant(_context, id) { revoked.push(id); return true; } });
  const access = f.manager.getWorkerAccess(instanceId), nativeFetch = globalThis.fetch;
  let permissionReply, terminal = false;
  globalThis.fetch = async (input, options) => {
    const url = new URL(String(input));
    if (url.origin === new URL(access.url).origin) {
      if (url.pathname === '/session/owned/message') return new Response(JSON.stringify([{ info: { id: 'msg_a', sessionID: 'owned', role: 'assistant' }, parts: [{ type: 'tool', callID: 'call_fetch', tool: 'webfetch', state: { status: terminal ? 'completed' : 'running', input: { url: 'https://science.example/data', timeout: 10 } } }] }]));
      if (url.pathname === '/permission') return new Response(JSON.stringify([{ id: 'req_a', sessionID: 'owned', permission: 'webfetch', patterns: ['https://science.example/data'], tool: { messageID: 'msg_a', callID: 'call_fetch' } }]));
      if (url.pathname === '/permission/req_a/reply') { await new Promise(resolve => { permissionReply = resolve; }); return new Response('{}'); }
    }
    return nativeFetch(input, options);
  };
  t.after(async () => { globalThis.fetch = nativeFetch; await f.server.network.revokeContext(context); });
  const owner = { userId: user.id, sessionId: 'owned', directory: w.workspaceDir + '/project' };
  await f.server.collaboration.heartbeat(owner, 'page');
  await f.server.collaboration.setMode(owner, 'guided', 0);
  const state = await f.server.collaboration.begin(owner, 1);
  const proposal = { version: 1, action: 'authorize', sessionId: 'owned', callId: 'call_fetch', tool: 'webfetch', execution: state.execution, origins: ['https://science.example'] };
  await assert.rejects(f.server.runtimeNetwork(context, proposal), { code: 'tool_permission_denied' }); assert.equal(grants.length, 0);
  await c.request('/permission');
  const forwarded = c.request('/permission/req_a/reply', { method: 'POST', headers: { 'content-type': 'application/json', origin: f.base }, body: JSON.stringify({ reply: 'once' }) });
  for (let i = 0; !permissionReply && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(permissionReply);
  const authorized = f.server.runtimeNetwork(context, proposal);
  permissionReply(); assert.equal((await forwarded).status, 200);
  const operation = await authorized; assert.equal(grants.length, 1); assert.ok(operation.expiresAt <= Date.now() + 10000);
  await assert.rejects(f.server.runtimeNetwork({ ...context, generation: 2 }, proposal));
  await assert.rejects(f.server.runtimeNetwork(context, { ...proposal, origins: ['https://foreign.example'] }));
  assert.equal(grants.length, 1);
  await f.server.runtimeNetwork(context, { version: 1, action: 'complete', operationId: operation.operationId }); assert.equal(revoked.length, 1);
  terminal = true; await assert.rejects(f.server.runtimeNetwork(context, proposal));
});

test('gateway outcome overlays preserve raw history, remove forged metadata and require matching Stop', async () => {
  const f = await makeFixture(); const { makeToolOutcome } = await import('../../../packages/sdk/src/tool-outcome.mjs');
  const owner = { userId: 'a', sessionId: 'ses_a', execution: 1 };
  const part = { type: 'tool', callID: 'call_a', tool: 'research_delivery', state: { status: 'error', error: 'Research checkpoint service unavailable', metadata: { scikeelOutcome: makeToolOutcome('execution_cancelled', { source: 'gateway', correlationId: 'call_a' }) } } };
  assert.equal((await f.server.decorateToolPart('a', 'ses_a', part)).state.metadata.scikeelOutcome, undefined);
  const business = makeToolOutcome('delivery_missing_input', { source: 'collaboration', correlationId: 'call_a', details: { path: 'input.csv' } });
  await f.server.toolOutcomes.record(owner, 'call_a', business);
  const decorated = await f.server.decorateToolPart('a', 'ses_a', part);
  assert.equal(decorated.state.error, part.state.error); assert.equal(decorated.state.metadata.scikeelOutcome.code, business.code);
  assert.equal(part.state.metadata.scikeelOutcome.code, 'execution_cancelled');
  assert.equal((await f.server.decorateToolPart('b', 'ses_a', part)).state.metadata.scikeelOutcome, undefined);
  await f.server.toolOutcomes.recordStop(owner, ['call_abort']);
  const aborted = { type: 'tool', callID: 'call_abort', tool: 'bash', state: { status: 'error', error: 'Tool execution aborted' } };
  assert.equal((await f.server.decorateToolPart('a', 'ses_a', aborted)).state.metadata.scikeelOutcome.code, 'execution_cancelled');
  assert.equal((await f.server.decorateToolPart('a', 'ses_other', aborted)).state.metadata.scikeelOutcome, undefined);
  const successful = { ...aborted, state: { status: 'completed', output: 'Actual completed result' } };
  assert.equal((await f.server.decorateToolPart('a', 'ses_a', successful)).state.metadata.scikeelOutcome, undefined);
});

test('an identical edit is unchanged only after an owned read; stopped and foreign paths are not read', async () => {
  const policy = new TenantPolicy(); const f = await makeFixture({ tenantPolicy: policy });
  const c = makeClient(f.base); const { user } = await login(c, 'admin', 'admin-password');
  const instanceId = `user-${user.id}`, worker = await f.manager.ensureWorker({ instanceId, userId: user.id });
  f.manager.getWorker = ((original) => id => ({ ...original.call(f.manager, id), userId: user.id, generation: 1, status: 'running' }))(f.manager.getWorker);
  const context = { userId: user.id, instanceId, generation: 1, workspaceDir: worker.workspaceDir };
  policy.registerAccount(context); policy.registerSession(context, { id: 'owned', directory: worker.workspaceDir + '/project' });
  const owner = { userId: user.id, sessionId: 'owned', directory: worker.workspaceDir + '/project', workspaceDir: worker.workspaceDir };
  await f.server.collaboration.heartbeat(owner, 'page'); const state = await f.server.collaboration.begin(owner, 0);
  let reads = 0;
  f.server.researchTasks.workspace = { readReport: async (_owner, path) => { reads++; assert.equal(path, 'input.txt'); return 'requested text already present'; } };
  const part = { type: 'tool', tool: 'edit', callID: 'call_edit', state: { status: 'error', error: 'No changes to apply: oldString and newString are identical.', input: { filePath: 'input.txt', oldString: 'requested text', newString: 'requested text' } } };
  const verified = await f.server.decorateToolPart(user.id, 'owned', part);
  assert.equal(verified.state.metadata.scikeelOutcome.details.verifiedNoChange, true); assert.equal(reads, 1);
  const foreign = { ...part, callID: 'call_foreign', state: { ...part.state, input: { ...part.state.input, filePath: '/etc/passwd' } } };
  assert.equal((await f.server.decorateToolPart(user.id, 'owned', foreign)).state.metadata.scikeelOutcome, undefined); assert.equal(reads, 1);
  await f.server.toolOutcomes.recordStop({ ...owner, execution: state.execution }, ['call_stopped']);
  assert.equal((await f.server.decorateToolPart(user.id, 'owned', { ...part, callID: 'call_stopped' })).state.metadata.scikeelOutcome, undefined); assert.equal(reads, 1);
});

test('Stop records intent before forwarding and only a successful response confirms cancellation', async t => {
  const policy = new TenantPolicy(), f = await makeFixture({ tenantPolicy: policy });
  const c = makeClient(f.base), { user } = await login(c, 'admin', 'admin-password');
  const instanceId = `user-${user.id}`, worker = await f.manager.ensureWorker({ instanceId, userId: user.id });
  f.manager.getWorker = ((original) => id => ({ ...original.call(f.manager, id), userId: user.id, generation: 1, status: 'running' }))(f.manager.getWorker);
  const context = { userId: user.id, instanceId, generation: 1, workspaceDir: worker.workspaceDir };
  policy.registerAccount(context); policy.registerSession(context, { id: 'owned', directory: worker.workspaceDir + '/project' });
  const owner = { userId: user.id, sessionId: 'owned', directory: worker.workspaceDir + '/project' };
  await f.server.collaboration.heartbeat(owner, 'page'); const state = await f.server.collaboration.begin(owner, 0);
  const access = f.manager.getWorkerAccess(instanceId), original = globalThis.fetch; let status = 502;
  const part = { type: 'tool', tool: 'bash', callID: 'call_stop', state: { status: 'running', input: { command: 'fixture' } } };
  globalThis.fetch = async (input, options) => {
    const url = new URL(String(input));
    if (url.origin === new URL(access.url).origin) {
      if (url.pathname === '/session/owned/message') return new Response(JSON.stringify([{ parts: [part] }]));
      if (url.pathname === '/session/owned/children') return new Response('[]');
      if (url.pathname === '/session/owned/abort') {
        const saved = await f.server.toolOutcomes.list({ ...owner, execution: state.execution });
        assert.equal(saved.stops.confirmed, false); assert.deepEqual(saved.stops.callIds, ['call_stop']);
        return new Response('{}', { status });
      }
    }
    return original(input, options);
  };
  t.after(() => { globalThis.fetch = original; });
  const stop = () => c.request('/session/owned/abort', { method: 'POST', headers: { origin: f.base, 'content-type': 'application/json' }, body: '{}' });
  assert.equal((await stop()).status, 502);
  const aborted = { ...part, state: { status: 'error', error: 'Tool execution aborted' } };
  assert.equal((await f.server.decorateToolPart(user.id, 'owned', aborted)).state.metadata.scikeelOutcome, undefined);
  status = 200; assert.equal((await stop()).status, 200);
  assert.equal((await f.server.decorateToolPart(user.id, 'owned', aborted)).state.metadata.scikeelOutcome.code, 'execution_cancelled');
});

test('an authenticated always decision covers only its origin and active owned execution', async t => {
  const policy = new TenantPolicy(), f = await makeFixture({ tenantPolicy: policy });
  const c = makeClient(f.base), { user } = await login(c, 'admin', 'admin-password');
  const instanceId = `user-${user.id}`, worker = await f.manager.ensureWorker({ instanceId, userId: user.id });
  f.manager.getWorker = ((original) => id => ({ ...original.call(f.manager, id), userId: user.id, generation: 1, status: 'running' }))(f.manager.getWorker);
  const context = { userId: user.id, instanceId, generation: 1, workspaceDir: worker.workspaceDir };
  policy.registerAccount(context); policy.registerSession(context, { id: 'owned', directory: worker.workspaceDir + '/project' });
  const grants = [];
  f.server.configureNetwork({ grant(value) { grants.push(value); return { id: String(grants.length).padStart(64, '0'), expiresAt: value.expiresAt }; }, revokeGrant() { return true; } });
  const owner = { userId: user.id, sessionId: 'owned', directory: worker.workspaceDir + '/project' };
  await f.server.collaboration.heartbeat(owner, 'page'); await f.server.collaboration.setMode(owner, 'guided', 0); const state = await f.server.collaboration.begin(owner, 1);
  const access = f.manager.getWorkerAccess(instanceId), original = globalThis.fetch;
  let callId = 'call_first', origin = 'https://science.example';
  globalThis.fetch = async (input, options) => {
    const url = new URL(String(input));
    if (url.origin === new URL(access.url).origin) {
      if (url.pathname === '/session/owned/message') return new Response(JSON.stringify([{ parts: [{ type: 'tool', tool: 'webfetch', callID: callId, state: { status: 'running', input: { url: origin + '/data' } } }] }]));
      if (url.pathname === '/permission') return new Response(JSON.stringify([{ id: 'req_always', sessionID: 'owned', permission: 'webfetch', patterns: [origin + '/data'], tool: { callID: callId } }]));
      if (url.pathname === '/permission/req_always/reply') return new Response('{}');
    }
    return original(input, options);
  };
  t.after(async () => { globalThis.fetch = original; await f.server.network.revokeContext(context); });
  await c.request('/permission');
  assert.equal((await c.request('/permission/req_always/reply', { method: 'POST', headers: { origin: f.base, 'content-type': 'application/json' }, body: JSON.stringify({ reply: 'always' }) })).status, 200);
  callId = 'call_later';
  const proposal = () => ({ version: 1, action: 'authorize', sessionId: 'owned', callId, tool: 'webfetch', execution: state.execution, origins: [origin] });
  const result = await f.server.runtimeNetwork(context, proposal()); assert.equal(grants.length, 1);
  await f.server.runtimeNetwork(context, { version: 1, action: 'complete', operationId: result.operationId });
  callId = 'call_foreign'; origin = 'https://foreign.example';
  await assert.rejects(f.server.runtimeNetwork(context, proposal()), { code: 'tool_permission_denied' }); assert.equal(grants.length, 1);
});
