import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "smol-toml";
import { createServer } from "node:http";
import * as profiles from "../src/cli-profile.mjs";
import { ModelBroker } from "../src/model-broker.mjs";
import { AssistantPolicy } from "../src/assistant-policy.mjs";
import { brokerProfile } from "../src/sandbox-control-plane.mjs";
import * as controlPlane from "../src/sandbox-control-plane.mjs";

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

test("explicit host synchronization selects the configured model without importing the whole catalog", async t => {
  const input = await fixture(t);
  const service = new profiles.ManagedCodexProfile({ home: input.home, environment: input.environment });
  const before = await service.initializeFromSource({ codexHome: input.source });
  assert.deepEqual(before.models.map(model => model.id), ["gpt-6.1-sol"]);
  input.config.model = "fixture-next-model:preview";
  const catalog = JSON.parse(await fs.readFile(input.catalog, "utf8"));
  catalog.models.push({ ...catalog.models[0], slug: input.config.model, display_name: "Next Approved Model" });
  await fs.writeFile(input.catalog, JSON.stringify(catalog));
  await fs.writeFile(join(input.source, "config.toml"), stringify(input.config));
  assert.deepEqual(await service.refresh("codex"), before, "Host changes alone cannot change service authority");
  const after = await service.synchronizeFromSource({ codexHome: input.source, expectedRevision: before.sourceRevision });
  assert.equal(after.defaultModel, input.config.model);
  assert.deepEqual(after.models.map(model => model.id), [input.config.model]);
  assert.notEqual(after.identityRevision, before.identityRevision);
  assert.notEqual(after.catalogRevision, before.catalogRevision);
  assert.deepEqual((await service.resolveProvider(after.identityRevision)).enabledModels, [input.config.model]);
  await assert.rejects(service.resolveProvider(before.identityRevision), { code: "profile_revision_conflict" });
  assert.deepEqual(await new profiles.ManagedCodexProfile({ home: input.home }).refresh("codex"), after);
  await assert.rejects(service.synchronizeFromSource({ codexHome: input.source, expectedRevision: before.sourceRevision }),
    { code: "profile_revision_conflict" });
});

test("invalid or ambiguous newly selected models leave the committed service profile untouched", async t => {
  const input = await fixture(t);
  const service = new profiles.ManagedCodexProfile({ home: input.home, environment: input.environment });
  const before = await service.initializeFromSource({ codexHome: input.source });
  for (const id of ["missing-model", "has whitespace", "", "x".repeat(161)]) {
    input.config.model = id;
    await fs.writeFile(join(input.source, "config.toml"), stringify(input.config));
    await assert.rejects(service.synchronizeFromSource({ codexHome: input.source, expectedRevision: before.sourceRevision }),
      { code: "service_profile_unavailable" });
    assert.deepEqual(await service.refresh("codex"), before);
  }
  input.config.model = "ambiguous-model";
  await fs.writeFile(join(input.source, "config.toml"), stringify(input.config));
  const original = JSON.parse(await fs.readFile(input.catalog, "utf8")).models[0];
  await fs.writeFile(input.catalog, JSON.stringify({ models: [original, { ...original, slug: input.config.model },
    { ...original, slug: input.config.model }] }));
  await assert.rejects(service.synchronizeFromSource({ codexHome: input.source, expectedRevision: before.sourceRevision }),
    { code: "service_profile_unavailable" });
  assert.deepEqual(await service.refresh("codex"), before);
});

