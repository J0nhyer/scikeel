import test from "node:test";
import assert from "node:assert/strict";
import { resolveOpenCodeFreeCatalog } from "../src/opencode-free-catalog.mjs";

const config = { defaultProvider: "opencode", defaultModel: "big-pickle", providers: {
  opencode: { baseUrl: "https://opencode.ai/zen/v1", catalog: "opencode-free", enabledModels: ["big-pickle", "mimo-v2.6-flash-free", "ling-3.1-flash-free", "deprecated-free"], credential: "public" },
} };
const metadata = { opencode: { name: "OpenCode Zen", models: {
  "big-pickle": { name: "Big Pickle", cost: { input: 0, output: 0 } },
  "mimo-v2.6-flash-free": { name: "MiMo-V2.6-Flash Free", cost: { input: 0, output: 0 } },
  "ling-3.1-flash-free": { name: "Ling 3.1 Flash Free", cost: { input: 0, output: 0 } },
  "paid-free": { name: "Paid model", cost: { input: 1, output: 2 } },
  "deprecated-free": { name: "Deprecated Free", cost: { input: 0, output: 0 }, status: "deprecated" },
  "retired-free": { name: "Retired model", cost: { input: 0, output: 0 } },
} } };
const serving = { data: ["big-pickle", "mimo-v2.6-flash-free", "ling-3.1-flash-free", "paid-free", "deprecated-free", "unknown-free"].map(id => ({ id })) };
function fetchFixture({ catalog = metadata, served = serving } = {}) {
  return async (url, options) => {
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.authorization, undefined);
    assert.ok(options.signal);
    return new Response(JSON.stringify(url === "https://models.dev/api.json" ? catalog : served));
  };
}
test("enriches the administrator-selected free catalog and preserves official model names and case", async () => {
  const resolved = await resolveOpenCodeFreeCatalog(config, { fetchImpl: fetchFixture() });
  assert.deepEqual(resolved.providers.opencode.enabledModels, ["big-pickle", "mimo-v2.6-flash-free", "ling-3.1-flash-free"]);
  assert.deepEqual(resolved.providers.opencode.modelNames, {
    "big-pickle": "Big Pickle", "mimo-v2.6-flash-free": "MiMo-V2.6-Flash Free", "ling-3.1-flash-free": "Ling 3.1 Flash Free",
  });
  assert.equal(resolved.providers.opencode.name, "OpenCode Zen");
  assert.deepEqual(config.providers.opencode.enabledModels, ["big-pickle", "mimo-v2.6-flash-free", "ling-3.1-flash-free", "deprecated-free"]);
});
test("discovery retains the saved catalog on failure instead of deleting all models", async () => {
  for (const fetchImpl of [async () => { throw new Error("offline"); }, fetchFixture({ served: { data: [] } }),
    fetchFixture({ catalog: {} }), async () => new Response("denied", { status: 403 })]) {
    assert.equal(await resolveOpenCodeFreeCatalog(config, { fetchImpl }), config);
  }
});
test("only the administrator-selected standard OpenCode free provider performs discovery", async () => {
  for (const value of [{ ...config, defaultProvider: "other" }, { ...config, providers: { opencode: { ...config.providers.opencode, catalog: undefined } } },
    { ...config, providers: { opencode: { ...config.providers.opencode, baseUrl: "https://other.invalid" } } }]) {
    assert.equal(await resolveOpenCodeFreeCatalog(value, { fetchImpl: () => { assert.fail("must not contact a different endpoint"); } }), value);
  }
});

test("administrator selections cannot be broadened by a serving listing", async () => {
  const selected = { ...config, providers: { opencode: { ...config.providers.opencode, enabledModels: ["big-pickle", "mimo-v2.6-flash-free"] } } };
  const resolved = await resolveOpenCodeFreeCatalog(selected, { fetchImpl: fetchFixture() });
  assert.deepEqual(resolved.providers.opencode.enabledModels, ["big-pickle", "mimo-v2.6-flash-free"]);
  const offline = await resolveOpenCodeFreeCatalog(selected, { fetchImpl: async () => { throw new Error("offline"); } });
  assert.equal(offline, selected);
});
