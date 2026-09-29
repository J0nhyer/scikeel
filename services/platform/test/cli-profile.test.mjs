import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliProfileResolver } from "../src/cli-profile.mjs";

test("resolves native catalogs, aliases and private identity revisions", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "osd-profiles-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const claude = join(root, "claude");
  const codex = join(root, "codex");
  await fs.mkdir(claude); await fs.mkdir(codex);
  const settings = (token) => JSON.stringify({ model: "opus", env: { ANTHROPIC_DEFAULT_OPUS_MODEL: "fixture-opus-upstream", ANTHROPIC_AUTH_TOKEN: token } });
  await fs.writeFile(join(claude, "settings.json"), settings("fixture-secret-one"));
  await fs.writeFile(join(codex, "config.toml"), 'model = "gpt-1"\nmodel_provider = "OpenAI"\nmodel_catalog_json = "codex-models.json"\n[model_providers.OpenAI]\nbase_url = "https://fixture-relay.invalid/v1"\nwire_api = "responses"\n');
  await fs.writeFile(join(codex, "codex-models.json"), JSON.stringify({ models: Array.from({ length: 7 }, (_, i) => ({ slug: `gpt-${i + 1}`, display_name: `GPT ${i + 1}` })) }));
  const resolver = new CliProfileResolver({ claudeConfigDir: claude, codexHome: codex });
  const initial = await resolver.refresh("claude");
  assert.equal(initial.defaultModel, "fixture-opus-upstream");
  assert.deepEqual((await resolver.refresh("codex")).models.map((model) => model.id), Array.from({ length: 7 }, (_, i) => `gpt-${i + 1}`));
  assert.ok(!JSON.stringify(resolver.publicOption(initial)).includes("fixture-secret"));
  await fs.writeFile(join(claude, "settings.json"), settings("fixture-secret-two"));
  assert.notEqual((await resolver.refresh("claude")).identityRevision, initial.identityRevision);
  const before = await resolver.refresh("codex");
  await fs.writeFile(join(codex, "codex-models.json"), JSON.stringify({ models: [{ slug: "gpt-new", display_name: "New" }] }));
  const changed = await resolver.refresh("codex");
  assert.equal(changed.identityRevision, before.identityRevision);
  assert.notEqual(changed.catalogRevision, before.catalogRevision);
  const paths = { home: join(root, "home"), codexHome: join(root, "user-codex") };
  await fs.mkdir(paths.home);
  const copy = await resolver.copyForTurn(changed, { paths });
  assert.equal((await fs.stat(join(copy.codexHome, "config.toml"))).mode & 0o777, 0o600);
});

test("relay and credential rotation replace the live catalog without exposing identity", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "osd-relay-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const claude = join(root, "claude");
  await fs.mkdir(claude);
  const configure = (url, token) => fs.writeFile(join(claude, "settings.json"), JSON.stringify({
    model: "opus", env: { ANTHROPIC_BASE_URL: url, ANTHROPIC_AUTH_TOKEN: token, ANTHROPIC_DEFAULT_OPUS_MODEL: "fixture-default" },
  }));
  await configure("https://old.example/v1", "fixture-secret-one");
  let calls = 0;
  const resolver = new CliProfileResolver({ claudeConfigDir: claude, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(options.headers["x-api-key"], calls <= 1 ? "fixture-secret-one" : "fixture-secret-two");
    return { ok: true, json: async () => ({ data: [{ id: url.hostname === "old.example" ? "fixture-old" : "fixture-new" }] }) };
  } });
  const old = await resolver.refresh("claude");
  assert.equal(old.status, "ready");
  assert.ok(old.models.some((model) => model.id === "fixture-old"));
  await configure("https://new.example/v1", "fixture-secret-two");
  const fresh = await resolver.refresh("claude");
  assert.notEqual(fresh.identityRevision, old.identityRevision);
  assert.ok(fresh.models.some((model) => model.id === "fixture-new"));
  assert.ok(!fresh.models.some((model) => model.id === "fixture-old"));
  const exposed = JSON.stringify(resolver.publicOption(fresh));
  for (const secret of ["fixture-secret-two", "https://new.example/v1", claude]) assert.ok(!exposed.includes(secret));
  assert.equal(calls, 2);
});

test("a relay listing retires a stale Claude default and chooses an interactive model", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "osd-retired-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(join(root, "settings.json"), JSON.stringify({
    model: "retired-model",
    env: { ANTHROPIC_BASE_URL: "https://fixture.example/v1", ANTHROPIC_MODEL: "retired-model" },
  }));
  let listAvailable = true;
  const resolver = new CliProfileResolver({ claudeConfigDir: root, fetchImpl: async () => {
    if (!listAvailable) throw new Error("relay catalog unavailable");
    return { ok: true, json: async () => ({ data: [
      { id: "new-model:batch" }, { id: "new-model" },
    ] }) };
  } });
  const current = await resolver.refresh("claude");
  assert.deepEqual(current.models.map((item) => item.id), ["new-model:batch", "new-model"]);
  assert.equal(current.defaultModel, "new-model");
  listAvailable = false;
  const fallback = await resolver.refresh("claude", { forceRemote: true });
  assert.equal(fallback.status, "limited");
  assert.equal(fallback.defaultModel, "retired-model");
});

