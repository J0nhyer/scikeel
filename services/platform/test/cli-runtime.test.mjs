import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

import { CliRuntimeManager } from "../src/cli-runtime.mjs";

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
  await writeFile(join(adminClaude, "settings.json"), JSON.stringify({ model: "admin-model" }));
  await writeFile(join(adminCodex, "auth.json"), "{\"auth\":true}\n");
  await writeFile(join(adminCodex, "config.toml"), "model = \"admin-model\"\n");
  await writeFile(join(adminCodex, "codex-models.json"), "{\"models\":true}\n");
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
  await manager.setManagedRuntime("claude", ["sonnet", "opus"], "sonnet");
  await manager.setUserRuntime("usr_a", "claude", "opus");
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const session = await manager.createSession({ userId: "usr_a", workspaceDir: workspace });
  await manager.sendPrompt({ userId: "usr_a", sessionId: session.id, text: "hello" });
  const finished = await waitForIdle(manager, "usr_a", session.id);

  assert.equal(finished.nativeSessionId, "claude-native-session");
  assert.equal(finished.history.at(-1).info.error, undefined);
  assert.match(finished.history.at(-1).parts[0]?.text ?? "", /Claude\[opus\]: hello/);
  assert.equal(await readFile(join(root, "runtime", "users", "usr_a", "claude-config", "settings.json"), "utf8"), '{"model":"admin-model"}');
  assert.equal((await manager.listSessions({ userId: "usr_b" })).length, 0);
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
  await manager.setManagedRuntime("codex", ["gpt-fast", "gpt-deep"], "gpt-fast");
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
  assert.match(await readFile(join(root, "runtime", "users", "usr_a", "codex-home", "config.toml"), "utf8"), /admin-model/);
  assert.equal(
    await readFile(join(root, "runtime", "users", "usr_a", "home", ".codex", "codex-models.json"), "utf8"),
    await readFile(join(root, "admin-codex", "codex-models.json"), "utf8"),
  );
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
  assert.equal(persisted.version, 3);
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
  assert.deepEqual(manager.adminDescribe().managedRuntimes, {
    claude: { models: ["admin-model"], defaultModel: "admin-model" },
    codex: { models: ["admin-model"], defaultModel: "admin-model" },
  });
  const saved = JSON.parse(await readFile(join(root, "runtime", "runtime.json"), "utf8"));
  assert.equal(saved.version, 3);
  assert.equal(saved.userRuntimes.usr_a, "codex");
});

test("remembers one enabled managed model per user and runtime", async () => {
  const { manager } = await makeManager("opencode");
  await manager.init();
  await manager.setManagedRuntime("codex", ["gpt-fast", "gpt-deep"], "gpt-fast");
  await manager.setManagedRuntime("claude", ["sonnet", "opus"], "sonnet");
  await manager.setUserRuntime("usr_a", "codex", "gpt-deep");
  await manager.setUserModel("usr_a", "claude", "opus");

  assert.equal(manager.describe("usr_a").model, "gpt-deep");
  assert.equal(manager.modelForUser("usr_a", "claude"), "opus");
});

test("falls back to the new default when an administrator removes a selected model", async () => {
  const { manager } = await makeManager("opencode");
  await manager.init();
  await manager.setManagedRuntime("codex", ["gpt-fast", "gpt-deep"], "gpt-fast");
  await manager.setUserRuntime("usr_a", "codex", "gpt-deep");

  await manager.setManagedRuntime("codex", ["gpt-fast"], "gpt-fast");

  assert.equal(manager.modelForUser("usr_a", "codex"), "gpt-fast");
  assert.equal(manager.describe("usr_a").model, "gpt-fast");
});
