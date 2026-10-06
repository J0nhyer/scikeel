import test from "node:test";
import assert from "node:assert/strict";
import { validateBrokerConfiguration, brokerProfile, waitManagedRuntime } from "../src/sandbox-control-plane.mjs";

const context = { userId: "a", instanceId: "user-a", generation: 1 };
test("gateway liveness cannot admit a cold or failed OpenCode runtime",async()=>{
  const access={url:"http://172.31.240.2:4790",token:"a".repeat(64)};let calls=0;
  await waitManagedRuntime(access,{directory:"/tenant/workspace",delayMs:1,timeoutMs:100,fetchImpl:async(url,options)=>{
    assert.equal(url,`${access.url}/session?directory=%2Ftenant%2Fworkspace`);assert.ok(options.headers.authorization.startsWith("Basic "));
    return {ok:++calls>1,json:async()=>([]),body:{cancel:async()=>{}}};
  }});
  assert.equal(calls,2);
  await assert.rejects(waitManagedRuntime(access,{delayMs:1,timeoutMs:10,fetchImpl:async()=>({ok:true,json:async()=>({ok:true})})}),/runtime unavailable/);
});
const config = { schema: 1, providers: { fixture: { baseUrl: "https://provider.example/v1", credential: "synthetic-upstream-secret", authMode: "bearer", enabledModels: ["approved"], routes: ["/v1/responses", "/v1/chat/completions"] } }, defaultProvider: "fixture", defaultModel: "approved", mirrorUrl: "http://127.0.0.1:3141" };
test("only a fixed administrator configuration can create broker destinations", () => {
  assert.equal(validateBrokerConfiguration(config), config);
  for (const patch of [{ defaultModel: "other" }, { mirrorUrl: "http://peer:3141" }, { unknown: "secret" },
    { providers: { fixture: { ...config.providers.fixture, baseUrl: "https://user:pass@provider.example/v1" } } }])
    assert.throws(() => validateBrokerConfiguration({ ...config, ...patch }));
});
test("the sandbox profile contains only scoped broker credentials and manual tool permissions", () => {
  const calls = [];
  const broker = { issue: (grant) => { calls.push(grant); return "a".repeat(64); } };
  const profile = brokerProfile({ config, broker, context, now: 1000 });
  assert.ok(!JSON.stringify(profile).includes("upstream-secret"));
  assert.equal(profile.permission.bash, "ask"); assert.equal(profile.permission.external_directory, "deny");
  assert.equal(profile.provider.fixture.options.baseURL, "http://172.31.240.1:4792/v1");
  assert.equal(calls[0].generation, 1); assert.ok(calls[0].expiresAt <= 901000);
});

test("fixed administrator HTTP providers remain compatible without accepting tenant URL overrides",()=>{
  const configured={...config,providers:{fixture:{...config.providers.fixture,baseUrl:"http://47.109.76.66:18001/v1"}}};
  assert.equal(validateBrokerConfiguration(configured),configured);
  for(const baseUrl of ["file:///etc/passwd","http://user:secret@provider.example/v1","http://provider.example/v1?override=peer"])
    assert.throws(()=>validateBrokerConfiguration({...config,providers:{fixture:{...config.providers.fixture,baseUrl}}}));
});

test("only the standard OpenCode provider can opt into the complete free catalog with official names", () => {
  const provider = { ...config.providers.fixture, baseUrl: "https://opencode.ai/zen/v1", catalog: "opencode-free",
    name: "OpenCode Zen", enabledModels: ["big-pickle"], modelNames: { "big-pickle": "Big Pickle" } };
  const free = { ...config, defaultProvider: "opencode", defaultModel: "big-pickle", providers: { opencode: provider } };
  assert.equal(validateBrokerConfiguration(free), free);
  for (const patch of [{ baseUrl: "https://foreign.invalid" }, { catalog: "all-models" },
    { modelNames: { paid: "Paid" } }, { modelNames: { "big-pickle": { secret: "private" } } }]) {
    assert.throws(() => validateBrokerConfiguration({ ...free, providers: { opencode: { ...provider, ...patch } } }));
  }
  assert.throws(() => validateBrokerConfiguration({ ...free, defaultProvider: "other", providers: { other: provider } }));
});


test("managed runtime whitelists exactly the current broker catalog without sharing mutable arrays", () => {
  const calls = [];
  const broker = { issue: grant => { calls.push(grant); return "a".repeat(64); } };
  const first = brokerProfile({ config, broker, context });
  assert.deepEqual(first.provider.fixture.whitelist, ["approved"]);
  assert.deepEqual(first.provider.fixture.whitelist, Object.keys(first.provider.fixture.models));
  assert.notEqual(first.provider.fixture.whitelist, config.providers.fixture.enabledModels);
  const refreshed = { ...config, defaultModel: "other", providers: { fixture: {
    ...config.providers.fixture, enabledModels: ["other", "approved"],
  } } };
  const next = brokerProfile({ config: refreshed, broker, context });
  assert.deepEqual(next.provider.fixture.whitelist, ["other", "approved"]);
  assert.equal(next.model, "fixture/other");
  assert.deepEqual(calls[1].models, next.provider.fixture.whitelist);
  assert.deepEqual(first.provider.fixture.whitelist, ["approved"]);
});


test("declared reasoning levels reach the runtime without changing models or permissions", () => {
  const configured = { ...config, providers: { fixture: { ...config.providers.fixture, modelVariants: { approved: ["low", "high", "max"] } } } };
  const profile = brokerProfile({ config: configured, broker: { issue: () => "a".repeat(64) }, context });
  assert.deepEqual(profile.provider.fixture.models.approved, { name: "approved", reasoning: true,
    variants: { low: { reasoningEffort: "low" }, high: { reasoningEffort: "high" }, max: { reasoningEffort: "max" } } });
  assert.deepEqual(profile.provider.fixture.whitelist, ["approved"]);
  assert.equal(profile.permission.bash, "ask");
  for (const modelVariants of [{ unknown: ["high"] }, { approved: ["high", "high"] }, { approved: ["invented"] },
    { approved: [] }, { approved: { apiKey: "secret" } }, []])
    assert.throws(() => validateBrokerConfiguration({ ...configured, providers: { fixture: { ...configured.providers.fixture, modelVariants } } }));
});
