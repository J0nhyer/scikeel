import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { afterEach, test } from "node:test";

import { CliRuntimeManager, handoverText } from "../src/cli-runtime.mjs";

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
  const options = {
      rootDir: join(root, "runtime"),
      runtime,
      claudeCommand: process.execPath,
      claudeArgs: [fakeCli, "claude"],
      codexCommand: process.execPath,
      codexArgs: [fakeCli, "codex"],
      claudeConfigDir: adminClaude,
      codexHome: adminCodex,
      turnTimeoutMs: 5_000,
  };
  return {
    root,
    options,
    manager: new CliRuntimeManager(options),
  };
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
    try { pid = Number(await readFile(join(workspace, "child.pid"), "utf8")); break; }
    catch { await new Promise((done) => setTimeout(done, 20)); }
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
  test(`${runtime} access switches persist, preserve accepted turns and history, and reject subsequent calls`, async () => {
    const { root, manager, options } = await makeManager(runtime);
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await manager.init();
    const session = await manager.createSession({ userId: "usr_a", workspaceDir: workspace });
    const turn = await manager.reservePrompt({ userId: "usr_a", sessionId: session.id, text: "accepted research task" });
    await manager.setAssistantEnabled(runtime, false);
    assert.equal(manager.describe("usr_a").available.find((item) => item.runtime === runtime).enabled, false);
    await manager.runReservedPrompt(turn);
    const finished = await waitForIdle(manager, "usr_a", session.id);
    assert.equal(finished.history.length, 2);
    assert.equal(finished.history.at(-1).info.error, undefined);
    await assert.rejects(manager.sendPrompt({ userId: "usr_a", sessionId: session.id, text: "blocked" }), { code: "runtime_unconfigured" });
    await assert.rejects(manager.setUserRuntime("usr_b", runtime), { code: "runtime_unconfigured" });
    assert.equal(finished.history.length, 2);
    const restarted = new CliRuntimeManager(options);
    await restarted.init();
    assert.equal(restarted.adminDescribe().assistantEnabled[runtime], false);
    await restarted.close();
    await manager.setAssistantEnabled(runtime, true);
    await manager.sendPrompt({ userId: "usr_a", sessionId: session.id, text: "continue" });
    await waitForIdle(manager, "usr_a", session.id);
    assert.equal(finished.history.length, 4);
    await manager.close();
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

test("migrates the old global switch to OpenCode and persists per-user choices", async () => {
  const { root, options, manager } = await makeManager("codex");
  await mkdir(join(root, "runtime"), { recursive: true });
  await writeFile(
    join(root, "runtime", "runtime.json"),
    `${JSON.stringify({ version: 1, runtime: "codex" })}\n`,
  );

  await manager.init();
  assert.equal(manager.describe("usr_a").runtime, "opencode");
  assert.equal(manager.describe("usr_b").runtime, "opencode");
  assert.equal((await manager.setUserRuntime("usr_a", "codex")).runtime, "codex");
  assert.equal(manager.describe("usr_b").runtime, "opencode");
  await manager.close();

  const persisted = JSON.parse(await readFile(join(root, "runtime", "runtime.json"), "utf8"));
  assert.equal(persisted.version, 4);
  assert.equal(persisted.defaultRuntime, "opencode");
  assert.equal(persisted.userRuntimes.usr_a, "codex");

  const reopened = new CliRuntimeManager(options);
  await reopened.init();
  assert.equal(reopened.describe("usr_a").runtime, "codex");
  assert.equal(reopened.describe("usr_b").runtime, "opencode");
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

  assert.equal(manager.describe("usr_a").runtime, "codex");
  assert.deepEqual(manager.adminDescribe().assistantEnabled, { claude: true, codex: true });
  const saved = JSON.parse(await readFile(join(root, "runtime", "runtime.json"), "utf8"));
  assert.equal(saved.version, 4);
  assert.equal(saved.userRuntimes.usr_a, "codex");
});

test("remembers one enabled managed model per user and runtime", async () => {
  const { manager, root } = await makeManager("opencode");
  await manager.init();
  await writeFile(join(root, "admin-claude", "settings.json"), JSON.stringify({ model: "sonnet", env: { ANTHROPIC_DEFAULT_SONNET_MODEL: "sonnet", ANTHROPIC_DEFAULT_OPUS_MODEL: "opus" } }));
  await manager.refreshProfiles();
  await manager.setUserRuntime("usr_a", "codex", "gpt-deep");
  await manager.setUserModel("usr_a", "claude", "opus");

  assert.equal(manager.describe("usr_a").model, "gpt-deep");
  assert.equal(manager.modelForUser("usr_a", "claude"), "opus");
});

test("falls back to the new default when an administrator removes a selected model", async () => {
  const { manager, root } = await makeManager("opencode");
  await manager.init();
  await writeFile(join(root, "admin-codex", "config.toml"), 'model = "gpt-fast"\nmodel_catalog_json = "codex-models.json"\n');
  await manager.refreshProfiles();
  await manager.setUserRuntime("usr_a", "codex", "gpt-deep");

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
  assert.equal(saved.version, 4);
  assert.deepEqual(saved.assistantEnabled, { claude: false, codex: true });
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
