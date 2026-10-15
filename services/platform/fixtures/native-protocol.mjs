import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

export const nativePin = Object.freeze({ version: "0.157.1", sourceCommit: "36650394c5b38c2990ccf2a3457165ca3e9d9726" });
const fixture = fileURLToPath(import.meta.url);
const binary = "/opt/scikeel/tools/bin/codex";
const node = "/opt/scikeel/tools/bin/node";
const root = "/fixture/native";
const port = 48177;
const pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBqkAAAAASUVORK5CYII=";

export function responsesFrame(item, id = "fixture-response") {
  return [
    { type: "response.created", response: { id } },
    { type: "response.output_item.done", item },
    { type: "response.completed", response: { id, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } },
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join("");
}

export function capabilityResult(cases) {
  const required = ["denied-command", "allowed-command", "denied-edit", "allowed-edit",
    "denied-custom", "allowed-custom", "crashed-command", "crashed-edit", "crashed-custom",
    "stopped-command", "stopped-edit", "stopped-custom",
    "allowed-question", "denied-question",
    ...["malformed", "empty", "timedout", "missing"].flatMap(mode => ["command", "edit", "custom"].map(kind => `${mode}-${kind}`))];
  const checks = Object.fromEntries(required.map(name => [name, cases.some(value => value.name === name && value.passed === true)]));
  return { checks, activationEligible: Object.values(checks).every(Boolean) };
}

export function nativeToolFacts(value) {
  return {
    reasoningEffort: typeof value.reasoning?.effort === "string" ? value.reasoning.effort : null,
    imageInput: (value.input ?? []).some(item => Array.isArray(item.content) && item.content.some(content => content.type === "input_image")),
    toolCatalog: (value.tools ?? []).map(tool => ({ type: tool.type, ...(typeof tool.name === "string" ? { name: tool.name } : {}) })),
    toolResults: (value.input ?? []).filter(item => ["function_call_output", "custom_tool_call_output"].includes(item.type))
      .map(item => typeof item.output === "string" ? item.output.slice(0,2048) : JSON.stringify(item.output).slice(0,2048)),
  };
}

export function validNativeGuardInput(value, expected) {
  return !!value && !!expected && typeof expected.thread === "string" && typeof expected.turn === "string" &&
    value.session_id === expected.thread && value.turn_id === expected.turn && value.tool_use_id === expected.call &&
    value.cwd === expected.cwd && value.tool_name === expected.tool && value.hook_event_name === "PreToolUse" &&
    isDeepStrictEqual(value.tool_input, expected.input);
}

export function nativeGuardInput(item) {
  const nativeInput = item.type === "custom_tool_call" ? item.input : JSON.parse(item.arguments);
  return { nativeTool: item.name, nativeInput, canonicalInput: item.name === "exec_command" ? { command: nativeInput.cmd }
    : item.name === "apply_patch" ? { command: nativeInput } : nativeInput };
}

async function hook() {
  let text = "";
  for await (const chunk of process.stdin) {
    text += chunk;
    if (Buffer.byteLength(text) > 1024 ** 2) process.exit(1);
  }
  const input = JSON.parse(text);
  const response = await fetch(`http://127.0.0.1:${port}/guard`, {
    method: "POST", body: JSON.stringify(input),
    signal: AbortSignal.timeout(2000),
  });
  if (!response.ok) process.exit(1);
  const { mode } = await response.json();
  if (!["allow", "deny", "crash", "timeout", "malformed", "empty"].includes(mode)) process.exit(1);
  if (mode === "crash") process.exit(1);
  if (mode === "timeout") await new Promise(resolve => setTimeout(resolve, 10000));
  if (mode === "malformed") { console.log('{"hookSpecificOutput":'); return; }
  if (mode === "empty") return;
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse",
    ...(mode === "deny" ? { permissionDecision: "deny", permissionDecisionReason: "Pending research decision" } : { permissionDecision: "allow" }) } }));
}

