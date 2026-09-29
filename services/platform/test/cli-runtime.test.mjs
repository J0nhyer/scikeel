import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
