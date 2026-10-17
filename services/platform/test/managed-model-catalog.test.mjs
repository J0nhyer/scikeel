import test from "node:test";
import assert from "node:assert/strict";
import { createManagedModelCatalogReader, readManagedModelCatalog, readManagedDefaultModel, saveManagedDefaultModel } from "../src/managed-model-catalog.mjs";
import { brokerProfile, validateBrokerConfiguration } from "../src/sandbox-control-plane.mjs";

const config = { defaultProvider: "research", defaultModel: "approved", providers: {
  research: { enabledModels: ["approved", "retired"] },
  unused: { enabledModels: ["unconnected"] },
} };
const access = { url: "http://172.31.240.2:4790", token: "private-worker-token" };
const context = { workspaceDir: "/tenant/workspace" };
const runtime = { providers: [
  { id: "research", name: "Research provider", options: { apiKey: "private-upstream-key" }, models: {
    approved: { name: "Actual Research Model", variants: { high: { apiKey: "hidden" } }, limit: { context: 200000 },
      api: { url: "private-upstream-url" }, options: { apiKey: "hidden" } },
    unexpected: { name: "Unapproved" },
  } },
  { id: "codex", models: { "gpt-stale": { name: "Stale Codex model" } } },
] };
function fetchFixture(catalog = runtime, model = "research/approved") {
  return async (url, options) => {
    assert.equal(new URL(url).searchParams.get("directory"), context.workspaceDir);
    assert.equal(options.headers.authorization, `Basic ${Buffer.from(`opencode:${access.token}`).toString("base64")}`);
    assert.equal(options.redirect, "error");
    return { ok: true, json: async () => new URL(url).pathname === "/config/providers" ? catalog : { model, provider: { secret: "hidden" } } };
  };
}
test('internal managed catalog binds one trusted configuration snapshot and actual filtered model metadata',async()=>{
 const source=structuredClone(config),reader=createManagedModelCatalogReader({config:source,fetchImpl:fetchFixture()});
 const first=await reader(context,{access});assert.match(first.identityRevision,/^[a-f0-9]{64}$/);
 assert.equal((await reader(context,{access})).identityRevision,first.identityRevision);
 source.providers.research.enabledModels=['unexpected'];
 assert.equal((await reader(context,{access})).identityRevision,first.identityRevision,'External mutation cannot replace the loaded trusted snapshot');
 const replacement=createManagedModelCatalogReader({config,fetchImpl:fetchFixture()});
 assert.notEqual((await replacement(context,{access})).identityRevision,first.identityRevision,'Reloaded server configuration invalidates native reuse without hashing secrets');
 assert(!JSON.stringify(first).includes(access.token));
});

test("OpenCode catalog uses live models and metadata rather than the broker's static or Codex lists", async () => {
  const catalog = await readManagedModelCatalog({ config, access, context, fetchImpl: fetchFixture() });
  assert.deepEqual(catalog, {
    model: "research/approved", connected: ["research"], defaults: { research: "approved" },
    providers: [{ id: "research", name: "Research provider", models: {
      approved: { id: "approved", providerID: "research", name: "Actual Research Model", variants: { high: {} }, limit: { context: 200000 } },
    } }],
  });
  const text = JSON.stringify(catalog);
  for (const secret of ["private-worker-token", "private-upstream", "hidden", "gpt-stale", "retired", "unconnected"])
    assert.ok(!text.includes(secret));
});

test("catalog refresh removes retired models and never replaces an invalid default with a static model", async () => {
  const catalog = await readManagedModelCatalog({ config, access, context,
    fetchImpl: fetchFixture({ providers: [] }, "codex/gpt-stale") });
  assert.deepEqual(catalog, { model: null, providers: [], connected: [], defaults: {} });
});