export async function prepareNativeProbe() {
  if (process.env.CI !== "true") throw new Error("dedicated CI fixture preparation required");
  await mkdir(".deploy/native-capabilities/config", { recursive: true });
  await mkdir(".deploy/native-capabilities/output", { recursive: true });
  const response = await fetch(`https://raw.githubusercontent.com/openai/codex/${nativePin.sourceCommit}/codex-rs/models-manager/models.json`,
    { signal: AbortSignal.timeout(20000), redirect: "error" });
  if (!response.ok) throw new Error("pinned synthetic tool metadata unavailable");
  const text = await response.text();
  if (createHash("sha256").update(text).digest("hex") !== "0178d235c589a31abd6ed0ea1e870935dc5819240eb0e813e178d3ebedf534f4")
    throw new Error("pinned synthetic tool metadata changed");
  const model = JSON.parse(text).models.find(value => value.slug === "gpt-5.4");
  if (model?.apply_patch_tool_type !== "freeform" || model.shell_type !== "unified_exec") throw new Error("native tool metadata unavailable");
  // This offline fixture is not the application's host-profile catalog or a model-identity claim.
  await writeFile(".deploy/native-capabilities/config/models.json", JSON.stringify({ models: [{ ...model, slug: "gpt-6.1-sol" }] }));
  // A managed, read-only requirement is stronger than trusting tenant hooks.json.
  await writeFile(".deploy/native-capabilities/config/requirements.toml", `
[hooks]
[[hooks.PreToolUse]]
[[hooks.PreToolUse.hooks]]
type = "command"
command = "${node} /opt/scikeel/runtime/required-effect-guard.mjs --guard"
timeout = 5
`);
}

export function orderedNativeToolEvidence(frames, threadId, turnId) {
  const started = new Set();
  const types = ["commandExecution", "fileChange", "dynamicToolCall"];
  for (const frame of frames) {
    const params = frame.params;
    if (params?.threadId !== threadId || params?.turnId !== turnId || !types.includes(params.item?.type) || typeof params.item.id !== "string") continue;
    if (frame.method === "item/started") started.add(params.item.id);
    else if (frame.method === "item/completed" && started.has(params.item.id)) return true;
  }
  return false;
}

export class NativeConnection {
  pending = new Map(); frames = []; next = 1; unexpectedRequests = 0; customEffects = 0; customCalls = 0;
  seenCalls = new Set();
  questionAnswers = 0;
  constructor(child, mode) {
    this.child = child; this.mode = mode;
    this.failure = new Promise((_, reject) => this.reject = reject);
    this.failure.catch(() => {});
    child.once("error", () => this.reject(new Error("native process spawn failed")));
    child.once("close", () => this.reject(new Error("native process closed before completion")));
    createInterface({ input: child.stdout }).on("line", line => {
      try { this.receive(JSON.parse(line)); } catch { this.reject(new Error("invalid native protocol frame")); }
    });
    child.stdin.on("error", () => {});
    child.stderr.resume();
  }
  write(value) { this.child.stdin.write(JSON.stringify(value) + "\n"); }
  receive(frame) {
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) throw new Error("invalid native frame");
    this.frames.push(frame);
    if (this.frames.length > 2000) throw new Error("native frame limit");
    if (frame.id !== undefined && !frame.method) {
      const pending = this.pending.get(frame.id);
      if (!pending) throw new Error("unmatched native response");
      this.pending.delete(frame.id);
      frame.error ? pending.reject(new Error(`native request rejected: ${pending.method}`)) : pending.resolve(frame.result);
    } else if (frame.id !== undefined) {
      if (frame.method === "item/tool/requestUserInput" && this.mode === "allow" && frame.params?.threadId === this.thread &&
          frame.params.turnId === this.turn && frame.params.itemId === this.expectedCallId && typeof this.expectedCallId === "string" &&
          frame.params.isBlocking === true && !this.seenCalls.has(frame.params.itemId) &&
          frame.params.questions?.length === 1 && frame.params.questions[0]?.id === "fixture_choice" &&
          frame.params.questions[0].question === "Select fixture outcome?" && frame.params.questions[0].isSecret !== true &&
          isDeepStrictEqual(frame.params.questions[0].options, [{ label: "Continue", description: "Continue fixture" }, { label: "Pause", description: "Pause fixture" }])) {
        this.seenCalls.add(frame.params.itemId);
        this.questionAnswers++;
        this.write({ id: frame.id, result: { answers: { fixture_choice: { answers: ["Continue"] } } } });
      } else if (frame.method === "item/tool/call" && frame.params?.threadId === this.thread &&
          frame.params?.tool === "research_checkpoint" && frame.params?.turnId === this.turn &&
          frame.params.callId === this.expectedCallId && typeof this.expectedCallId === "string" &&
          !this.seenCalls.has(frame.params.callId) && frame.params.arguments?.checkpoint === "fixture" &&
          Object.keys(frame.params.arguments).length === 1) {
        // The client boundary independently denies dispatch while a decision is pending.
        this.seenCalls.add(frame.params.callId);
        this.customCalls++;
        const success = this.mode === "allow";
        if (success) this.customEffects++;
        this.write({ id: frame.id, result: { contentItems: [{ type: "inputText", text: success ? "Recorded" : "Decision required" }], success } });
      } else {
        this.unexpectedRequests++;
        this.write({ id: frame.id, error: { code: -32601, message: "Fixture denies unrecognized authority" } });
      }
    } else if (frame.method === "turn/started" && frame.params?.threadId === this.thread && typeof frame.params.turn?.id === "string") {
      if (this.turn && this.turn !== frame.params.turn.id) throw new Error("unexpected native turn identity");
      this.turn = frame.params.turn.id;
    }
  }
  request(method, params) {
    const id = this.next++;
    const promise = new Promise((resolve, reject) => { this.pending.set(id, { method, resolve, reject }); this.write({ id, method, params }); });
    return Promise.race([promise, this.failure, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`native request timed out: ${method}`)), 10000); timer.unref();
      promise.finally(() => clearTimeout(timer)).catch(() => {});
    })]);
  }
  async completed() {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const frame = this.frames.find(value => value.method === "turn/completed" && value.params?.threadId === this.thread && value.params.turn?.id === this.turn);
      if (frame) return frame.params.turn;
      await Promise.race([this.failure, new Promise(resolve => setTimeout(resolve, 20))]);
    }
    throw new Error("native turn did not complete");
  }
  async close() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const stopped = new Promise(resolve => this.child.once("close", resolve));
    this.child.kill("SIGTERM");
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 2000);
    await stopped; clearTimeout(timer);
  }
}

