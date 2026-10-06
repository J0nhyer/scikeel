import test from "node:test";
import assert from "node:assert/strict";
import { readManagedModelCatalog } from "../src/managed-model-catalog.mjs";

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
