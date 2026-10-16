import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile, chmod, symlink, link } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { afterEach, test } from "node:test";

import { CliRuntimeManager, handoverText } from "../src/cli-runtime.mjs";
import { CliProfileResolver } from "../src/cli-profile.mjs";
import { ConversationState } from "../src/conversation-state.mjs";

const fakeCli = fileURLToPath(new URL("../fixtures/fake-cli.mjs", import.meta.url));
const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeManager(runtime) {
  const root = await mkdtemp(join(tmpdir(), "osd-cli-runtime-"));
  roots.push(root);
  const adminClaude = join(root, "admin-claude");
  const adminCodex = join(root, "admin-codex");
  await mkdir(adminClaude, { recursive: true });
  await mkdir(adminCodex, { recursive: true });
  await writeFile(join(adminClaude, "settings.json"), JSON.stringify({ model: "admin-model", env: { ANTHROPIC_DEFAULT_OPUS_MODEL: "opus" } }));
  await writeFile(join(adminCodex, "auth.json"), "{\"auth\":true}\n");
  await writeFile(join(adminCodex, "config.toml"), "model = \"admin-model\"\n");
  await writeFile(join(adminCodex, "codex-models.json"), JSON.stringify({ models: ["admin-model", "gpt-fast", "gpt-deep"] }));
  await writeFile(join(adminCodex, "config.toml"), 'model = "admin-model"\nmodel_catalog_json = "codex-models.json"\n');
  const profileResolver = new CliProfileResolver({ claudeConfigDir: adminClaude, codexHome: adminCodex,
    fetchImpl: async () => { throw Error("Deterministic CLI tests must never contact a provider"); } });
  const refresh = profileResolver.refresh.bind(profileResolver);
  // The synthetic CLI is always available; this is not live Claude readiness evidence.
  profileResolver.refresh = async (...args) => {
    const profile = await refresh(...args);
    return args[0] === "claude" && profile.enabledByProfile ? { ...profile, status: "ready" } : profile;
  };
  const options = {
      rootDir: join(root, "runtime"),
      runtime,
      claudeCommand: process.execPath,
      claudeArgs: [fakeCli, "claude"],
      codexCommand: process.execPath,
      codexArgs: [fakeCli, "codex"],
      claudeConfigDir: adminClaude,
      codexHome: adminCodex,
      profileResolver,
      turnTimeoutMs: 5_000,
      assistantAuthority: { prepare: async () => {}, revoke: async () => {},
        inventory: async () => ({ activeExecutions: [], uncertainEffects: [] }) },
  };
  return {
    root,
    options,
    manager: new CliRuntimeManager(options),
  };
}

async function selectRuntime(manager, runtime) {
  const { revision, activeRuntime } = manager.adminDescribe();
  if (activeRuntime === runtime) return;
  return manager.selectAssistant({ runtime, expectedRevision: revision, operationId: `fixture_selection_${revision}` });
}

async function waitForIdle(manager, userId, sessionId) {
  for (let i = 0; i < 50; i++) {
    const { session } = await manager.getOwnedSession(userId, sessionId);
    if (session.status === "idle" && session.history.length > 1) return session;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("CLI turn did not finish");
}

test("starts a managed CLI in a cancellable process group and aborts the group", async () => {
  const { root, options } = await makeManager("codex");
  const calls = [];
  const manager = new CliRuntimeManager({ ...options, spawnImpl: (command, args, spawnOptions) => {
    calls.push(spawnOptions);
    return spawn(command, args, spawnOptions);
  } });
  await manager.init();
  await manager.setUserRuntime("usr_a", "codex");
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const session = await manager.createSession({ userId: "usr_a", workspaceDir: workspace });
  await manager.sendPrompt({ userId: "usr_a", sessionId: session.id, text: "hello" });
  await waitForIdle(manager, "usr_a", session.id);
  assert.equal(calls[0].detached, process.platform !== "win32");
  await manager.close();
});

test("aborting research stops both the CLI and its workspace child process", async () => {
  const { root, options } = await makeManager("codex");
  const manager = new CliRuntimeManager({ ...options, codexArgs: [fileURLToPath(new URL("../fixtures/research-cli.mjs", import.meta.url))] });
  await manager.init();
  await manager.setUserRuntime("usr_a", "codex");
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, ".scikeel"), { recursive: true });
  const session = await manager.createSession({ userId: "usr_a", workspaceDir: workspace });
  const task = { directory: workspace, objective: "long-running research", reportPath: ".scikeel/report.json", execution: 1 };
  await manager.sendPrompt({ userId: "usr_a", sessionId: session.id, text: `SciKeel research task (version 1).\n${JSON.stringify(task)}` });
  let pid;
  for (let n = 0; n < 50; n++) {
    try { pid = Number(await readFile(join(workspace, "child.pid"), "utf8")); if(Number.isSafeInteger(pid)&&pid>1)break; }
    catch { /* The fixture may still be creating its child readiness file. */ }
    await new Promise((done) => setTimeout(done, 20));
  }
  assert.ok(pid);
  process.kill(pid, 0);
  await manager.abortSession("usr_a", session.id);
  for (let n = 0; n < 150 && session.status === "running"; n++) await new Promise((done) => setTimeout(done, 20));
  assert.equal(session.status, "idle");
  assert.equal(session.history.at(-1)?.info.error, undefined);
  // Linux may briefly retain an exited orphan as a zombie until it is reaped.
  const gone = async () => {
    try {
      process.kill(pid, 0);
      if (process.platform === "linux") return /\) Z /.test(await readFile(`/proc/${pid}/stat`, "utf8"));
      return false;
    } catch { return true; }
  };
  for (let n = 0; n < 50 && !await gone(); n++) await new Promise((done) => setTimeout(done, 20));
  assert.ok(await gone());
  await manager.close();
});

async function managedRequest(manager, workspaceDir, method, url, body) {
  const request = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(request, { method, url, headers: {} });
  const response = {
    headersSent: false,
    writeHead(status) { this.status = status; this.headersSent = true; },
    end(text) { this.body = JSON.parse(text); },
  };
  assert.equal(await manager.handle(request, response, { userId: "usr_a", workspaceDir }), true);
  return response;
}

test('native interactions hidden by workspace lifecycle cannot be resumed through old replies',async()=>{
 const {root,manager}=await makeManager('codex');const workspace=join(root,'workspace');await mkdir(workspace);
 try{
  const session=await manager.createSession({userId:'usr_a',workspaceDir:workspace});let effects=0;
  manager.sandboxJobs={approve:async()=>effects++,answer:async()=>effects++};
  const permission='a'.repeat(64),question='b'.repeat(64);
  manager.nativeApprovals.set(permission,{id:permission,userId:'usr_a',sessionID:session.id});
  manager.nativeQuestions.set(question,{id:question,userId:'usr_a',sessionID:session.id});
  manager.workspaceAccess=async()=>{throw Object.assign(new Error('Project trashed'),{code:'project_trashed',statusCode:409,status:409});};
  for(const path of ['/permission','/question'])assert.deepEqual((await managedRequest(manager,workspace,'GET',path)).body,[]);
  assert.equal((await managedRequest(manager,workspace,'POST',`/permission/${permission}/reply`,{reply:'once'})).status,409);
  assert.equal((await managedRequest(manager,workspace,'POST',`/question/${question}/reply`,{answers:[['yes']]})).status,409);
  assert.equal(effects,0);assert.equal(manager.nativeApprovals.has(permission),true);
 }finally{await manager.close();}
});