export async function runNativeProtocolProbe() {
  if (process.env.CI !== "true" || process.env.SCIKEEL_NATIVE_CAPABILITY_CONTAINER !== "1" ||
      process.getuid() === 0 || !fixture.startsWith("/fixture/repo/")) throw new Error("disposable CI container required");
  const version = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 10000 });
  if (version.status !== 0 || !version.stdout.includes(nativePin.version)) throw new Error("native binary pin mismatch");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(binary)) hash.update(chunk);
  const resourceHash = createHash("sha256");
  for await (const chunk of createReadStream("/opt/scikeel/tools/bin/codex-resources/bwrap")) resourceHash.update(chunk);
  const schemasDirectory = `${root}/schemas`;
  const generated = spawnSync(binary, ["app-server", "generate-json-schema", "--experimental", "--out", schemasDirectory],
    { encoding: "utf8", timeout: 20000, maxBuffer: 1024 ** 2 });
  if (generated.status !== 0) throw new Error("pinned native protocol schema generation failed");
  const files = await readdir(schemasDirectory, { recursive: true });
  const properties = async name => {
    const file = files.find(path => path === `${name}.json` || path.endsWith(`/${name}.json`));
    return file ? JSON.parse(await readFile(`${schemasDirectory}/${file}`, "utf8")).properties ?? {} : {};
  };
  const thread = await properties("ThreadStartParams"), turn = await properties("TurnStartParams");
  const dynamic = await properties("DynamicToolCallParams"), command = await properties("CommandExecutionRequestApprovalParams");
  const edit = await properties("FileChangeRequestApprovalParams");
  const schemaFacts = { dynamicRegistration: !!thread.dynamicTools, nativeTurn: !!turn.threadId,
    reasoningSetting: !!turn.effort, attachmentInput: !!turn.input,
    dynamicCallIdentity: !!dynamic.threadId && !!dynamic.turnId && !!dynamic.callId,
    commandApproval: !!command.threadId && !!command.turnId, editApproval: !!edit.threadId && !!edit.turnId };
  const report = { schema: 1, source: process.env.GITHUB_SHA, native: { ...nativePin, sha256: hash.digest("hex"), bwrapSha256: resourceHash.digest("hex") },
    schemaFacts, productionChanged: false, liveInference: false, syntheticCatalog: true, fixtureModelMetadata: "gpt-5.4 tool schema only", cases: [] };
  const integration = JSON.parse(await readFile("/opt/scikeel/tools/bin/native-integration.json", "utf8"));
  if (integration.policy !== "required-effect-guard-v1" || integration.upstreamCommit !== nativePin.sourceCommit ||
      integration.binarySha256 !== report.native.sha256 || integration.bwrapSha256 !== report.native.bwrapSha256 || integration.source !== report.source)
    throw new Error("Pinned Web native integration identity mismatch");
  report.integration = integration;
  let current;
  const server = createServer(async (request, response) => {
    try {
      let bytes = "";
      for await (const chunk of request) {
        bytes += chunk;
        if (Buffer.byteLength(bytes) > 2 * 1024 ** 2) throw new Error("fixture request limit");
      }
      if (request.url === "/guard") {
        const value = JSON.parse(bytes);
        const bound = validNativeGuardInput(value, { ...current.expectedGuard, thread: current.connection.thread, turn: current.connection.turn });
        current.guards.push({ bound });
        if (!bound) { response.writeHead(403).end(); return; }
        if (current.mode === "stopped") {
          await current.connection.request("turn/interrupt", { threadId: current.connection.thread, turnId: current.connection.turn });
          current.stopAcknowledged = true;
        }
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ mode: current.mode === "stopped" ? "allow" : current.mode })); return;
      }
      if (request.url === "/v1/responses") {
        const value = JSON.parse(bytes); current.requests++;
        if (current.requests > 3) throw new Error("unexpected native model loop");
        const facts = nativeToolFacts(value);
        if (current.requests === 1) {
          current.toolCatalog = facts.toolCatalog;
          current.reasoningEffort = facts.reasoningEffort;
          current.imageInput = facts.imageInput;
        }
        else current.toolResults = facts.toolResults;
        const item = current.requests === 1 ? current.item : { type: "message", role: "assistant", id: "fixture-message",
          content: [{ type: "output_text", text: "Fixture complete" }] };
        response.setHeader("content-type", "text/event-stream"); response.end(responsesFrame(item, `fixture-${current.requests}`)); return;
      }
      response.writeHead(404).end();
    } catch { response.writeHead(400).end(); }
  });
  await new Promise(resolve => server.listen(port, "127.0.0.1", resolve));
  try {
    for (const kind of ["command", "edit", "custom", "question"]) for (const mode of (kind === "question" ? ["deny", "allow"] : ["deny", "allow", "crash", "malformed", "empty", "timeout", "missing", "stopped"])) {
      const label = { deny: "denied", allow: "allowed", crash: "crashed", timeout: "timedout" }[mode] ?? mode;
      const name = `${label}-${kind}`;
      const directory = `${root}/${name}`;
      await mkdir(`${directory}/workspace`, { recursive: true }); await mkdir(`${directory}/home`);
      const marker = `${directory}/workspace/result.txt`;
      const callId = `call-${name}`;
      const item = kind === "edit" ? { type: "custom_tool_call", call_id: callId, name: "apply_patch",
        input: "*** Begin Patch\n*** Add File: result.txt\n+verified-native-write\n*** End Patch" } : {
        type: "function_call", call_id: callId, name: kind === "command" ? "exec_command" : kind === "question" ? "request_user_input" : "research_checkpoint",
        arguments: JSON.stringify(kind === "command" ? { cmd: "printf verified-native-write > result.txt" } : kind === "question" ? {
          questions: [{ id: "fixture_choice", header: "Choice", question: "Select fixture outcome?", options: [
            { label: "Continue", description: "Continue fixture" }, { label: "Pause", description: "Pause fixture" }] }],
        } : { checkpoint: "fixture" }),
      };
      current = { mode, item, guards: [], requests: 0, expectedGuard: { cwd: `${directory}/workspace`, call: callId,
        tool: kind === "command" ? "Bash" : item.name,
        input: nativeGuardInput(item) } };
      const child = spawn(binary, ["app-server", "--listen", "stdio://", "-c", 'model_provider="fixture"', "-c",
        `model_providers.fixture={name="Fixture",base_url="http://127.0.0.1:${port}/v1",env_key="OPENAI_API_KEY",wire_api="responses"}`,
        "-c", 'model_catalog_json="/fixture/config/models.json"', "-c", 'web_search="disabled"', "-c", `features.hooks=${mode !== "missing"}`, "-c", 'features.unified_exec=true'], {
        cwd: `${directory}/workspace`, env: { PATH: "/opt/scikeel/tools/bin:/usr/local/bin:/usr/bin:/bin", HOME: `${directory}/home`,
          CODEX_HOME: `${directory}/home`, OPENAI_API_KEY: "synthetic-not-a-real-key", LANG: "C.UTF-8" }, stdio: ["pipe", "pipe", "pipe"],
      });
      const connection = new NativeConnection(child, mode);
      current.connection = connection;
      connection.expectedCallId = callId;
      const record = { name, kind, mode, passed: false };
      try {
        await connection.request("initialize", { clientInfo: { name: "scikeel-ci-feasibility", version: "1.0.0" }, capabilities: { experimentalApi: true } });
        connection.write({ method: "initialized" });
        // Offline tool metadata only; no request is sent to this model or any real provider.
        const started = await connection.request("thread/start", { cwd: `${directory}/workspace`, model: "gpt-6.1-sol",
          modelProvider: "fixture", approvalPolicy: "on-request", sandbox: "workspace-write", ephemeral: true,
          dynamicTools: [{ type: "function", name: "research_checkpoint", description: "Synthetic research decision fixture",
            inputSchema: { type: "object", properties: { checkpoint: { type: "string" } }, required: ["checkpoint"], additionalProperties: false } }] });
        connection.thread = started.thread.id;
        const turn = await connection.request("turn/start", { threadId: connection.thread,
          input: [{ type: "text", text: "Synthetic native protocol test" }, { type: "image", url: pixel }], effort: "low",
          ...(kind === "question" ? { collaborationMode: { mode: "plan", settings: { model: "gpt-6.1-sol", reasoning_effort: "low", developer_instructions: null } } } : {}),
          approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite", writableRoots: [`${directory}/workspace`], networkAccess: false,
            excludeTmpdirEnvVar: true, excludeSlashTmp: true } });
        if (connection.turn && connection.turn !== turn.turn.id) throw new Error("native turn acknowledgement mismatch");
        connection.turn = turn.turn.id;
        record.identity = typeof connection.thread === "string" && typeof turn.turn.id === "string";
        record.status = (await connection.completed()).status;
        if (mode === "stopped") await connection.close();
        record.guardCalls = current.guards.length;
        record.boundGuardCalls = current.guards.filter(value => value.bound).length;
        record.unexpectedRequests = connection.unexpectedRequests;
        record.customDispatches = connection.customCalls;
        let file;
        try { file = await readFile(marker, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
        record.questionAnswers = connection.questionAnswers;
        record.effect = kind === "question" ? connection.questionAnswers > 0 : kind === "custom" ? connection.customEffects > 0 : file !== undefined;
        record.bytesVerified = kind === "question" ? connection.questionAnswers === 1 && current.toolResults?.some(value => value.includes("Continue"))
          : kind === "custom" ? connection.customEffects === 1 : file?.trim() === "verified-native-write";
        record.nativeToolStarted = connection.frames.some(frame => frame.method === "item/started");
        record.nativeToolCompleted = connection.frames.some(frame => frame.method === "item/completed");
        record.orderedToolEvidence = orderedNativeToolEvidence(connection.frames, connection.thread, connection.turn);
        record.toolCatalog = current.toolCatalog;
        record.toolResults = current.toolResults?.map(output => output.replaceAll(directory, "[fixture]").replaceAll("synthetic-not-a-real-key", "[redacted]"));
        // A crashing guard is not an allow decision, even when native execution continues.
        record.stopAcknowledged = current.stopAcknowledged === true;
        record.reasoningEffort = current.reasoningEffort;
        record.imageInput = current.imageInput === true;
        record.nativeDenialResult = current.toolResults?.some(value => /blocked by PreToolUse hook|SciKeel execution authority/.test(value)) === true;
        // A guard denial happens before tool-start dispatch; require its real native result and no effect instead.
        record.passed = record.identity && (mode === "stopped" ? record.status === "interrupted" && record.stopAcknowledged : record.status === "completed") &&
          record.reasoningEffort === "low" && record.imageInput &&
          (mode === "allow" ? kind === "question" ? record.questionAnswers === 1 : record.orderedToolEvidence : mode === "stopped" || record.nativeDenialResult) &&
          (mode === "missing" ? record.guardCalls === 0 : record.boundGuardCalls > 0 && record.guardCalls === record.boundGuardCalls) && record.unexpectedRequests === 0 &&
          (mode === "allow" ? record.effect && record.bytesVerified : !record.effect && record.customDispatches === 0);
      } catch (error) { record.failure = error.message; }
      finally { await connection.close(); }
      report.cases.push(record);
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
  Object.assign(report, capabilityResult(report.cases));
  report.activationEligible &&= Object.values(schemaFacts).every(Boolean);
  await writeFile("/fixture/output/native-capabilities.json", JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
  if (!report.activationEligible) throw new Error("Pinned native safety/workflow capability gate failed; activation remains blocked");
}

if (process.argv[1] === fixture) {
  if (process.argv[2] === "--guard") await hook();
  else if (process.argv[2] === "--prepare") await prepareNativeProbe();
  else throw new Error("fixed native fixture operation required");
}
