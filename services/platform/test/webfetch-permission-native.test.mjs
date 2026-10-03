import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Local fake model + actual pinned binary. No provider or outbound website call.
test("a webfetch without timeout remains recoverable and manually approved", {
  skip: !process.env.SCIKEEL_WEBFETCH_NATIVE, timeout: 60000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "scikeel-webfetch-"));
  const relay = createServer(async (request, response) => {
    let raw = ""; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const called = body.messages.some((message) => message.role === "tool");
    const delta = called ? { role: "assistant", content: "Permission was handled." } : {
      role: "assistant", tool_calls: [{ index: 0, id: "call_permission", type: "function", function: {
        name: "webfetch", arguments: JSON.stringify({ url: "https://example.invalid/approval-test", format: "markdown" }),
      } }],
    };
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const chunk of [
      { choices: [{ index: 0, delta, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: called ? "stop" : "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    ]) response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", ...chunk })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  let child;
  try {
    await new Promise((done) => relay.listen(0, "127.0.0.1", done));
    const workspace = join(root, "workspace"); const config = join(root, "config", "opencode");
    await mkdir(workspace); await mkdir(config, { recursive: true }); await mkdir(join(root, "home"));
    const release = "/opt/open-science-desktop/.deploy/osd/releases/0.5.2";
    await cp(join(release, "resources/goal-plugin/node_modules"), join(config, "node_modules"), { recursive: true });
    for (const file of ["package.json", "package-lock.json"]) await cp(join(release, "resources/goal-plugin", file), join(config, file));
    const plugin = join(root, "permission-guard.mjs");
    const source = pathToFileURL(resolve("../../runtime/sandbox/cli-jobs.mjs")).href;
    await writeFile(plugin, `import { ScienceEnvironmentHooks } from ${JSON.stringify(source)};
export default async () => {
  const hooks = new ScienceEnvironmentHooks({ manifest: { workspaceDir: ${JSON.stringify(workspace)}, home: ${JSON.stringify(join(root, "home"))} }, directory: ${JSON.stringify(workspace)}, imageDigest: "sha256:${"a".repeat(64)}", inspector: { call: async () => {} } });
  return { "tool.execute.before": (input, output) => hooks.beforeTool(input, output) };
};`);
    await writeFile(join(config, "opencode.json"), JSON.stringify({
      enabled_providers: ["fixture"], model: "fixture/local", small_model: "fixture/local", plugin: [plugin], permission: { webfetch: "ask" },
      provider: { fixture: { npm: "@ai-sdk/openai-compatible", name: "Fixture", options: { baseURL: `http://127.0.0.1:${relay.address().port}/v1`, apiKey: "fixture" }, models: { local: { name: "Local", limit: { context: 32000, output: 1000 } } } } },
    }));
    const socket = createServer(); await new Promise((done) => socket.listen(0, "127.0.0.1", done));
    const port = socket.address().port; await new Promise((done) => socket.close(done));
    child = spawn(process.env.SCIKEEL_WEBFETCH_NATIVE_BIN || join(release, "opencode"), ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: workspace, env: { ...process.env, HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"), OPENCODE_SERVER_PASSWORD: "fixture", OPENCODE_DISABLE_DEFAULT_PLUGINS: "true", OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_DISABLE_PROJECT_CONFIG: "true" }, stdio: ["ignore", "pipe", "pipe"],
    });
    let diagnostics = "";
    child.stdout.on("data", (chunk) => { diagnostics = `${diagnostics}${chunk}`.slice(-3000); });
    child.stderr.on("data", (chunk) => { diagnostics = `${diagnostics}${chunk}`.slice(-3000); });
    const request = (path, options = {}) => fetch(`http://127.0.0.1:${port}${path}`, { ...options, headers: { authorization: `Basic ${Buffer.from("opencode:fixture").toString("base64")}`, ...options.headers }, signal: AbortSignal.timeout(5000) });
    const post = (body) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    async function until(check) {
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) { const result = await check(); if (result) return result; await new Promise((done) => setTimeout(done, 150)); }
      assert.fail(`Native check timed out: ${diagnostics}`);
    }
    await until(async () => { try { return (await request("/session/status")).ok; } catch { return false; } });
    const session = await (await request("/session", post({ title: "Isolated approval regression" }))).json();
    const sent = await request(`/session/${session.id}/prompt_async`, post({ model: { providerID: "fixture", modelID: "local" }, parts: [{ type: "text", text: "Request webfetch and wait for manual permission." }] }));
    assert.ok([202, 204].includes(sent.status));
    const permissions = await until(async () => {
      const response = await request("/permission");
      assert.equal(response.status, 200, await response.clone().text());
      const list = await response.json(); return list.length ? list : false;
    });
    assert.equal(permissions.length, 1); assert.equal(permissions[0].sessionID, session.id);
    assert.equal(permissions[0].metadata.timeout, 60);
    assert.equal((await (await request("/session/status")).json())[session.id].type, "busy");
    // A fresh HTTP request simulates a reload after missing the original SSE ask.
    assert.equal((await (await request("/permission")).json())[0].id, permissions[0].id);
    const rejected = await request(`/permission/${permissions[0].id}/reply`, post({ reply: "reject" }));
    assert.ok(rejected.ok);
    await until(async () => !(session.id in await (await request("/session/status")).json()));
    assert.deepEqual(await (await request("/permission")).json(), []);
    const history = await (await request(`/session/${session.id}/message`)).json();
    const tool = history.flatMap((message) => message.parts).find((part) => part.type === "tool");
    assert.equal(tool.state.status, "error");
    console.log(JSON.stringify({ nativeBinary: true, omittedTimeout: 60, manualApproval: true, reloadRecovery: true, rejectedFetch: true, sessionSettled: true }));
  } finally {
    if (child && child.exitCode === null) await new Promise((done) => { child.once("exit", done); child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 3000).unref(); });
    await new Promise((done) => relay.close(done)); await rm(root, { recursive: true, force: true });
  }
});