for (const runtime of ["claude", "codex"]) {
  test(`${runtime} exposes usable bundled skills and rejects another workspace`, async () => {
    const { root, manager } = await makeManager(runtime);
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    try {
      const response = await managedRequest(manager, workspace, "GET", "/skill");
      assert.equal(response.status, 200);
      assert.ok(response.body.some((item) => item.name === "publication-figures" && item.source === "builtin"));
      assert.ok(response.body.some((item) => item.name === "traceability-review"));
      assert.ok(!response.body.some((item) => item.name === "computer-use"));
      const forbidden = await managedRequest(manager, workspace, "GET", `/skill?directory=${encodeURIComponent(root)}`);
      assert.equal(forbidden.status, 403);
      const state = await manager.ensureUser("usr_a");
      const pinned = await manager.profileResolver.copyForTurn(await manager.profileResolver.refresh(runtime), { paths: state.paths });
      assert.match(await readFile(join(pinned.configDir, "skills", "publication-figures", "SKILL.md"), "utf8"), /Publication Figures/);
    } finally { await manager.close(); }
  });
  test(`${runtime} exclusive selection waits for accepted turns and persists history across a global switch`, async () => {
    const { root, manager, options } = await makeManager(runtime);
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await manager.init();
    const session = await manager.createSession({ userId: "usr_a", workspaceDir: workspace });
    const turn = await manager.reservePrompt({ userId: "usr_a", sessionId: session.id, text: "accepted research task" });
    await assert.rejects(selectRuntime(manager, "opencode"), { code: "assistant_busy" });
    await manager.runReservedPrompt(turn);
    const finished = await waitForIdle(manager, "usr_a", session.id);
    assert.equal(finished.history.length, 2);
    assert.equal(finished.history.at(-1).info.error, undefined);
    await selectRuntime(manager, "opencode");
    assert.equal(manager.describe("usr_a").available.find((item) => item.runtime === runtime).enabled, false);
    await assert.rejects(manager.setUserRuntime("usr_b", runtime), { code: "assistant_selection_admin_only" });
    assert.equal(finished.history.length, 2);
    await manager.close();
    const restarted = new CliRuntimeManager(options);
    await restarted.init();
    assert.equal(restarted.adminDescribe().assistantEnabled[runtime], false);
    assert.equal(restarted.runtimeForUser("usr_b"), "opencode");
    await selectRuntime(restarted, runtime);
    await restarted.sendPrompt({ userId: "usr_a", sessionId: session.id, text: "continue" });
    const continued = await waitForIdle(restarted, "usr_a", session.id);
    assert.equal(continued.history.length, 4);
    await restarted.close();
  });
}

test("managed prompt variants validate per model, reach CLI args, and persist across resume and handover", async () => {
  const { root, manager, options } = await makeManager("codex");
  const calls = [];
  const spawnImpl = (command, args, opts) => { calls.push(args); return spawn(command, args, opts); };
  manager.spawnImpl = spawnImpl;
  await writeFile(join(root, "admin-codex", "codex-models.json"), JSON.stringify({ models: [
    { slug: "admin-model", supported_reasoning_levels: [{ effort: "low" }, { effort: "ultra" }] },
    { slug: "gpt-deep", supported_reasoning_levels: [{ effort: "high" }] },
    "gpt-fast",
  ] }));
  await manager.init();
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const session = await manager.createSession({ userId: "usr_a", workspaceDir: workspace });
  const other = await manager.createSession({ userId: "usr_a", workspaceDir: workspace });
  const providers = await managedRequest(manager, workspace, "GET", "/config/providers");
  assert.deepEqual(providers.body.providers[0].models["admin-model"].variants, {
    low: { reasoningEffort: "low" }, ultra: { reasoningEffort: "ultra" },
  });
  assert.deepEqual(providers.body.providers[0].models["gpt-fast"].variants, {});
  const requestPrompt = (variant, modelID = "admin-model") => managedRequest(manager, workspace, "POST", `/session/${session.id}/prompt_async`, {
    parts: [{ type: "text", text: "reason" }], model: { providerID: "codex", modelID }, variant,
  });
  for (const variant of ["high", "__proto__", "", 3, {}, [], 'ultra"\n']) {
    assert.equal((await requestPrompt(variant)).status, 400);
    assert.equal(session.status, "idle");
    assert.equal(session.history.length, 0);
    assert.equal(session.variant, null);
  }
  assert.equal((await requestPrompt("ultra", "gpt-fast")).status, 400);
  assert.equal(calls.length, 0);
  assert.equal((await requestPrompt("ultra")).status, 202);
  await waitForIdle(manager, "usr_a", session.id);
  await manager.persistQueues.get("usr_a");
  assert.equal(calls[0][calls[0].indexOf("-c") + 1], 'model_reasoning_effort="ultra"');
  assert.equal(session.variant, "ultra");
  assert.equal(other.variant, null);
  assert.equal((await manager.listSessions({ userId: "usr_a" })).find(({ id }) => id === session.id).variant, "ultra");
  await manager.close();

  const reopened = new CliRuntimeManager({ ...options, spawnImpl });
  await reopened.init();
  let restored = (await reopened.getOwnedSession("usr_a", session.id)).session;
  assert.equal(restored.variant, "ultra");
  await reopened.sendPrompt({ userId: "usr_a", sessionId: session.id, text: "resume", variant: restored.variant });
  restored = await waitForIdle(reopened, "usr_a", session.id);
  assert.equal(calls[1][calls[1].indexOf("-c") + 1], 'model_reasoning_effort="ultra"');
  assert.ok(calls[1].indexOf("-c") < calls[1].indexOf("resume"));
  assert.equal(calls[1][calls[1].indexOf("resume") + 1], "codex-native-session");

  await writeFile(join(root, "admin-codex", "auth.json"), JSON.stringify({ auth: "rotated-fixture" }));
  await reopened.sendPrompt({ userId: "usr_a", sessionId: session.id, text: "handover", variant: "ultra" });
  await waitForIdle(reopened, "usr_a", session.id);
  assert.equal(calls[2].includes("resume"), false);
  assert.match(calls[2].at(-1), /Previous conversation context/);
  assert.equal(calls[2][calls[2].indexOf("-c") + 1], 'model_reasoning_effort="ultra"');

  await reopened.sendPrompt({ userId: "usr_a", sessionId: session.id, text: "default", variant: null });
  restored = await waitForIdle(reopened, "usr_a", session.id);
  assert.equal(calls[3].includes("-c"), false);
  assert.equal(restored.variant, null);
  await reopened.sendPrompt({ userId: "usr_a", sessionId: session.id, text: "effort", variant: "ultra" });
  await waitForIdle(reopened, "usr_a", session.id);
  await reopened.sendPrompt({ userId: "usr_a", sessionId: session.id, text: "switch", model: "gpt-deep" });
  restored = await waitForIdle(reopened, "usr_a", session.id);
  assert.equal(calls[5].includes("-c"), false);
  assert.equal(restored.variant, null);
  assert.equal(restored.model, "codex/gpt-deep");
  await reopened.close();
});

