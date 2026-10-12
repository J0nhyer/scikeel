import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Local fake model + actual pinned binary. No provider or outbound website call.
test("the installed question tool survives a fresh reader, records an exact answer receipt, and preserves revertible history", {
  skip: !process.env.SCIKEEL_QUESTION_NATIVE, timeout: 90000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "scikeel-question-"));
  const advertisedTools=new Set();
  const relay = createServer(async (request, response) => {
    let raw = ""; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    for(const tool of body.tools ?? [])if(typeof tool.function?.name==="string")advertisedTools.add(tool.function.name);
    const called = body.messages.some((message) => message.role === "tool");
    const delta = called ? { role: "assistant", content: "Answer was handled." } : {
      role: "assistant", tool_calls: [{ index: 0, id: "call_question", type: "function", function: {
        name: "question", arguments: JSON.stringify({ questions:[{question:"Which method?",header:"Method",options:[{label:"A",description:"Use method A"}],custom:true}] }),
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
    await writeFile(join(config, "opencode.json"), JSON.stringify({
      enabled_providers: ["fixture"], model: "fixture/local", small_model: "fixture/local", permission: { question: "allow" },
      provider: { fixture: { npm: "@ai-sdk/openai-compatible", name: "Fixture", options: { baseURL: `http://127.0.0.1:${relay.address().port}/v1`, apiKey: "fixture" }, models: { local: { name: "Local", limit: { context: 32000, output: 1000 } } } } },
    }));
    const socket = createServer(); await new Promise((done) => socket.listen(0, "127.0.0.1", done));
    const port = socket.address().port; await new Promise((done) => socket.close(done));
    child = spawn(process.env.SCIKEEL_QUESTION_NATIVE_BIN || "/var/lib/scikeel/images/1f1699c60f57521fc2d80885787156b18b4de6930dffaf06396282f69fb93cb0/rootfs/opt/scikeel/tools/bin/opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
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
    const session = await (await request("/session", post({ title: "Isolated question regression" }))).json();
    const sent = await request(`/session/${session.id}/prompt_async`, post({ model: { providerID: "fixture", modelID: "local" }, parts: [{ type: "text", text: "Ask which method to use with the question tool and wait for the answer." }] }));
    assert.ok([202, 204].includes(sent.status));
    const questions = await until(async () => {
      const response=await request("/question");assert.equal(response.status,200,await response.clone().text());
      const list=await response.json();return list.length ? list : false;
    });
    assert.equal(questions.length,1);assert.equal(questions[0].sessionID,session.id);
    assert.equal(questions[0].tool.callID,"call_question");
    assert.equal((await (await request("/session/status")).json())[session.id].type,"busy");
    // Closing every event reader is not a tool cancellation.
    const streamController=new AbortController();
    const stream=await fetch(`http://127.0.0.1:${port}/event`,{headers:{authorization:`Basic ${Buffer.from("opencode:fixture").toString("base64")}`},signal:streamController.signal});
    await stream.body.getReader().read();streamController.abort();
    await new Promise(done=>setTimeout(done,250));
    assert.equal((await (await request("/question")).json())[0].id,questions[0].id);
    const answered=await request(`/question/${questions[0].id}/reply`,post({answers:[["A"]]}));assert.equal(answered.ok,true);
    await until(async()=>!(session.id in await (await request("/session/status")).json()));
    const history=await (await request(`/session/${session.id}/message`)).json();
    const tool=history.flatMap(message=>message.parts).find(part=>part.type==="tool" && part.callID==="call_question");
    assert.equal(tool.state.status,"completed");assert.deepEqual(tool.state.metadata.answers,[["A"]]);
    const stale=await request(`/question/${questions[0].id}/reply`,post({answers:[["A"]]}));
    assert.equal(stale.status,404);const staleBody=await stale.json();assert.equal(staleBody._tag,"QuestionNotFoundError");
    const userMessage=history.find(message=>message.info.role==="user");
    const reverted=await request(`/session/${session.id}/revert`,post({messageID:userMessage.info.id}));assert.equal(reverted.ok,true);
    assert.equal((await (await request(`/session/${session.id}`)).json()).revert.messageID,userMessage.info.id);
    console.log(JSON.stringify({advertisedTools:[...advertisedTools].sort(),nativeQuestion:true,freshReaderRecovery:true,exactAnswerReceipt:true,staleQuestionStatus:404,revertAfterExpiredQuestion:true}));

  } finally {
    if (child && child.exitCode === null) await new Promise((done) => { child.once("exit", done); child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 3000).unref(); });
    await new Promise((done) => relay.close(done)); await rm(root, { recursive: true, force: true });
  }
});
