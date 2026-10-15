import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "smol-toml";
import * as profiles from "../src/cli-profile.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), "scikeel-managed-profile-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = join(root, "personal"), home = join(root, "platform", "codex-service");
  await fs.mkdir(source, { mode: 0o700 });
  await fs.mkdir(join(root, "platform"), { mode: 0o700 });
  const catalog = join(root, "absolute-catalog.json");
  const model = { slug: "gpt-6.1-sol", display_name: "Approved Model", input_modalities: ["text", "image"],
    supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
    shell_type: "unified_exec", apply_patch_tool_type: "freeform", base_instructions: "HOST_INSTRUCTIONS_MUST_NOT_IMPORT" };
  await fs.writeFile(catalog, JSON.stringify({ models: [model,
    { ...model, slug: "unapproved-model", base_instructions: "OTHER_MODEL_INSTRUCTIONS_MUST_NOT_IMPORT" }] }), { mode: 0o600 });
  const config = { model: "gpt-6.1-sol", model_provider: "fixture", model_catalog_json: catalog,
    model_providers: { fixture: { base_url: "http://203.0.113.25:18001/v1", wire_api: "responses", env_key: "SCIKEEL_FIXTURE_PROVIDER_KEY",
      http_headers: { "x-host-header": "HOST_HEADER_MUST_NOT_IMPORT" } } },
    mcp_servers: { dangerous: { command: "HOST_COMMAND_MUST_NOT_IMPORT" } },
    projects: { "/host/trusted": { trust_level: "trusted" } }, approval_policy: "never", sandbox_mode: "danger-full-access" };
  await fs.writeFile(join(source, "config.toml"), stringify(config), { mode: 0o600 });
  await fs.writeFile(join(source, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "unused-host-auth-key" }), { mode: 0o600 });
  return { root, source, home, catalog, config, environment: { SCIKEEL_FIXTURE_PROVIDER_KEY: "synthetic-service-upstream-key" } };
}

function resolver(input) {
  assert.equal(typeof profiles.ManagedCodexProfile, "function", "The isolated service-profile implementation is not present");
  return new profiles.ManagedCodexProfile({ home: input.home, allowedModels: ["gpt-6.1-sol"], environment: input.environment });
}

test("managed Codex imports only allowed metadata and keeps credentials in an independent private service home", async t => {
  const input = await fixture(t);
  const original = await fs.readFile(join(input.source, "config.toml"), "utf8");
  const service = resolver(input);
  await service.initializeFromSource({ codexHome: input.source });
  const current = await service.refresh("codex");
  assert.equal(current.status, "ready");
  assert.deepEqual(current.models.map(value => value.id), ["gpt-6.1-sol"]);
  assert.deepEqual(current.models[0].inputModalities, ["text", "image"]);
  assert.deepEqual(Object.keys(current.models[0].variants), ["low", "high"]);
  assert.equal(service.copyForTurn, undefined, "Managed profiles must never expose the host-copy path");
  const provider = await service.resolveProvider(current.identityRevision);
  assert.equal(provider.baseUrl, "http://203.0.113.25:18001/v1");
  assert.equal(provider.credential, input.environment.SCIKEEL_FIXTURE_PROVIDER_KEY);
  assert.deepEqual(provider.enabledModels, ["gpt-6.1-sol"]);
  assert.deepEqual(provider.routes, ["/v1/responses"]);
  assert.equal(provider.authMode, "bearer");
  const publicText = JSON.stringify(service.publicOption(current));
  for (const canary of [input.source, "203.0.113.25", "synthetic-service-upstream-key", "unused-host-auth-key", "HOST_"])
    assert(!publicText.includes(canary), "Public metadata must not expose private source or provider fields");
  assert.equal(await fs.readFile(join(input.source, "config.toml"), "utf8"), original);
  const files = await fs.readdir(input.home, { recursive: true, withFileTypes: true });
  let stored = "";
  for (const entry of files) {
    const path = join(entry.parentPath, entry.name), stat = await fs.lstat(path);
    assert(!stat.isSymbolicLink());
    assert.equal(stat.uid, process.getuid());
    assert.equal(stat.mode & 0o777, stat.isDirectory() ? 0o700 : 0o600);
    if (stat.isFile()) stored += await fs.readFile(path, "utf8");
  }
  assert(files.length > 0);
  for (const canary of ["HOST_", "unapproved-model", "unused-host-auth-key", "/host/trusted", "danger-full-access"])
    assert(!stored.includes(canary), "Initialization must not copy host instructions, credentials or authority wholesale");
  const reloaded = resolver({ ...input, environment: {} });
  assert.equal((await reloaded.resolveProvider((await reloaded.refresh("codex")).identityRevision)).credential,
    input.environment.SCIKEEL_FIXTURE_PROVIDER_KEY);
});