test("SDK-shaped omission resets a saved high variant to default through the prompt endpoint", async () => {
  const { root, manager, options } = await makeManager("codex");
  const calls = [];
  manager.spawnImpl = (command, args, opts) => { calls.push(args); return spawn(command, args, opts); };
  await writeFile(join(root, "admin-codex", "codex-models.json"), JSON.stringify({ models: [
    { slug: "admin-model", supported_reasoning_levels: [{ effort: "high" }] },
  ] }));
  await manager.init();
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const session = await manager.createSession({ userId: "usr_a", workspaceDir: workspace });
  // Match OpenCodeClient.sendPrompt: null and undefined both omit the wire field.
  const sdkBody = (variant) => ({
    parts: [{ type: "text", text: "reason" }],
    model: { providerID: "codex", modelID: "admin-model" },
    ...(variant ? { variant } : {}),
  });
  for (const defaultVariant of [undefined, null]) {
    const high = await managedRequest(manager, workspace, "POST", `/session/${session.id}/prompt_async`, sdkBody("high"));
    assert.equal(high.status, 202);
    await waitForIdle(manager, "usr_a", session.id);
    assert.equal(calls.at(-1)[calls.at(-1).indexOf("-c") + 1], 'model_reasoning_effort="high"');
    assert.equal(session.variant, "high");
    const body = sdkBody(defaultVariant);
    assert.equal(Object.hasOwn(body, "variant"), false);
    const result = await managedRequest(manager, workspace, "POST", `/session/${session.id}/prompt_async`, body);
    assert.equal(result.status, 202);
    await waitForIdle(manager, "usr_a", session.id);
    await manager.persistQueues.get("usr_a");
    assert.equal(calls.at(-1).includes("-c"), false);
    assert.equal(calls.at(-1).includes("resume"), true);
    assert.equal(session.variant, null);
    const saved = JSON.parse(await readFile(manager.userStates.get("usr_a").paths.sessionsPath, "utf8"));
    assert.equal(saved.sessions.find(({ id }) => id === session.id).variant, null);
  }
  await manager.close();
  const reopened = new CliRuntimeManager(options);
  await reopened.init();
  assert.equal((await reopened.getOwnedSession("usr_a", session.id)).session.variant, null);
  await reopened.close();
});

test("default turns leave profile effort untouched and removed catalog levels are not reused", async () => {
  const { root, manager } = await makeManager("codex");
  await writeFile(join(root, "admin-codex", "config.toml"), 'model = "admin-model"\nmodel_reasoning_effort = "high"\nmodel_catalog_json = "codex-models.json"\n');
  const catalog = (levels) => writeFile(join(root, "admin-codex", "codex-models.json"), JSON.stringify({ models: [
    { slug: "admin-model", supported_reasoning_levels: levels.map((effort) => ({ effort })) },
  ] }));
  await catalog(["low"]);
  const calls = [];
  manager.spawnImpl = (command, args, opts) => { calls.push(args); return spawn(command, args, opts); };
  await manager.init();
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const session = await manager.createSession({ userId: "usr_a", workspaceDir: workspace });
  await manager.sendPrompt({ userId: "usr_a", sessionId: session.id, text: "default" });
  await waitForIdle(manager, "usr_a", session.id);
  assert.equal(calls[0].includes("-c"), false);
  const profile = manager.profiles.get("codex");
  const pinned = await manager.profileResolver.copyForTurn(profile, { paths: manager.userStates.get("usr_a").paths });
  assert.match(await readFile(join(pinned.codexHome, "config.toml"), "utf8"), /model_reasoning_effort\s*=\s*"high"/);
  await manager.sendPrompt({ userId: "usr_a", sessionId: session.id, text: "low", variant: "low" });
  await waitForIdle(manager, "usr_a", session.id);
  await catalog([]);
  await assert.rejects(manager.sendPrompt({ userId: "usr_a", sessionId: session.id, text: "invalid", variant: "low" }), { code: "invalid_variant" });
  await manager.sendPrompt({ userId: "usr_a", sessionId: session.id, text: "new default" });
  await waitForIdle(manager, "usr_a", session.id);
  assert.equal(calls[2].includes("-c"), false);
  assert.equal(session.variant, null);
  await manager.close();
});

test("Claude hides unproven variants and passes effort only with explicit model capabilities", async () => {
  const { root, manager } = await makeManager("claude");
  const calls = [];
  manager.spawnImpl = (command, args, opts) => { calls.push(args); return spawn(command, args, opts); };
  await manager.init();
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const session = await manager.createSession({ userId: "usr_a", workspaceDir: workspace });
  const providers = await managedRequest(manager, workspace, "GET", "/config/providers");
  assert.deepEqual(providers.body.providers[0].models["admin-model"].variants, {});
  await assert.rejects(manager.sendPrompt({ userId: "usr_a", sessionId: session.id, text: "invalid", variant: "xhigh" }), { code: "invalid_variant" });
  await manager.sendPrompt({ userId: "usr_a", sessionId: session.id, text: "default" });
  await waitForIdle(manager, "usr_a", session.id);
  assert.equal(calls[0].includes("--effort"), false);
  // Inject a capability-bearing profile to exercise the verified CLI flag.
  const refresh = manager.profileResolver.refresh.bind(manager.profileResolver);
  manager.profileResolver.refresh = async (...args) => {
    const profile = await refresh(...args);
    return { ...profile, models: profile.models.map((model) => ({ ...model, variants: { xhigh: { effort: "xhigh" } } })) };
  };
  await manager.sendPrompt({ userId: "usr_a", sessionId: session.id, text: "effort", variant: "xhigh" });
  await waitForIdle(manager, "usr_a", session.id);
  assert.equal(calls[1][calls[1].indexOf("--effort") + 1], "xhigh");
  assert.equal(calls[1][calls[1].indexOf("--resume") + 1], "claude-native-session");
  assert.equal(session.variant, "xhigh");
  await manager.close();
});

test("runs Claude with a copied administrator configuration and private user history", async () => {
  const { root, manager } = await makeManager("claude");
  await manager.init();
  await manager.setUserRuntime("usr_a", "claude", "admin-model");
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const session = await manager.createSession({ userId: "usr_a", workspaceDir: workspace });
  await manager.sendPrompt({ userId: "usr_a", sessionId: session.id, text: "hello" });
  const finished = await waitForIdle(manager, "usr_a", session.id);

  assert.equal(finished.nativeSessionId, "claude-native-session");
  assert.equal(finished.history.at(-1).info.error, undefined);
  assert.match(finished.history.at(-1).parts[0]?.text ?? "", /Claude\[admin-model\]: hello/);
  assert.equal(JSON.parse(await readFile(join(root, "runtime", "users", "usr_a", "claude-config", "profiles", finished.identityRevision, manager.profiles.get("claude").sourceRevision, "settings.json"), "utf8")).model, "admin-model");
  assert.equal((await manager.listSessions({ userId: "usr_b" })).length, 0);
});