test("OpenCode replacement models use administrator configuration for grants, defaults and the public catalog without changing permissions", async () => {
  const configuration = { schema: 1, defaultProvider: "research", defaultModel: "fixture-next-model", mirrorUrl: "http://127.0.0.1:3141",
    providers: { research: { enabledModels: ["fixture-next-model"], baseUrl: "https://provider.example/v1",
      credential: "synthetic-only", authMode: "bearer", routes: ["/v1/chat/completions"],
      modelNames: { "fixture-next-model": "Configured Next Model" }, modelVariants: { "fixture-next-model": ["high"] } } } };
  validateBrokerConfiguration(configuration);
  const grants = [];
  const profile = brokerProfile({ config: configuration, context: { userId: "owner", instanceId: "user-owner", generation: 1 },
    model: "research/approved", broker: { issue: grant => { grants.push(grant); return "a".repeat(64); } },
    assistantPolicy: { activeRuntime: "opencode", revision: 2, recoveryRequired: false } });
  assert.equal(profile.model, "research/fixture-next-model");
  assert.deepEqual(grants[0].models, ["fixture-next-model"]);
  assert.equal(profile.permission.bash, "ask"); assert.equal(profile.permission.external_directory, "deny");
  const catalog = await readManagedModelCatalog({ config: configuration, access, context,
    fetchImpl: fetchFixture({ providers: [{ id: "research", models: {
      approved: { name: "Previous Model" }, "fixture-next-model": { variants: { high: {}, medium: {} } },
      unapproved: { name: "Not Authorized" },
    } }] }, profile.model) });
  assert.equal(catalog.model, profile.model);
  assert.deepEqual(Object.keys(catalog.providers[0].models), ["fixture-next-model"]);
  assert.equal(catalog.providers[0].models["fixture-next-model"].name, "Configured Next Model");
  assert.deepEqual(catalog.providers[0].models["fixture-next-model"].variants, { high: {} });
});

test("a failed or malformed OpenCode catalog cannot fall back to the static broker catalog", async () => {
  for (const fetchImpl of [async () => ({ ok: false }), fetchFixture({}), fetchFixture({ providers: [{}] }),
    fetchFixture({ providers: [{ id: "research", models: null }] })]) {
    await assert.rejects(readManagedModelCatalog({ config, access, context, fetchImpl }), /OpenCode model catalog unavailable/);
  }
});

test("only primitive model metadata and variant names cross the managed gateway", async () => {
  const catalog = await readManagedModelCatalog({ config, access, context, fetchImpl: fetchFixture({ providers: [{
    id: "research", name: { secret: "hidden" }, models: { approved: {
      name: { apiKey: "hidden" }, variants: { high: { secret: "hidden" }, "bad token": {} }, limit: { context: -1 },
    } },
  }] }) });
  assert.equal(catalog.providers[0].name, "research");
  assert.deepEqual(catalog.providers[0].models.approved, { id: "approved", providerID: "research", name: "approved", variants: { high: {} } });
});

test("managed profile ID labels cannot overwrite original OpenCode model names and capitalization", async () => {
  const named = { ...config, defaultProvider: "opencode", providers: { opencode: {
    enabledModels: ["big-pickle", "mimo-v2.6-flash-free"], name: "OpenCode Zen",
    modelNames: { "big-pickle": "Big Pickle", "mimo-v2.6-flash-free": "MiMo-V2.6-Flash Free" },
  } } };
  const catalog = await readManagedModelCatalog({ config: named, access, context, fetchImpl: fetchFixture({ providers: [{
    id: "opencode", name: "opencode", models: { "big-pickle": { name: "big-pickle" }, "mimo-v2.6-flash-free": { name: "mimo-v2.6-flash-free" } },
  }] }, "opencode/big-pickle") });
  assert.equal(catalog.providers[0].name, "OpenCode Zen");
  assert.equal(catalog.providers[0].models["big-pickle"].name, "Big Pickle");
  assert.equal(catalog.providers[0].models["mimo-v2.6-flash-free"].name, "MiMo-V2.6-Flash Free");
});


test("declared model levels hide runtime-inferred reasoning choices", async () => {
  const selected = { ...config, providers: { research: { ...config.providers.research,
    modelVariants: { approved: ["low", "high", "max"] },
  } } };
  const catalog = await readManagedModelCatalog({ config: selected, access, context, fetchImpl: fetchFixture({ providers: [{
    id: "research", models: { approved: { variants: { low: {}, medium: {}, high: {}, max: {} } } },
  }] }) });
  assert.deepEqual(Object.keys(catalog.providers[0].models.approved.variants), ["low", "high", "max"]);
});


test("saved managed defaults survive reconstruction and stay isolated by user without credentials", async () => {
  const { mkdtemp, rm, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "scikeel-model-default-"));
  try {
    assert.equal(await readManagedDefaultModel({ root, userId: "admin" }), null);
    await saveManagedDefaultModel({ root, userId: "admin", model: "research/other" });
    await saveManagedDefaultModel({ root, userId: "student", model: "research/approved" });
    assert.equal(await readManagedDefaultModel({ root, userId: "admin" }), "research/other");
    assert.equal(await readManagedDefaultModel({ root, userId: "student" }), "research/approved");
    assert.deepEqual(JSON.parse(await readFile(join(root,"admin.json"),"utf8")), { model: "research/other" });
    await assert.rejects(saveManagedDefaultModel({ root, userId: "../foreign", model: "research/other" }));
  } finally { await rm(root, { recursive: true, force: true }); }
});