test("native service grants use only the private provider and exact execution, with sanitized tenant configuration",async t=>{
  const input=await fixture(t);let contacts=0;
  const upstream=createServer((request,response)=>{
    contacts++;assert.equal(request.headers.authorization,'Bearer synthetic-service-upstream-key');
    response.writeHead(200,{'content-type':'application/json'});response.end('{}');
  });
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  t.after(()=>{upstream.closeAllConnections();return new Promise(resolve=>upstream.close(resolve));});
  input.config.model_providers.fixture.base_url=`http://127.0.0.1:${upstream.address().port}/v1`;
  await fs.writeFile(join(input.source,'config.toml'),stringify(input.config));
  const sourceBytes=await fs.readFile(join(input.source,'config.toml'));
  const service=resolver(input);await service.initializeFromSource({codexHome:input.source});
  service.copyForTurn=()=>assert.fail('Managed issuance cannot copy a host profile');
  const context={userId:'native_owner',instanceId:'user-native_owner',generation:1};
  const turnIdentity={...context,conversationId:'owned_conversation',execution:1,requestId:'owned_request',policyRevision:1,runtime:'codex'};
  const policy=new AssistantPolicy({state:{schema:1,activeRuntime:'codex',revision:1,transition:null,receipts:[],executions:{}},
    persist:async()=>{},prepare:async()=>{},revoke:async()=>{},inventory:async()=>({activeExecutions:[],uncertainEffects:[]})});
  await policy.init();const lease=await policy.admit(turnIdentity,async()=>({}));
  const broker=new ModelBroker({providers:{},identify:()=>context,logger:()=>{},assistantPolicy:()=>policy.committedSnapshot(),
    executionAuthority:identity=>policy.isExecutionCurrent(identity)});
  t.after(()=>broker.close());await broker.listen({host:'127.0.0.1',port:0});
  const managed=controlPlane.managedNativeProfileResolver({configuration:{enabledRuntimes:['codex']},serviceProfile:service,broker});
  const profile=await managed.refresh('codex');assert.equal(typeof managed.issueNativeGrant,'function');
  const request={context,turnIdentity,model:'gpt-6.1-sol',variant:'high',identityRevision:profile.identityRevision};
  for(const patch of [{model:'unapproved-model'},{variant:'other'},{identityRevision:'stale'},
    {turnIdentity:{...turnIdentity,execution:2}}])await assert.rejects(managed.issueNativeGrant({...request,...patch}));
  const grant=await managed.issueNativeGrant(request),config=grant.configuration;
  assert.deepEqual(Object.keys(config).sort(),['effort','model','modelToken','modelUrl']);
  assert.equal(config.model,'gpt-6.1-sol');assert.equal(config.effort,'high');
  assert.equal(config.modelUrl,'http://172.31.240.1:4792/v1');assert.match(config.modelToken,/^[a-f0-9]{64}$/);
  for(const forbidden of ['synthetic-service','unused-host-auth','HOST_',input.source,'auth.json','plugins','mcp_servers'])
    assert(!JSON.stringify(config).includes(forbidden));
  const call=()=>fetch(`http://127.0.0.1:${broker.server.address().port}/v1/responses`,{method:'POST',headers:{
    'content-type':'application/json',authorization:`Bearer ${config.modelToken}`},body:JSON.stringify({model:config.model,input:'synthetic'})});
  const accepted=await call();assert.equal(accepted.status,200);await accepted.text();assert.equal(contacts,1);
  assert(Number.isSafeInteger(grant.renew()));await lease.settle({cleanupVerified:true});
  assert.throws(()=>grant.renew());const denied=await call();assert.equal(denied.status,403);await denied.text();
  await grant.revoke();assert.equal(contacts,1);
  assert.deepEqual(await fs.readFile(join(input.source,'config.toml')),sourceBytes);
});

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