test("preserves scientific URLs and complete long answers while redacting only the active relay", async () => {
  const { root, manager } = await makeManager("codex");
  const relay = "https://private-relay.example.internal/v1";
  await writeFile(join(root, "admin-codex", "config.toml"), `model = "admin-model"\nmodel_provider = "Private"\nmodel_catalog_json = "codex-models.json"\n[model_providers.Private]\nbase_url = "${relay}"\n`);
  await manager.init();
  await manager.setUserRuntime("usr_a", "codex");
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const session = await manager.createSession({ userId: "usr_a", workspaceDir: workspace });
  const paper = "https://doi.org/10.1000/long-paper";
  const answer = `tool-fixture: ${paper} ${"analysis ".repeat(370)} ${relay}`;
  await manager.sendPrompt({ userId: "usr_a", sessionId: session.id, text: answer });
  const finished = await waitForIdle(manager, "usr_a", session.id);
  const parts = finished.history.at(-1).parts;
  const text = parts.find((part) => part.type === "text").text;
  assert.ok(text.length > 2_000);
  assert.ok(text.includes(paper));
  assert.ok(text.includes("analysis ".repeat(370)));
  assert.ok(!text.includes(relay));
  assert.ok(text.includes("[redacted]"));
  const output = parts.find((part) => part.type === "tool").state.output;
  assert.ok(output.length > 2_000);
  assert.ok(output.includes(paper));
  assert.ok(!output.includes(relay));
});

test("accepts a recovered Codex warning while keeping its private profile path out of messages", async () => {
  const { root, manager } = await makeManager("codex");
  await manager.init();
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const session = await manager.createSession({ userId: "usr_a", workspaceDir: workspace });
  await manager.sendPrompt({ userId: "usr_a", sessionId: session.id, text: "recover after warning" });
  const finished = await waitForIdle(manager, "usr_a", session.id);
  assert.equal(finished.history.at(-1).info.error, undefined);
  assert.match(finished.history.at(-1).parts[0].text, /Codex\[admin-model\]: recover after warning/);
  assert.equal(JSON.stringify(finished.history).includes(join(root, "runtime", "users", "usr_a")), false);
});

test("reports a terminal Codex turn failure even when the CLI exits successfully", async () => {
  const { root, manager } = await makeManager("codex");
  await manager.init();
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const session = await manager.createSession({ userId: "usr_a", workspaceDir: workspace });
  await manager.sendPrompt({ userId: "usr_a", sessionId: session.id, text: "terminal turn failure" });
  const finished = await waitForIdle(manager, "usr_a", session.id);
  assert.match(finished.history.at(-1).info.error.data.message, /Terminal provider failure/);
});

test("marks a failed Claude turn as an error even when the CLI emitted text", async () => {
  const { root, manager } = await makeManager("claude");
  await manager.init();
  await manager.setUserRuntime("usr_a", "claude");
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const session = await manager.createSession({ userId: "usr_a", workspaceDir: workspace });

  await manager.sendPrompt({ userId: "usr_a", sessionId: session.id, text: "fail after text" });
  const finished = await waitForIdle(manager, "usr_a", session.id);

  assert.match(finished.history.at(-1).parts[0]?.text ?? "", /retired model/);
  assert.match(finished.history.at(-1).info.error?.data?.message ?? "", /retired model/);
});

test("runs Codex and never shares one user's session list with another user", async () => {
  const { root, manager } = await makeManager("codex");
  await manager.init();
  await manager.setUserRuntime("usr_a", "codex", "gpt-deep");
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const first = await manager.createSession({ userId: "usr_a", workspaceDir: workspace });
  await manager.sendPrompt({ userId: "usr_a", sessionId: first.id, text: "analyze" });
  let finished = await waitForIdle(manager, "usr_a", first.id);

  assert.equal(finished.nativeSessionId, "codex-native-session");
  assert.equal(finished.history.at(-1).info.error, undefined);
  assert.match(finished.history.at(-1).parts[0]?.text ?? "", /Codex\[gpt-deep\]: analyze/);
  await manager.sendPrompt({ userId: "usr_a", sessionId: first.id, text: "continue" });
  finished = await waitForIdle(manager, "usr_a", first.id);
  assert.match(finished.history.at(-1).parts[0]?.text ?? "", /Codex\[gpt-deep\]: continue/);
  assert.equal(finished.history.some((message) => message.info?.error), false);
  assert.equal((await manager.listSessions({ userId: "usr_b" })).length, 0);
  assert.match(await readFile(join(root, "runtime", "users", "usr_a", "codex-home", "profiles", finished.identityRevision, manager.profiles.get("codex").sourceRevision, "config.toml"), "utf8"), /admin-model/);
  assert.equal((await readFile(join(root, "runtime", "users", "usr_a", "codex-home", "profiles", finished.identityRevision, manager.profiles.get("codex").sourceRevision, "codex-models.json"), "utf8")), await readFile(join(root, "admin-codex", "codex-models.json"), "utf8"));
});

test("migrates the old switch to OpenCode and persists one administrator selection for all users", async () => {
  const { root, options, manager } = await makeManager("codex");
  await mkdir(join(root, "runtime"), { recursive: true });
  await writeFile(
    join(root, "runtime", "runtime.json"),
    `${JSON.stringify({ version: 1, runtime: "codex" })}\n`,
  );

  await manager.init();
  assert.equal(manager.describe("usr_a").runtime, "opencode");
  assert.equal(manager.describe("usr_b").runtime, "opencode");
  await assert.rejects(manager.setUserRuntime("usr_a", "codex"), { code: "assistant_selection_admin_only" });
  await selectRuntime(manager, "codex");
  assert.equal(manager.describe("usr_a").runtime, "codex");
  assert.equal(manager.describe("usr_b").runtime, "codex");
  await manager.close();

  const persisted = JSON.parse(await readFile(join(root, "runtime", "runtime.json"), "utf8"));
  assert.equal(persisted.version, 5);
  assert.equal(persisted.defaultRuntime, "codex");
  assert.deepEqual(persisted.userRuntimes, {});

  const reopened = new CliRuntimeManager(options);
  await reopened.init();
  assert.equal(reopened.describe("usr_a").runtime, "codex");
  assert.equal(reopened.describe("usr_b").runtime, "codex");
  await reopened.close();
});

test("migrates version 2 runtime choices and seeds managed model catalogs", async () => {
  const { root, manager } = await makeManager("opencode");
  await mkdir(join(root, "runtime"), { recursive: true });
  await writeFile(
    join(root, "runtime", "runtime.json"),
    `${JSON.stringify({
      version: 2,
      defaultRuntime: "opencode",
      userRuntimes: { usr_a: "codex" },
    })}\n`,
  );

  await manager.init();

  assert.equal(manager.describe("usr_a").runtime, "opencode");
  assert.deepEqual(manager.adminDescribe().assistantEnabled, { claude: false, codex: false });
  const saved = JSON.parse(await readFile(join(root, "runtime", "runtime.json"), "utf8"));
  assert.equal(saved.version, 5);
  assert.equal(saved.userRuntimes.usr_a, "codex");
});

