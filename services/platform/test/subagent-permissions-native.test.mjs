import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutomaticToolPermissions } from "../src/automatic-tool-permissions.mjs";
import { TenantPolicy } from "../src/tenant-policy.mjs";
import { collaborationPermissions } from "../src/collaboration.mjs";

const binary = process.env.OSD_COLLABORATION_BINARY ??
  "/var/lib/scikeel/images/1f1699c60f57521fc2d80885787156b18b4de6930dffaf06396282f69fb93cb0/rootfs/opt/scikeel/tools/bin/opencode";
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(check, diagnostics) {
  const deadline = Date.now() + 20000; let lastError;
  while (Date.now() < deadline) {
    const result = await check().catch(error => { lastError = error; return false; });
    if (result) return result;
    await delay(50);
  }
  throw new Error(`Subagent permission check timed out: ${lastError?.message ?? ""} ${diagnostics()}`);
}

test("actual task subagents execute workspace commands without manual permission replies", {
  skip: !existsSync(binary), timeout: 60000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "scikeel-subagent-permissions-"));
  const workspace = join(root, "workspace");
  const cfg = join(root, "config");
  await mkdir(workspace);
  await mkdir(join(cfg, "opencode"), { recursive: true });
  await writeFile(join(root, ".npmrc"), "registry=http://127.0.0.1:1\nfetch-retries=0\nfetch-timeout=1000\n");
  await writeFile(join(workspace, ".gitignore"), "");
  await writeFile(join(root, "outside-workspace.txt"), "Must remain inaccessible through the read tool");
  const model = createServer(async (request, response) => {
    let raw = ""; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const lastUser = JSON.stringify(body.messages.findLast((message) => message.role === "user")?.content);
    const child = lastUser.includes("CHILD_AUTONOMY_PROBE");
    const results = body.messages.filter((message) => message.role === "tool").length;
    const completed = child ? results >= 2 : results >= 1;
    const tool = child ? (results === 0 ? "bash" : "read") : "task";
    const args = child
      ? (results === 0
        ? { command: "printf 'automatic subagent\\n' > autonomy-result.txt", description: "Write workspace verification artifact" }
        : { filePath: join(root, "outside-workspace.txt") })
      : { subagent_type: "explore", description: "Check autonomous workspace execution", prompt: "CHILD_AUTONOMY_PROBE: write autonomy-result.txt using the bash tool, then check the read-tool workspace boundary." };
    const delta = completed ? { role: "assistant", content: "Workspace operation completed." }
      : { role: "assistant", tool_calls: [{ index: 0, id: `call_${tool}`, type: "function", function: { name: tool, arguments: JSON.stringify(args) } }] };
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const chunk of [
      { choices: [{ index: 0, delta, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: completed ? "stop" : "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    ]) response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", ...chunk })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise((done) => model.listen(0, "127.0.0.1", done));
  await writeFile(join(cfg, "opencode/opencode.json"), JSON.stringify({
    model: "fixture/local", permission: { bash: "ask", edit: "ask", external_directory: "deny", webfetch: "ask", websearch: "ask" },
    provider: { fixture: { npm: "@ai-sdk/openai-compatible", options: { baseURL: `http://127.0.0.1:${model.address().port}/v1`, apiKey: "synthetic" },
      models: { local: { name: "Local fixture", limit: { context: 32000, output: 4000 } } } } },
  }));
  const portProbe = createServer(); await new Promise((done) => portProbe.listen(0, "127.0.0.1", done));
  const port = portProbe.address().port; await new Promise((done) => portProbe.close(done));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: workspace, env: { ...process.env, HOME: root, XDG_CONFIG_HOME: cfg, XDG_DATA_HOME: join(root, "data"),
      XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"), OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "1", OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_SERVER_PASSWORD: "" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let diagnostics = ""; child.stderr.on("data", (chunk) => { diagnostics = (diagnostics + chunk).slice(-3000); });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM"); await Promise.race([new Promise((done) => child.once("exit", done)), delay(2000)]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    model.closeAllConnections(); await new Promise((done) => model.close(done));
    await rm(root, { recursive: true, force: true });
  });
  const request = async (path, body, method = body ? "POST" : "GET") => {
    const response = await fetch(origin + path, { method, headers: { "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000) });
    assert.ok(response.ok, `${path}: ${response.status}`);
    return response.status === 204 ? null : response.json();
  };
  await until(() => request("/session"), () => diagnostics);
  const start = async () => {
    const session = await request("/session", {});
    await request(`/session/${session.id}`, { permission: collaborationPermissions("autonomous") }, "PATCH");
    await request(`/session/${session.id}/prompt_async`, { parts: [{ type: "text", text: "PARENT_AUTONOMY_PROBE: delegate the workspace artifact to explore." }] });
    return session;
  };
  // Reproduce the production defect: a Full root still leaves its task child
  // waiting on bash because task creation inherits denies, not root allow rules.
  const before = await start();
  const pending = await until(async () => (await request("/permission"))[0], () => diagnostics);
  assert.equal(pending.permission, "bash");
  const blocked = await request(`/session/${pending.sessionID}`);
  assert.equal(blocked.parentID, before.id);
  assert.ok(!blocked.permission.some((rule) => rule.permission === "*" && rule.action === "allow"));
  await request(`/permission/${pending.id}/reply`, {reply:"reject"});
  await request(`/session/${blocked.id}/abort`, {});
  await request(`/session/${before.id}/abort`, {});
  await until(async () => Object.values(await request("/session/status")).every((status) => status.type === "idle"), () => diagnostics);

  const after = await start();
  const context = { userId: "fixture", instanceId: "user-fixture", generation: 1, workspaceDir: workspace };
  const policy = new TenantPolicy({ accounts: [context] });
  const automatic = new AutomaticToolPermissions({ policy,
    authority: { current: async () => {}, ensure: async (_context, id) => {
      const session = await request(`/session/${id}`);
      if (session.parentID) policy.registerSession(context, await request(`/session/${session.parentID}`));
      policy.registerSession(context, session);
    } },
    execution: async (_context, id) => {
      const session = await request(`/session/${id}`);
      assert.equal(session.parentID, after.id);
      return { owner: { sessionId: after.id }, blocked: false, state: { phase: "running", execution: 1, mode: "autonomous" } };
    },
    readSession: async (_context, id) => request(`/session/${id}`),
    patchSession: async (_context, id, permission) => request(`/session/${id}`, { permission }, "PATCH"),
    reply: async (_context, id, body) => { await request(`/permission/${id}/reply`, body); return {ok: true, status: 200}; },
  });
  let approved = 0;
  async function drain() {
    for (const pending of await request("/permission")) { assert.equal(await automatic.answer(context, pending), true); approved++; }
  }
  await until(async () => {
    await drain();
    return await readFile(join(workspace, "autonomy-result.txt"), "utf8") === "automatic subagent\n";
  }, () => diagnostics);
  await until(async () => { await drain(); return Object.values(await request("/session/status")).every((status) => status.type === "idle"); }, () => diagnostics);
  assert.ok(approved > 0);
  assert.deepEqual(await request("/permission"), []);
  const descendants = await request(`/session/${after.id}/children`);
  assert.equal(descendants.length, 1);
  assert.ok(descendants[0].permission.some((rule) => rule.permission === "task" && rule.action === "deny"));
  const history = await request(`/session/${descendants[0].id}/message`);
  const tools = history.flatMap((message) => message.parts).filter((part) => part.type === "tool");
  assert.ok(tools.some((part) => part.tool === "bash" && part.state.status === "completed"));
  assert.ok(tools.some((part) => part.tool === "read" && part.state.status === "error"));
});