test("configuration changes invalidate copies even when the visible model catalog is unchanged", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "osd-copy-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const codex = join(root, "codex");
  await fs.mkdir(codex);
  const config = (flag) => `model = "gpt-fixture"\n[model_providers.OpenAI]\nbase_url = "https://relay.example/v1"\nwire_api = "responses"\n[features]\ntest_flag = ${flag}\n`;
  await fs.writeFile(join(codex, "config.toml"), config(false));
  const resolver = new CliProfileResolver({ codexHome: codex });
  const before = await resolver.refresh("codex");
  await fs.writeFile(join(codex, "config.toml"), config(true));
  const after = await resolver.refresh("codex");
  assert.equal(before.catalogRevision, after.catalogRevision);
  assert.notEqual(before.sourceRevision, after.sourceRevision);
  const paths = { home: join(root, "home"), codexHome: join(root, "user-codex") };
  await assert.rejects(resolver.copyForTurn(before, { paths }), /changed during copy/);
  const pinned = await resolver.copyForTurn(after, { paths });
  assert.equal(await fs.readFile(join(pinned.codexHome, "config.toml"), "utf8"), config(true));
});

test("Codex expands its standard home catalog path", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "osd-codex-home-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = join(root, ".codex");
  await fs.mkdir(home);
  await fs.writeFile(join(home, "config.toml"), 'model = "gpt-fixture"\nmodel_catalog_json = "~/.codex/codex-models.json"\n');
  await fs.writeFile(join(home, "codex-models.json"), JSON.stringify({ models: [{ slug: "model-one" }, { slug: "model-two" }] }));
  const profile = await new CliProfileResolver({ codexHome: home }).refresh("codex");
  assert.deepEqual(profile.models.map(({ id }) => id), ["model-one", "model-two", "gpt-fixture"]);
});

test("remote catalog TTL is measured from discovery, not extended by metadata reads", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "osd-ttl-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(join(root, "settings.json"), JSON.stringify({ model: "fixture", env: { ANTHROPIC_BASE_URL: "https://fixture.example/v1" } }));
  let time = 0, calls = 0;
  const resolver = new CliProfileResolver({ claudeConfigDir: root, clock: () => time, fetchImpl: async () => {
    calls++;
    return { ok: true, json: async () => ({ data: [{ id: `model-${calls}` }] }) };
  } });
  await resolver.refresh("claude");
  time = 30_000;
  await resolver.refresh("claude");
  time = 61_000;
  const fresh = await resolver.refresh("claude");
  assert.equal(calls, 2);
  assert.ok(fresh.models.some(({ id }) => id === "model-2"));
  assert.ok(!fresh.models.some(({ id }) => id === "model-1"));
});

test("catalog-only changes and reverts share current private native history but new identities do not", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "osd-native-state-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const codex = join(root, "codex");
  await fs.mkdir(codex);
  await fs.writeFile(join(codex, "config.toml"), 'model = "fixture"\nmodel_catalog_json = "models.json"\n');
  const catalog = JSON.stringify({ models: ["fixture"] });
  await fs.writeFile(join(codex, "models.json"), catalog);
  const resolver = new CliProfileResolver({ codexHome: codex });
  const paths = { home: join(root, "user-home"), codexHome: join(root, "user-codex") };
  const original = await resolver.refresh("codex");
  const first = await resolver.copyForTurn(original, { paths });
  await fs.writeFile(join(first.codexHome, "sessions", "native.jsonl"), "first");
  await fs.writeFile(join(codex, "models.json"), JSON.stringify({ models: ["fixture", "next"] }));
  const second = await resolver.copyForTurn(await resolver.refresh("codex"), { paths });
  assert.equal(await fs.readFile(join(second.codexHome, "sessions", "native.jsonl"), "utf8"), "first");
  await fs.writeFile(join(second.codexHome, "sessions", "native.jsonl"), "continued");
  await fs.writeFile(join(codex, "models.json"), catalog);
  const reverted = await resolver.copyForTurn(await resolver.refresh("codex"), { paths });
  assert.equal(await fs.readFile(join(reverted.codexHome, "sessions", "native.jsonl"), "utf8"), "continued");
  await fs.writeFile(join(codex, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "fixture-new-token" }));
  const changedIdentity = await resolver.copyForTurn(await resolver.refresh("codex"), { paths });
  await assert.rejects(fs.readFile(join(changedIdentity.codexHome, "sessions", "native.jsonl")), { code: "ENOENT" });
});