test("remembers one enabled managed model per user and runtime", async () => {
  const { manager, root } = await makeManager("opencode");
  await manager.init();
  await writeFile(join(root, "admin-claude", "settings.json"), JSON.stringify({ model: "sonnet", env: { ANTHROPIC_DEFAULT_SONNET_MODEL: "sonnet", ANTHROPIC_DEFAULT_OPUS_MODEL: "opus" } }));
  await manager.refreshProfiles();
  await selectRuntime(manager, "codex");
  await manager.setUserModel("usr_a", "codex", "gpt-deep");
  await assert.rejects(manager.setUserModel("usr_a", "claude", "opus"), { code: "assistant_selection_admin_only" });
  await selectRuntime(manager, "claude");
  await manager.setUserModel("usr_a", "claude", "opus");
  await selectRuntime(manager, "codex");
  assert.equal(manager.describe("usr_a").model, "gpt-deep");
  assert.equal(manager.modelForUser("usr_a", "claude"), "opus");
});

test("falls back to the new default when an administrator removes a selected model", async () => {
  const { manager, root } = await makeManager("opencode");
  await manager.init();
  await writeFile(join(root, "admin-codex", "config.toml"), 'model = "gpt-fast"\nmodel_catalog_json = "codex-models.json"\n');
  await manager.refreshProfiles();
  await selectRuntime(manager, "codex");
  await manager.setUserModel("usr_a", "codex", "gpt-deep");

  await writeFile(join(root, "admin-codex", "codex-models.json"), JSON.stringify({ models: ["gpt-fast"] }));
  await manager.refreshProfiles();

  assert.equal(manager.modelForUser("usr_a", "codex"), "gpt-fast");
  assert.equal(manager.describe("usr_a").model, "gpt-fast");
});

test("binds a model to each conversation and hands over completed turns after identity changes", async () => {
  const { root, manager } = await makeManager("codex");
  await manager.init();
  await manager.setUserRuntime("usr_a", "codex", "gpt-fast");
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const first = await manager.createSession({ userId: "usr_a", workspaceDir: workspace });
  const second = await manager.createSession({ userId: "usr_a", workspaceDir: workspace });
  await manager.sendPrompt({ userId: "usr_a", sessionId: first.id, text: "first", model: "gpt-deep" });
  let finished = await waitForIdle(manager, "usr_a", first.id);
  const previousRevision = finished.identityRevision;
  assert.equal(finished.model, "codex/gpt-deep");
  assert.equal(second.model, "codex/gpt-fast");
  await assert.rejects(manager.sendPrompt({ userId: "usr_a", sessionId: first.id, text: "bad", model: "unavailable" }), { code: "model_not_enabled" });
  assert.equal(finished.history.length, 2);
  await writeFile(join(root, "admin-codex", "config.toml"), 'model = "admin-model"\nmodel_provider = "OpenAI"\nmodel_catalog_json = "codex-models.json"\n[model_providers.OpenAI]\nbase_url = "https://fixture-relay.invalid/v2"\n');
  await manager.sendPrompt({ userId: "usr_a", sessionId: first.id, text: "next" });
  finished = await waitForIdle(manager, "usr_a", first.id);
  assert.notEqual(finished.identityRevision, previousRevision);
  assert.equal(finished.history.length, 4);
  assert.match(finished.history.at(-1).parts[0].text, /Previous conversation context/);
  assert.ok(handoverText(finished.history, { maxChars: 100 }).length <= 100);
});

test("migrates version 3 assistant flags while preserving account selections", async () => {
  const { root, manager } = await makeManager("opencode");
  await mkdir(join(root, "runtime"));
  await writeFile(join(root, "runtime", "runtime.json"), JSON.stringify({ version: 3, defaultRuntime: "opencode", userRuntimes: { usr_a: "codex" }, userModels: { usr_a: { codex: "gpt-deep" } }, managedRuntimes: { codex: { models: ["gpt-deep"], defaultModel: "gpt-deep" }, claude: { models: [], defaultModel: null } } }));
  await manager.init();
  const saved = JSON.parse(await readFile(join(root, "runtime", "runtime.json"), "utf8"));
  assert.equal(saved.version, 5);
  assert.deepEqual(saved.assistantEnabled, { claude: false, codex: false });
  assert.equal(saved.userRuntimes.usr_a, "codex");
  assert.equal(manager.modelForUser("usr_a", "codex"), "gpt-deep");
});

for (const runtime of ["claude", "codex"]) test(`${runtime} delivers images on fresh and resumed attachment turns and reads actual CSV bytes`, async () => {
  const { root, options } = await makeManager(runtime);
  const { AttachmentStore } = await import("../src/attachments.mjs"); const { AttachmentTurns } = await import("../src/attachment-turns.mjs");
  const fixture = fileURLToPath(new URL("../fixtures/attachment-cli.mjs", import.meta.url));
  const manager = new CliRuntimeManager({ ...options, claudeArgs: [fixture, "claude"], codexArgs: [fixture, "codex"] });
  const workspace = join(root, "workspace"); await mkdir(workspace); const store = new AttachmentStore({ rootDir: join(root, "attachments") }); await store.init();
  await manager.init(); await manager.setUserRuntime("usr_a", runtime); const session = await manager.createSession({ userId: "usr_a", workspaceDir: workspace });
  const user = { id: "usr_a" }, owner = { sessionId: session.id }; const draft = await store.createDraft(user.id);
  const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDAAAAAASUVORK5CYII=", "base64");
  const image = await store.upload(user.id, { draftId: draft.id }, "figure.png", Readable.from([imageBytes]));
  const csv = await store.upload(user.id, { draftId: draft.id }, "data.csv", Readable.from(["value\n2\n4\n"]));
  const turns = new AttachmentTurns({ store, readHistory: async () => session.history });
  try {
    for (const turnId of ["turn_fresh", "turn_resumed"]) {
      const prepared = await turns.prepare(user, owner, { parts: [{ type: "text", text: "Read image and compute mean" }], attachmentTurn: { turnId, draftId: draft.id, attachmentIds: [image.id, csv.id] } });
      if (runtime === "codex") {
        const state = await manager.ensureUser(user.id);
        const command = manager.commandFor(state, session, "describe", session.nativeSessionId, prepared);
        assert.equal(command.args.at(-2), "--", "image arguments must terminate before the positional prompt");
      }
      await manager.sendPrompt({ userId: user.id, sessionId: session.id, text: `${prepared.body.system}\n${prepared.displayText}`, displayText: prepared.displayText, attachmentInput: prepared });
      await prepared.finish(true); const completed = await waitForIdle(manager, user.id, session.id);
      const answer = completed.history.at(-1).parts.map((p) => p.text ?? "").join("");
      assert.match(answer, /CSV mean: 3/); assert.match(answer, /Image input verified:/); assert.match(answer, new RegExp(image.sha256));
      assert.equal(completed.history.filter((m) => m.info.role === "user").at(-1).info.id, prepared.body.messageID);
    }
  } finally { await manager.close(); await store.close(); }
});