test("managed Codex refresh does not silently resynchronize the personal source and explicit sync checks its revision", async t => {
  const input = await fixture(t), service = resolver(input);
  await service.initializeFromSource({ codexHome: input.source });
  const before = await service.refresh("codex");
  input.config.model_providers.fixture.base_url = "http://203.0.113.26:18001/v1";
  await fs.writeFile(join(input.source, "config.toml"), stringify(input.config));
  assert.equal((await service.refresh("codex")).identityRevision, before.identityRevision);
  assert.equal((await service.resolveProvider(before.identityRevision)).baseUrl, "http://203.0.113.25:18001/v1");
  await assert.rejects(service.initializeFromSource({ codexHome: input.source }), { code: "service_profile_initialized" });
  await service.synchronizeFromSource({ codexHome: input.source, expectedRevision: before.sourceRevision });
  const after = await service.refresh("codex");
  assert.notEqual(after.identityRevision, before.identityRevision);
  await assert.rejects(service.resolveProvider(before.identityRevision), { code: "profile_revision_conflict" });
  await assert.rejects(service.synchronizeFromSource({ codexHome: input.source, expectedRevision: before.sourceRevision }),
    { code: "profile_revision_conflict" });
  assert.equal((await service.resolveProvider(after.identityRevision)).baseUrl, "http://203.0.113.26:18001/v1");
});

test("managed Codex rejects symlinked service roots and unsafe service permissions without changing the personal source", async t => {
  const input = await fixture(t), service = resolver(input);
  const outside = join(input.root, "outside");
  await fs.mkdir(outside, { mode: 0o700 });
  await fs.symlink(outside, input.home);
  await assert.rejects(service.initializeFromSource({ codexHome: input.source }), { code: "unsafe_service_profile" });
  assert.deepEqual(await fs.readdir(outside), []);
  await fs.unlink(input.home);
  await service.initializeFromSource({ codexHome: input.source });
  await fs.chmod(input.home, 0o770);
  await assert.rejects(service.refresh("codex"), { code: "unsafe_service_profile" });
  assert.equal((await fs.stat(input.source)).mode & 0o777, 0o700);
});

test("managed Codex rejects extra or malformed persisted model metadata before public exposure", async t => {
  const input = await fixture(t), service = resolver(input);
  await service.initializeFromSource({ codexHome: input.source });
  const path = join(input.home, "service-profile.json");
  const original = JSON.parse(await fs.readFile(path, "utf8"));
  for (const change of [model => { model.base_instructions = "MUST_NOT_BECOME_PUBLIC"; },
    model => { model.variants.low = { reasoningEffort: "high", credential: "MUST_NOT_BECOME_PUBLIC" }; },
    model => { model.inputModalities = ["text", "host-file-access"]; }]) {
    const changed = structuredClone(original);
    change(changed.models[0]);
    await fs.writeFile(path, JSON.stringify(changed));
    await assert.rejects(service.refresh("codex"), { code: "unsafe_service_profile" });
  }
});

test("managed Codex missing private parent fails closed without exposing filesystem paths", async t => {
  const input = await fixture(t);
  const service = resolver({ ...input, home: join(input.root, "absent", "service") });
  await assert.rejects(service.initializeFromSource({ codexHome: input.source }), error =>
    error.code === "unsafe_service_profile" && !error.message.includes(input.root));
});

test("managed Codex never falls back to host auth when a selected environment credential is absent", async t => {
  const input = await fixture(t), service = resolver({ ...input, environment: {} });
  await assert.rejects(service.initializeFromSource({ codexHome: input.source }), { code: "service_profile_unavailable" });
  assert.deepEqual(await fs.readdir(input.home), []);
  assert.equal((await service.refresh("codex")).status, "unavailable");
});

