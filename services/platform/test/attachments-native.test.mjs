import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Readable } from "node:stream";
import { AttachmentStore } from "../src/attachments.mjs";
import { AttachmentTurns } from "../src/attachment-turns.mjs";

// Opt-in contract check against the installed OpenCode, without remote model calls.
test("installed OpenCode accepts actual image parts and durable message attachment IDs", { skip: !process.env.OSD_ATTACHMENTS_NATIVE, timeout: 120000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "scikeel-native-attachments-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const images = [];
  const providerRequests = [];
  const relay = createServer(async (request, response) => {
    let raw = ""; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    providerRequests.push(body);
    for (const message of body.messages ?? []) for (const part of Array.isArray(message.content) ? message.content : []) {
      if (part.type === "image_url") images.push(Buffer.from(part.image_url.url.split(",")[1], "base64"));
    }
    if (body.stream) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const chunk of [
        { id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "Image bytes received." }, finish_reason: null }] },
        { id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
      ]) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      response.end("data: [DONE]\n\n");
    } else {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "fixture", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "Image bytes received." }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    }
  });
  await new Promise((done) => relay.listen(0, "127.0.0.1", done));
  t.after(async () => { if (relay.listening) await new Promise((done) => relay.close(done)); });
  const privateHome = join(root, "home"); await mkdir(privateHome);
  const workspace = join(root, "workspace"); await mkdir(workspace);
  const release = resolve("../../.deploy/osd/releases/0.5.2");
  const binary = process.env.OSD_ATTACHMENTS_NATIVE_BIN || join(release, "opencode");

  const configuration = { enabled_providers: ["attachment-fixture"], model: "attachment-fixture/pixels", small_model: "attachment-fixture/pixels", plugin: [], provider: { "attachment-fixture": { npm: "@ai-sdk/openai-compatible", name: "Attachment fixture", options: { baseURL: `http://127.0.0.1:${relay.address().port}/v1`, apiKey: "fixture" }, models: { pixels: { name: "Pixels", modalities: { input: ["text", "image"], output: ["text"] }, limit: { context: 32000, output: 1000 } } } } } };
  const configDir = join(root, "config", "opencode"); mkdirSync(configDir, { recursive: true }); writeFileSync(join(configDir, "opencode.json"), JSON.stringify(configuration), { mode: 0o600 });
  // Fresh OpenCode installs resolve their plugin package before serving an
  // instance. Reuse the released, already-installed dependencies offline.
  await cp(join(release, "resources", "goal-plugin", "node_modules"), join(configDir, "node_modules"), { recursive: true });
  await cp(join(release, "resources", "goal-plugin", "package.json"), join(configDir, "package.json"));
  await cp(join(release, "resources", "goal-plugin", "package-lock.json"), join(configDir, "package-lock.json"));
  const socket = createServer(); await new Promise((done) => socket.listen(0, "127.0.0.1", done)); const port = socket.address().port; await new Promise((done) => socket.close(done));
  const child = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: workspace, env: { ...process.env, HOME: privateHome, XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"), OPENCODE_SERVER_PASSWORD: "fixture", OPENCODE_DISABLE_DEFAULT_PLUGINS: "true", OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_DISABLE_PROJECT_CONFIG: "true" }, stdio: ["ignore", "pipe", "pipe"] });
  let diagnostics = ""; child.stderr.on("data", (chunk) => diagnostics = `${diagnostics}${chunk}`.slice(-3000)); child.stdout.on("data", (chunk) => diagnostics = `${diagnostics}${chunk}`.slice(-3000));
  const store = new AttachmentStore({ rootDir: join(root, "attachments") }); await store.init();
  const request = (path, options = {}) => fetch(`http://127.0.0.1:${port}${path}`, { ...options, headers: { authorization: `Basic ${Buffer.from("opencode:fixture").toString("base64")}`, ...options.headers }, signal: AbortSignal.timeout(30000) });
  const json = (data) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
  const user = { id: "native_user" };
  const turns = new AttachmentTurns({ store, readHistory: async (_user, owner) => (await request(`/session/${owner.sessionId}/message`)).json() });
  try {
    const readyDeadline = Date.now() + 20000; let ready = false;
    while (Date.now() < readyDeadline) { try { const response = await request("/session/status"); if (response.ok) { ready = true; break; } diagnostics += ` Health ${response.status}`; } catch (error) { diagnostics += ` Probe ${error.name}`; } await new Promise((done) => setTimeout(done, 250)); }
    if (!ready) {
      const logs = join(root, "data", "opencode", "log");
      for (const name of await readdir(logs).catch(() => [])) diagnostics += `\n${(await readFile(join(logs, name), "utf8")).slice(-8000)}`;
    }
    assert.ok(ready, diagnostics);
    const created = await request("/session", json({ title: "Image contract" })); assert.equal(created.status, 200); const session = await created.json();
    const png = await readFile(resolve("../../.deploy/verification/attachment-figure.png"));
    const file = await store.upload(user.id, { sessionId: session.id }, "figure.png", Readable.from([png]));
    const owner = { sessionId: session.id };
    const prepared = await turns.prepare(user, owner, { model: { providerID: "attachment-fixture", modelID: "pixels" }, parts: [{ type: "text", text: "Describe the pixels." }], attachmentTurn: { turnId: "native_image_turn", attachmentIds: [file.id] } });
    const sent = await request(`/session/${session.id}/prompt_async`, json(prepared.body)); assert.ok([202, 204].includes(sent.status), `Native send: ${sent.status} ${await sent.text()}`); await prepared.finish(true);
    let history = []; const deadline = Date.now() + 35000;
    while (Date.now() < deadline) {
      history = await (await request(`/session/${session.id}/message`)).json();
      if (history.some((m) => m.info.role === "assistant" && m.info.time?.completed)) break;
      await new Promise((done) => setTimeout(done, 250));
    }
    history = await turns.decorate(user, owner, history);
    const message = history.find((m) => m.info.role === "user");
    assert.equal(message.attachments[0].sha256, createHash("sha256").update(png).digest("hex"));
    assert.ok(message.info.id.startsWith("msg_"));
    assert.ok(images.some((image) => image.equals(png)), "the installed runtime must deliver image bytes to its provider");
    const assistant = history.find((m) => m.info.role === "assistant" && m.info.time?.completed); assert.ok(assistant); assert.equal(assistant.info.error, undefined);
    const greetingCreated = await request("/session", json({ title: "Greeting contract" }));
    assert.equal(greetingCreated.status, 200);
    const greetingSession = await greetingCreated.json();
    const greetingOwner = { sessionId: greetingSession.id };
    const greeting = await turns.prepare(user, greetingOwner, {
      model: { providerID: "attachment-fixture", modelID: "pixels" },
      parts: [{ type: "text", text: "你好" }],
      attachmentTurn: { turnId: "native_greeting_turn", attachmentIds: [] },
    });
    const requestsBeforeGreeting = providerRequests.length;
    const greetingSent = await request(`/session/${greetingSession.id}/prompt_async`, json(greeting.body));
    assert.ok([202, 204].includes(greetingSent.status));
    await greeting.finish(true);
    let greetingHistory = [];
    const greetingDeadline = Date.now() + 35000;
    while (Date.now() < greetingDeadline) {
      greetingHistory = await (await request(`/session/${greetingSession.id}/message`)).json();
      if (greetingHistory.some((message) => message.info.role === "assistant" && message.info.time?.completed)) break;
      await new Promise((done) => setTimeout(done, 250));
    }
    const greetingUser = greetingHistory.find((message) => message.info.role === "user");
    assert.ok(greetingUser);
    assert.equal(greetingUser.info.id, greeting.body.messageID);
    assert.equal(greetingUser.parts.some((part) => part.type === "text" && part.text?.includes("SciKeel attachment turn:")), false);
    const greetingAssistant = greetingHistory.find((message) => message.info.role === "assistant" && message.info.time?.completed);
    assert.ok(greetingAssistant);
    assert.equal(greetingAssistant.info.error, undefined);
    const greetingRequests = providerRequests.slice(requestsBeforeGreeting);
    assert.ok(greetingRequests.length > 0);
    assert.ok(greetingRequests.some((payload) => JSON.stringify(payload.messages).includes("你好")));
    for (const payload of greetingRequests) {
      assert.doesNotMatch(JSON.stringify(payload.messages), /SciKeel attachment turn:|Conversation attachments/);
    }
    console.log("OpenCode: native image transport, persistent message identity and marker-free greeting input passed");
  } finally {
    child.kill("SIGTERM"); await new Promise((done) => child.exitCode !== null ? done() : child.once("exit", done)); await store.close(); await new Promise((done) => relay.close(done)); await rm(root, { recursive: true, force: true });
  }
});