test("rejects images for a catalogued text-only model before accepting the turn", async () => {
  const { root, manager } = await makeManager("codex");
  await writeFile(join(root, "admin-codex", "codex-models.json"), JSON.stringify({ models: [{ slug: "admin-model", input_modalities: ["text"] }] }));
  await manager.init();
  await manager.setUserRuntime("usr_a", "codex");
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const session = await manager.createSession({ userId: "usr_a", workspaceDir: workspace });
  await assert.rejects(manager.sendPrompt({ userId: "usr_a", sessionId: session.id, text: "Read this image", attachmentInput: { images: [{ path: join(root, "image.png") }] } }), { code: "image_model_unsupported" });
  assert.equal(session.status, "idle");
  assert.equal(session.history.length, 0);
  await manager.close();
});


test("project sessions keep their directory and reject another account workspace", async () => {
  const { root, manager } = await makeManager("codex");
  const workspace = join(root, "workspace");
  const a = join(workspace, "projects", "a");
  const b = join(workspace, "projects", "b");
  const foreign = join(root, "other-workspace");
  await Promise.all([mkdir(a, { recursive: true }), mkdir(b, { recursive: true }), mkdir(foreign)]);
  try {
    await manager.init(); await manager.setUserRuntime("usr_a", "codex");
    for (const directory of [a, b]) {
      const session = await manager.createSession({ userId: "usr_a", workspaceDir: workspace, directory });
      await manager.sendPrompt({ userId: "usr_a", sessionId: session.id, text: "project scope fixture" });
      const saved = await waitForIdle(manager, "usr_a", session.id);
      assert.equal(saved.directory, directory);
      await assert.rejects(manager.getOwnedSession("usr_other", session.id), /not found/);
    }
    await assert.rejects(manager.createSession({ userId: "usr_a", workspaceDir: workspace, directory: foreign }), /outside the user workspace/);
  } finally { await manager.close(); }
});
test('native runtime lifecycle hides trashed projects and denies owned direct access without deleting history',async()=>{
 const {manager,root}=await makeManager('codex');
 const workspace=join(root,'workspace');await mkdir(workspace,{recursive:true});
 const session=await manager.createSession({userId:'usr_a',workspaceDir:workspace});
 let trashed=true;
 manager.workspaceAccess=async(userId,directory)=>{if(trashed && userId==='usr_a' && directory===session.directory)throw Object.assign(new Error('project trashed'),{status:409,code:'project_trashed'});};
 assert.deepEqual(await manager.listSessions({userId:'usr_a'}),[]);
 await assert.rejects(manager.getOwnedSession('usr_a',session.id),{code:'project_trashed'});
 assert.equal((await manager.ensureUser('usr_a')).sessions.has(session.id),true);
 trashed=false;assert.equal((await manager.getOwnedSession('usr_a',session.id)).session.id,session.id);
 await manager.close();
});