test("managed Codex extracts only the selected API key when native auth is its explicit source", async t => {
  const input = await fixture(t), service = resolver(input);
  delete input.config.model_providers.fixture.env_key;
  await fs.writeFile(join(input.source, "config.toml"), stringify(input.config));
  await fs.writeFile(join(input.source, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "selected-synthetic-key",
    tokens: { access_token: "UNSELECTED_HOST_OAUTH_TOKEN" }, account_id: "UNSELECTED_PERSONAL_ACCOUNT" }));
  await service.initializeFromSource({ codexHome: input.source });
  const profile = await service.refresh("codex");
  assert.equal((await service.resolveProvider(profile.identityRevision)).credential, "selected-synthetic-key");
  const saved = await fs.readFile(join(input.home, "service-profile.json"), "utf8");
  assert(!saved.includes("UNSELECTED_"));
  assert(!JSON.stringify(profile).includes("selected-synthetic-key"));
});

test("managed Codex rejects symlinked and group-readable service credential files", async t => {
  const input = await fixture(t), service = resolver(input);
  await service.initializeFromSource({ codexHome: input.source });
  const path = join(input.home, "service-profile.json"), outside = join(input.root, "outside-profile.json");
  await fs.rename(path, outside);
  await fs.symlink(outside, path);
  await assert.rejects(service.refresh("codex"), { code: "unsafe_service_profile" });
  await fs.unlink(path);
  await fs.rename(outside, path);
  await fs.chmod(path, 0o640);
  await assert.rejects(service.refresh("codex"), { code: "unsafe_service_profile" });
});

test("managed Codex concurrent explicit synchronizations cannot both consume one revision", async t => {
  const input = await fixture(t), service = resolver(input);
  await service.initializeFromSource({ codexHome: input.source });
  const before = await service.refresh("codex");
  const second = resolver(input);
  const results = await Promise.allSettled([service, second].map(value => value.synchronizeFromSource({
    codexHome: input.source, expectedRevision: before.sourceRevision })));
  assert.equal(results.filter(value => value.status === "fulfilled").length, 1);
  const denied = results.find(value => value.status === "rejected");
  assert(["service_profile_busy", "profile_revision_conflict"].includes(denied.reason.code));
  assert.notEqual((await service.refresh("codex")).sourceRevision, before.sourceRevision);
});

test("managed Codex cannot publish an import when its selected source changes during parsing", async t => {
  const input = await fixture(t);
  const changed = structuredClone(input.config);
  changed.model_providers.fixture.base_url = "http://203.0.113.26:18001/v1";
  const environment = Object.defineProperty({}, "SCIKEEL_FIXTURE_PROVIDER_KEY", { get() {
    writeFileSync(join(input.source, "config.toml"), stringify(changed));
    return "synthetic-service-upstream-key";
  } });
  const service = resolver({ ...input, environment });
  await assert.rejects(service.initializeFromSource({ codexHome: input.source }), { code: "service_profile_source_changed" });
  assert.deepEqual(await fs.readdir(input.home), []);
});

test("managed Codex missing allowed metadata, ambiguous entries and OAuth-only auth never become ready", async t => {
  const input = await fixture(t), service = resolver(input);
  const original = JSON.parse(await fs.readFile(input.catalog, "utf8"));
  for (const models of [[], [original.models[1]], [original.models[0], original.models[0]]]) {
    await fs.writeFile(input.catalog, JSON.stringify({ models }));
    await assert.rejects(service.initializeFromSource({ codexHome: input.source }), { code: "service_profile_unavailable" });
    assert.deepEqual(await fs.readdir(input.home), []);
  }
  await fs.writeFile(input.catalog, JSON.stringify(original));
  delete input.config.model_providers.fixture.env_key;
  await fs.writeFile(join(input.source, "config.toml"), stringify(input.config));
  await fs.writeFile(join(input.source, "auth.json"), JSON.stringify({ tokens: { access_token: "OAUTH_NOT_AN_API_KEY" } }));
  await assert.rejects(service.initializeFromSource({ codexHome: input.source }), { code: "service_profile_unavailable" });
});