test("the imported private service connection reaches a real broker through a sanitized revision-bound tenant profile", async t => {
  const input = await fixture(t), service = resolver(input);
  const received = [];
  const upstream = createServer((request, response) => {
    received.push({ route: request.url, authorization: request.headers.authorization });
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"fixture":"ok"}');
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => { upstream.closeAllConnections(); return new Promise(resolve => upstream.close(resolve)); });
  const endpoint = `http://127.0.0.1:${upstream.address().port}/v1`;
  input.config.model_providers.fixture.base_url = endpoint;
  await fs.writeFile(join(input.source, "config.toml"), stringify(input.config));
  await service.initializeFromSource({ codexHome: input.source });
  const profile = await service.refresh("codex");
  const provider = await service.resolveProvider(profile.identityRevision);
  const context = { userId: "owner", instanceId: "user-owner", generation: 3 };
  const logs = [];
  const broker = new ModelBroker({ providers: {}, identify: () => context, logger: event => logs.push(event) });
  t.after(() => broker.close());
  broker.replaceProviderSnapshot({ name: "codex", expectedRevision: null, identityRevision: profile.identityRevision, provider });
  await broker.listen({ host: "127.0.0.1", port: 0 });
  const config = { schema: 1, providers: { codex: provider }, defaultProvider: "codex", defaultModel: "gpt-6.1-sol",
    mirrorUrl: "http://127.0.0.1:3141" };
  const tenant = brokerProfile({ config, broker, context, profileRevision: profile.identityRevision });
  const serialized = JSON.stringify(tenant);
  assert.equal(tenant.provider.codex.options.baseURL, "http://172.31.240.1:4792/v1");
  assert.deepEqual(tenant.provider.codex.whitelist, ["gpt-6.1-sol"]);
  assert.match(tenant.provider.codex.options.apiKey, /^[a-f0-9]{64}$/);
  for (const forbidden of [endpoint, input.source, "synthetic-service-upstream-key", "unused-host-auth-key", "HOST_", "unapproved-model"])
    assert(!serialized.includes(forbidden), "Only the scoped broker token may reach the tenant");
  const send = model => globalThis.fetch(`http://127.0.0.1:${broker.server.address().port}/v1/responses`, {
    method: "POST", headers: { authorization: `Bearer ${tenant.provider.codex.options.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model, input: "synthetic", max_output_tokens: 1 }), signal: AbortSignal.timeout(2000) });
  const allowed = await send("gpt-6.1-sol");
  assert.equal(allowed.status, 200); await allowed.text();
  const denied = await send("unapproved-model");
  assert.equal(denied.status, 403); await denied.text();
  assert.deepEqual(received, [{ route: "/v1/responses", authorization: "Bearer synthetic-service-upstream-key" }]);
  assert(logs.some(event => event.upstreamStatus === 200));
  for (const forbidden of [endpoint, input.source, "synthetic-service-upstream-key", "unused-host-auth-key", "HOST_"])
    assert(!JSON.stringify(logs).includes(forbidden));
});

test("managed Codex rejects hardlinked credentials and a symlinked service ancestor", async t => {
  const input = await fixture(t), service = resolver(input);
  await service.initializeFromSource({ codexHome: input.source });
  const link = join(input.root, "credential-hardlink");
  await fs.link(join(input.home, "service-profile.json"), link);
  await assert.rejects(service.refresh("codex"), { code: "unsafe_service_profile" });
  await fs.unlink(link);
  assert.equal((await service.refresh("codex")).status, "ready");
  const alias = join(input.root, "platform-alias");
  await fs.symlink(join(input.root, "platform"), alias);
  const throughAlias = resolver({ ...input, home: join(alias, "new-service") });
  await assert.rejects(throughAlias.initializeFromSource({ codexHome: input.source }), { code: "unsafe_service_profile" });
  await assert.rejects(fs.lstat(join(input.root, "platform", "new-service")), { code: "ENOENT" });
});

test("managed Codex rejects a symlinked source catalog and a non-regular source configuration", async t => {
  const input = await fixture(t), service = resolver(input);
  const catalog = join(input.root, "actual-catalog.json");
  await fs.rename(input.catalog, catalog);
  await fs.symlink(catalog, input.catalog);
  await assert.rejects(service.initializeFromSource({ codexHome: input.source }), { code: "service_profile_unavailable" });
  assert.deepEqual(await fs.readdir(input.home), []);
  await fs.unlink(input.catalog);
  await fs.rename(catalog, input.catalog);
  const config = join(input.source, "config.toml");
  await fs.unlink(config);
  await fs.mkdir(config);
  await assert.rejects(service.initializeFromSource({ codexHome: input.source }), { code: "unsafe_service_profile" });
  assert.deepEqual(await fs.readdir(input.home), []);
});

test("managed Codex failed explicit synchronization preserves the previous coherent service snapshot", async t => {
  const input = await fixture(t), service = resolver(input);
  await service.initializeFromSource({ codexHome: input.source });
  const before = await service.refresh("codex");
  const saved = await fs.readFile(join(input.home, "service-profile.json"), "utf8");
  await fs.writeFile(join(input.source, "config.toml"), "model = [unfinished");
  await assert.rejects(service.synchronizeFromSource({ codexHome: input.source, expectedRevision: before.sourceRevision }),
    { code: "service_profile_unavailable" });
  assert.equal(await fs.readFile(join(input.home, "service-profile.json"), "utf8"), saved);
  assert.equal((await service.refresh("codex")).identityRevision, before.identityRevision);
  assert.equal((await service.resolveProvider(before.identityRevision)).credential, "synthetic-service-upstream-key");
  const lock = join(input.home, ".sync-lock");
  await fs.writeFile(lock, "unknown prior synchronization", { mode: 0o600 });
  await assert.rejects(service.synchronizeFromSource({ codexHome: input.source, expectedRevision: before.sourceRevision }),
    { code: "service_profile_busy" });
  assert.equal(await fs.readFile(lock, "utf8"), "unknown prior synchronization");
  assert.equal(await fs.readFile(join(input.home, "service-profile.json"), "utf8"), saved);
});

test("the managed control-plane resolver binds the private service provider, never the infrastructure provider", async t => {
  const input = await fixture(t), service = resolver(input);
  await service.initializeFromSource({ codexHome: input.source });
  const context = { userId: "profile_owner", instanceId: "profile_instance", generation: 1 };
  const broker = new ModelBroker({ providers: { infrastructure: { baseUrl: "https://infrastructure.invalid/v1",
    credential: "synthetic-infrastructure-only-key", authMode: "bearer", enabledModels: ["helper-model"], routes: ["/v1/responses"] } },
    identify: () => context, logger: () => {} });
  t.after(() => broker.close());
  assert.equal(typeof controlPlane.managedNativeProfileResolver, "function", "The startup service-profile resolver is missing");
  const managed = controlPlane.managedNativeProfileResolver({ configuration: { enabledRuntimes: ["opencode", "codex"] },
    serviceProfile: service, broker });
  const [first, concurrent] = await Promise.all([managed.refresh("codex"), managed.refresh("codex")]);
  assert.equal(first.status, "ready");
  assert.equal(first.identityRevision, concurrent.identityRevision);
  assert.deepEqual(first.models.map(model => model.id), ["gpt-6.1-sol"]);
  const capability = { ...context, provider: "scikeel-codex", profileRevision: first.identityRevision,
    models: ["gpt-6.1-sol"], routes: ["/v1/responses"], expiresAt: Date.now() + 60000 };
  const old = broker.issue(capability);
  assert.throws(() => broker.issue({ ...capability, models: ["helper-model"] }), { code: "model_grant_denied" });
  assert.match(broker.issue({ ...capability, provider: "infrastructure", profileRevision: undefined, models: ["helper-model"] }), /^[a-f0-9]{64}$/);
  input.config.model_providers.fixture.base_url = "http://203.0.113.26:18001/v1";
  await fs.writeFile(join(input.source, "config.toml"), stringify(input.config));
  assert.equal((await managed.refresh("codex")).identityRevision, first.identityRevision, "Startup refresh cannot synchronize the personal source");
  await service.synchronizeFromSource({ codexHome: input.source, expectedRevision: first.sourceRevision });
  const next = await managed.refresh("codex");
  assert.notEqual(next.identityRevision, first.identityRevision);
  assert.throws(() => broker.renew(old, context), { code: "model_grant_denied" });
  assert.match(broker.issue({ ...capability, profileRevision: next.identityRevision }), /^[a-f0-9]{64}$/);
  const currentToken = broker.issue({ ...capability, profileRevision: next.identityRevision });
  const profilePath = join(input.home, "service-profile.json"), coherent = await fs.readFile(profilePath, "utf8");
  await fs.writeFile(profilePath, "invalid partial service state");
  await assert.rejects(managed.refresh("codex"), { code: "unsafe_service_profile" });
  assert.throws(() => broker.renew(currentToken, context), { code: "model_grant_denied" });
  assert.throws(() => broker.issue({ ...capability, profileRevision: next.identityRevision }), { code: "model_grant_denied" });
  await fs.writeFile(profilePath, coherent);
  assert.equal((await managed.refresh("codex")).identityRevision, next.identityRevision);
  assert.throws(() => broker.renew(currentToken, context), { code: "model_grant_denied" }, "Recovery cannot revive old grants");
  assert.match(broker.issue({ ...capability, profileRevision: next.identityRevision }), /^[a-f0-9]{64}$/);
  for (const forbidden of [input.source, "203.0.113", "synthetic-", "HOST_"])
    assert(!JSON.stringify(first).includes(forbidden));
  assert.equal(managed.copyForTurn, undefined);
});

test("a missing image capability or unavailable service never discovers the personal profile or advertises Codex", async t => {
  const input = await fixture(t), service = resolver(input);
  assert.equal(typeof controlPlane.managedNativeProfileResolver, "function", "The startup service-profile resolver is missing");
  const broker = { replaceProviderSnapshot() { throw Error("Unavailable profiles cannot register an inference route"); } };
  const hidden = controlPlane.managedNativeProfileResolver({ configuration: { enabledRuntimes: ["opencode"] }, broker,
    serviceProfile: { refresh() { throw Error("An unmeasured image cannot discover a provider"); } } });
  assert.equal((await hidden.refresh("codex")).status, "unavailable");
  assert.equal((await hidden.refresh("claude")).status, "unavailable");
  const missing = controlPlane.managedNativeProfileResolver({ configuration: { enabledRuntimes: ["codex"] }, broker, serviceProfile: service });
  assert.equal((await missing.refresh("codex")).status, "unavailable");
  await assert.rejects(fs.lstat(input.home), { code: "ENOENT" });
  await assert.rejects(missing.refresh("not-a-runtime"), { code: "invalid_runtime" });
});

test("private service registration never replaces a colliding infrastructure provider or revokes its grants", async t => {
  const input = await fixture(t), service = resolver(input);
  await service.initializeFromSource({ codexHome: input.source });
  const context = { userId: "profile_owner", instanceId: "profile_instance", generation: 1 };
  const broker = new ModelBroker({ providers: { "scikeel-codex": { baseUrl: "https://infrastructure.invalid/v1",
    credential: "synthetic-infrastructure-key", authMode: "bearer", enabledModels: ["helper-model"], routes: ["/v1/responses"] } },
    identify: () => context, logger: () => {} });
  t.after(() => broker.close());
  const token = broker.issue({ ...context, provider: "scikeel-codex", models: ["helper-model"], routes: ["/v1/responses"], expiresAt: Date.now() + 60000 });
  const managed = controlPlane.managedNativeProfileResolver({ configuration: { enabledRuntimes: ["codex"] }, serviceProfile: service, broker });
  await assert.rejects(managed.refresh("codex"), { code: "model_profile_revision_conflict" });
  assert(broker.renew(token, context) > Date.now(), "A failed private registration cannot change infrastructure grants");
});