async function historyFixture(manager, root, sessions, {legacy=false}={}) {
  const workspace=join(root,'workspace');await mkdir(workspace,{recursive:true});
  const folder=join(manager.rootDir,legacy?'users':'metadata','usr_a');await mkdir(folder,{recursive:true,mode:0o700});
  const path=join(folder,'sessions.json');
  const records=sessions.map((session,index)=>({id:`ses_cli_${String(index).padStart(16,'0')}`,userId:'usr_a',runtime:'codex',
    directory:workspace,title:'Retained conversation',createdAt:1,updatedAt:2,metadata:{},nativeSessionId:'same-native-id',history:[],...session}));
  await writeFile(path,JSON.stringify({version:1,sessions:records}),{mode:0o600});
  return {workspace,path,records};
}
test('managed historical reads retain both inactive assistants and partial payloads without loading or executing them',async()=>{
  const {root,manager}=await makeManager('opencode');manager.sandboxJobs={};
  const partial={info:{id:'message-partial',role:'assistant',sessionID:'ses_cli_0000000000000000',time:{created:1}},parts:[{type:'text',text:'Partial research'}]};
  const {workspace,records,path}=await historyFixture(manager,root,[{history:[partial]},{runtime:'claude'}]);
  manager.workspaceAccess=async(userId,directory)=>{assert.equal(userId,'usr_a');assert.equal(directory,workspace);};
  manager.profileResolver.refresh=async()=>assert.fail('Historical reads cannot resolve an inference profile');
  manager.spawnImpl=()=>assert.fail('Historical reads cannot start a host CLI');
  const original=await readFile(path,'utf8');
  const listed=await manager.readHistoricalSessions({userId:'usr_a',workspaceDir:workspace});
  assert.deepEqual(listed.map(value=>value.id),records.map(value=>value.id));
  const page=await manager.readHistoricalMessages({userId:'usr_a',workspaceDir:workspace,sessionId:records[0].id,limit:1});
  assert.deepEqual(page.messages,[partial]);assert.equal(page.nextCursor,null);assert.equal(page.session.runtime,'codex');
  assert.equal(manager.userStates.size,0);assert.equal(await readFile(path,'utf8'),original);
  await assert.rejects(manager.readHistoricalMessages({userId:'usr_b',workspaceDir:workspace,sessionId:records[0].id}),{code:'unknown_session'});
});
test('historical user-part normalization repairs only the known legacy generated ID without rewriting source bytes',async()=>{
 const {root,manager}=await makeManager('opencode');manager.sandboxJobs={};
 const message={info:{id:'actual-message',sessionID:'ses_cli_0000000000000000',role:'user',time:{completed:1}},
  parts:[{id:'old-part',messageID:'msg_cli_user_12345678-1234-1234-1234-123456789abc',sessionID:'ses_cli_0000000000000000',type:'text',text:'Preserved original prompt'}]};
 const {workspace,path,records}=await historyFixture(manager,root,[{history:[message]}]);
 const bytes=await readFile(path,'utf8');
 const result=await manager.readHistoricalMessages({userId:'usr_a',workspaceDir:workspace,sessionId:records[0].id});
 assert.equal(result.messages[0].parts[0].messageID,message.info.id);assert.equal(result.messages[0].parts[0].id,'old-part');
 assert.equal(await readFile(path,'utf8'),bytes);assert.equal(manager.userStates.size,0);
});
test('historical pagination binds its cursor to the exact source and never treats unfinished turns as completed',async()=>{
  const {root,manager}=await makeManager('opencode');manager.sandboxJobs={};
  const messages=Array.from({length:3},(_,index)=>({info:{id:`message-${index}`,role:index?'assistant':'user',time:{created:1}},parts:[{type:'text',text:`text-${index}`}]}));
  const {workspace,records,path}=await historyFixture(manager,root,[{history:messages}]);
  const first=await manager.readHistoricalMessages({userId:'usr_a',workspaceDir:workspace,sessionId:records[0].id,limit:1});
  const second=await manager.readHistoricalMessages({userId:'usr_a',workspaceDir:workspace,sessionId:records[0].id,limit:2,cursor:first.nextCursor});
  assert.deepEqual(second.messages,messages.slice(1));assert.equal(second.nextCursor,null);
  assert.equal(second.messages[0].info.time.completed,undefined);
  await assert.rejects(manager.readHistoricalMessages({userId:'usr_a',workspaceDir:workspace,sessionId:records[0].id,cursor:'invented'}),{code:'historical_cursor_changed'});
  records[0].history.push({...messages[0],info:{...messages[0].info,id:'message-4'}});
  await writeFile(path,JSON.stringify({version:1,sessions:records}));
  await assert.rejects(manager.readHistoricalMessages({userId:'usr_a',workspaceDir:workspace,sessionId:records[0].id,cursor:first.nextCursor}),{code:'historical_cursor_changed'});
});
test('legacy native metadata remains readable without a managed metadata directory and duplicate public origins fail closed',async()=>{
  const {root,manager}=await makeManager('opencode');manager.sandboxJobs={};
  const {workspace}=await historyFixture(manager,root,[{}],{legacy:true});
  assert.equal((await manager.readHistoricalSessions({userId:'usr_a',workspaceDir:workspace})).length,1);
  await assert.rejects(readFile(join(manager.rootDir,'metadata','usr_a','sessions.json')),{code:'ENOENT'});
  await historyFixture(manager,root,[{title:'Conflicting imported origin'}]);
  await assert.rejects(manager.readHistoricalSessions({userId:'usr_a',workspaceDir:workspace}),{code:'historical_source_conflict'});
});
test('historical sources validate owners, parent ancestry and workspace even for inactive runtimes',async()=>{
  for(const change of [{userId:'usr_b'},{directory:'/foreign/workspace'},{parentId:'ses_cli_0000000000000000'}]) {
    const {root,manager}=await makeManager('opencode');manager.sandboxJobs={};
    const {workspace,path}=await historyFixture(manager,root,[change]);const original=await readFile(path,'utf8');
    await assert.rejects(manager.readHistoricalSessions({userId:'usr_a',workspaceDir:workspace}),{code:'historical_source_unavailable'});
    assert.equal(await readFile(path,'utf8'),original);
  }
});
test('historical reads preserve trash state and deny direct archived workspace access without deleting data',async()=>{
  const {root,manager}=await makeManager('opencode');manager.sandboxJobs={};
  const {workspace,path,records}=await historyFixture(manager,root,[{}]);const original=await readFile(path,'utf8');
  manager.workspaceAccess=async()=>{throw Object.assign(Error('Project trashed'),{code:'project_trashed',status:409});};
  const listed=await manager.readHistoricalSessions({userId:'usr_a',workspaceDir:workspace});assert.equal(listed[0].lifecycle,'trashed');
  await assert.rejects(manager.readHistoricalMessages({userId:'usr_a',workspaceDir:workspace,sessionId:records[0].id}),{code:'project_trashed'});
  assert.equal(await readFile(path,'utf8'),original);
});
test('unknown schema and linked or public native history files fail closed and preserve the source',async()=>{
  for(const kind of ['schema','malformed','symlink','hardlink','public']) {
    const {root,manager}=await makeManager('opencode');manager.sandboxJobs={};
    const {workspace,path}=await historyFixture(manager,root,[{}]);
    if(kind==='schema')await writeFile(path,JSON.stringify({version:99,sessions:[]}));
    if(kind==='malformed')await writeFile(path,'{"version":1,');
    if(kind==='symlink'){const target=join(root,'source.json');await writeFile(target,await readFile(path),{mode:0o600});await rm(path);await symlink(target,path);}
    if(kind==='hardlink')await link(path,join(root,'hardlinked.json'));
    if(kind==='public')await chmod(path,0o644);
    const original=await readFile(path,'utf8');
    await assert.rejects(manager.readHistoricalSessions({userId:'usr_a',workspaceDir:workspace}),{code:'historical_source_unavailable'});
    assert.equal(await readFile(path,'utf8'),original);
  }
});
test('owned fork history retains the original ancestor message and attachment references',async()=>{
  const {root,manager}=await makeManager('opencode');manager.sandboxJobs={};
  const parent='ses_cli_0000000000000000',child='ses_cli_0000000000000001';
  const message={info:{id:'message-from-parent',role:'user',sessionID:parent,time:{created:1,completed:1}},
    parts:[{type:'file',url:'attachment://owned-reference',filename:'results.csv'}],attachments:{source:'owned-attachment'}};
  const {workspace}=await historyFixture(manager,root,[{history:[message]},{parentId:parent,history:[message]}]);
  const page=await manager.readHistoricalMessages({userId:'usr_a',workspaceDir:workspace,sessionId:child});
  assert.equal(page.session.parentID,parent);assert.deepEqual(page.messages,[message]);
});
async function conversationFixture() {
  const {root,manager,options}=await makeManager('opencode');await manager.init();
  const workspace=join(root,'workspace');await mkdir(workspace);
  const owner={userId:'usr_a',instanceId:'user-usr_a',generation:1,workspaceDir:workspace,directory:workspace};
  const conversations=new ConversationState({rootDir:join(root,'conversation-state'),authorize:async value=>{
    if(value.userId!==owner.userId || value.instanceId!==owner.instanceId || value.generation!==owner.generation || value.workspaceDir!==workspace)
      throw Object.assign(Error('Stale context'),{code:'stale_workspace_context'});
  }});
  const value=await conversations.create(owner,{conversationId:'public-session',title:'Research',parentId:null,lifecycle:'active'});
  const input={conversations,owner,conversationId:value.id,expectedRevision:value.revision,
    request:{requestId:'send-1',payloadHash:'a'.repeat(64),policyRevision:1,runtime:'opencode',generation:1,model:'approved',identityRevision:'profile-1'}};
  return {root,manager,options,conversations,owner,input};
}
test('global admission persists its policy lease before the canonical execution reservation and fences a concurrent switch',async()=>{
  const {manager,conversations,owner,input}=await conversationFixture();
  const prepare=conversations.prepareTurn.bind(conversations);let entered,release;
  const ready=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  conversations.prepareTurn=async(...args)=>{
    const data=JSON.parse(await readFile(manager.configPath,'utf8'));
    assert.equal(Object.values(data.assistantPolicy.executions)[0].identity.execution,1);
    entered();await gate;return prepare(...args);
  };
  const pending=manager.admitConversation(input);await ready;
  const switching=manager.selectAssistant({runtime:'codex',expectedRevision:1,operationId:'switch-during-send'});
  release();const admitted=await pending;
  await assert.rejects(switching,{code:'assistant_busy'});
  assert.equal(admitted.identity.execution,1);assert.equal(admitted.identity.generation,1);
  assert.equal((await conversations.open(owner,input.conversationId)).execution,1);
  await admitted.settle({cleanupVerified:true});
  assert.equal((await conversations.open(owner,input.conversationId)).turns['send-1'].state,'settled');
  assert.equal((await manager.selectAssistant({runtime:'codex',expectedRevision:1,operationId:'switch-after-cleanup'})).revision,2);
  await manager.close();
});
test('delivery loss retains both durable fences and duplicate request recovery never submits a new execution',async()=>{
  const {manager,conversations,owner,input}=await conversationFixture();
  const admitted=await manager.admitConversation(input);await admitted.submitted();
  await admitted.settle({cleanupVerified:false});
  const replay=await manager.admitConversation(input);
  assert.equal(replay.replay,true);assert.equal(replay.receipt.state,'unknown');assert.equal(replay.identity.execution,1);
  assert.equal(typeof replay.submitted,'undefined');
  await assert.rejects(manager.admitConversation({...input,expectedRevision:4,request:{...input.request,requestId:'send-again'}}),{code:'assistant_recovery_required'});
  await assert.rejects(manager.selectAssistant({runtime:'codex',expectedRevision:1,operationId:'blocked-switch'}),{code:'assistant_recovery_required'});
  const saved=JSON.parse(await readFile(manager.configPath,'utf8'));assert.equal(Object.values(saved.assistantPolicy.executions)[0].status,'unknown');
  assert.equal((await conversations.open(owner,input.conversationId)).turns['send-1'].state,'unknown');
  await manager.close();
});
test('malformed, stale and conflicting requests cannot create policy leases or consume conversation executions',async()=>{
  for(const patch of [{runtime:'codex'},{generation:2},{policyRevision:2},{model:'bad\nmodel'},{payloadHash:'invalid'},{extra:'untrusted'}]) {
    const {manager,conversations,owner,input}=await conversationFixture();
    await assert.rejects(manager.admitConversation({...input,request:{...input.request,...patch}}));
    assert.equal((await conversations.open(owner,input.conversationId)).execution,0);
    assert.deepEqual(JSON.parse(await readFile(manager.configPath,'utf8')).assistantPolicy.executions,{});
    await manager.close();
  }
});
test('a settled replay preserves the execution counter and changed payload cannot reuse its receipt',async()=>{
  const {manager,conversations,owner,input}=await conversationFixture();
  const admitted=await manager.admitConversation(input);await admitted.settle({cleanupVerified:true});
  const replay=await manager.admitConversation(input);assert.equal(replay.replay,true);assert.equal(replay.receipt.state,'settled');
  await assert.rejects(manager.admitConversation({...input,request:{...input.request,payloadHash:'b'.repeat(64)}}),{code:'conversation_request_conflict'});
  const current=await conversations.open(owner,input.conversationId);
  const second=await manager.admitConversation({...input,expectedRevision:current.revision,request:{...input.request,requestId:'send-2'}});
  assert.equal(second.identity.execution,2);await second.settle({cleanupVerified:true});await manager.close();
});
test('a canonical persistence failure after global reservation retains uncertainty through restart',async()=>{
  const {manager,options,conversations,input}=await conversationFixture();
  conversations.beforeCommit=async()=>{throw Error('Persistence acknowledgement lost');};
  await assert.rejects(manager.admitConversation(input),/Persistence acknowledgement lost/);
  assert.equal(Object.values(JSON.parse(await readFile(manager.configPath,'utf8')).assistantPolicy.executions)[0].status,'unknown');
  await manager.close();
  const restarted=new CliRuntimeManager(options);await restarted.init();
  assert.equal(restarted.assistantSnapshot('usr_a').recoveryRequired,true);
  await assert.rejects(restarted.selectAssistant({runtime:'codex',expectedRevision:1,operationId:'restart-must-not-clear'}),{code:'assistant_recovery_required'});
  await restarted.close();
});
test('native acceptance cannot be inferred from HTTP submission and cleanup transition serialization rejects late old states',async()=>{
  const {manager,conversations,owner,input}=await conversationFixture();
  const admitted=await manager.admitConversation(input);await admitted.submitted();
  await assert.rejects(admitted.accepted({runtime:'opencode',nativeSessionId:'unverified-native',turnId:'turn-1'}),{code:'invalid_conversation_transition'});
  assert.equal((await conversations.open(owner,input.conversationId)).turns['send-1'].state,'submitted');
  await admitted.settle({cleanupVerified:true});await admitted.settle({cleanupVerified:true});
  await assert.rejects(admitted.submitted(),{code:'invalid_conversation_transition'});
  assert.deepEqual(JSON.parse(await readFile(manager.configPath,'utf8')).assistantPolicy.executions,{});await manager.close();
});

test('native research reads and permission patches use owned native state and preserve explicit denies',async()=>{
  const {root,manager,options}=await makeManager('codex');await manager.init();await selectRuntime(manager,'codex');
  const directory=join(root,'workspace');await mkdir(directory);
  const session=await manager.createSession({userId:'research-user',workspaceDir:directory});
  const child=await manager.createSession({userId:'research-user',workspaceDir:directory});
  child.parentId=session.id;session.nativeSessionId='private-native-id';session.permission=[{permission:'bash',pattern:'*',action:'deny'}];
  session.history=[{info:{id:'message-owned',role:'user'},parts:[{type:'text',text:'Owned history'}]}];
  const call=(path,method='GET',body)=>manager.researchRequest({userId:'research-user',directory,path,method,body});
  const view=await call(`/session/${session.id}`);assert.equal(view.id,session.id);assert.equal(view.nativeSessionId,undefined);
  const messages=await call(`/session/${session.id}/message`);messages[0].parts[0].text='Mutated';assert.equal(session.history[0].parts[0].text,'Owned history');
  assert.equal((await call(`/session/${session.id}/children`))[0].id,child.id);
  const patched=await call(`/session/${session.id}`,'PATCH',{permission:[{permission:'*',pattern:'*',action:'allow'}]});
  assert.deepEqual(patched.permission,[{permission:'*',pattern:'*',action:'allow'},{permission:'bash',pattern:'*',action:'deny'}]);
  const policy=[{permission:'*',pattern:'*',action:'allow'},{permission:'external_directory',pattern:'*',action:'deny'},
    {permission:'external_directory',pattern:'/opt/scikeel/tools/resources/skills-core/*',action:'allow'}];
  await call(`/session/${session.id}`,'PATCH',{permission:policy});
  const repeated=await call(`/session/${session.id}`,'PATCH',{permission:policy});
  assert.equal(repeated.permission.filter(rule=>rule.permission==='external_directory').at(-1).action,'allow');
  assert.deepEqual(session.permission,[{permission:'bash',pattern:'*',action:'deny'}]);
  await assert.rejects(call(`/session/${session.id}`,'PATCH',{permission:[{permission:'bash',pattern:'*',action:'invalid'}]}));
  await assert.rejects(call(`/session/${session.id}`,'PATCH',{directory:'/tmp'}));
  await assert.rejects(manager.researchRequest({userId:'another-user',directory,path:`/session/${session.id}`}));
  await assert.rejects(manager.researchRequest({userId:'research-user',directory:join(directory,'other'),path:`/session/${session.id}`}));
  await assert.rejects(call(`/session/${session.id}/prompt_async`,'POST',{}));
  await manager.close();const restarted=new CliRuntimeManager(options);await restarted.init();
  assert.deepEqual((await restarted.researchRequest({userId:'research-user',directory,path:`/session/${session.id}`})).permission,repeated.permission);
  await restarted.close();
});
