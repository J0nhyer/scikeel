import test from "node:test";
import assert from "node:assert/strict";
import { TenantRunner, TenantGateway } from "../../../runtime/sandbox/runner.mjs";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const manifest = { schema: 1, instanceId: "user-a", generation: 1, workspaceDir: "/tenant/workspace", stateDir: "/tenant/state", home: "/tenant/home", scratchDir: "/tenant/scratch" };
const token = "a".repeat(64);
test("runner listens on the assigned alternate address used by production acceptance", async (t) => {
  const runner = new TenantRunner({manifest,token});t.after(()=>runner.close());
  await runner.listen({host:"127.0.0.2",port:0});
  const response=await fetch(`http://127.0.0.2:${runner.server.address().port}/health`);
  assert.equal(response.status,200);
});
test("runner authenticates fixed workspace RPC before dispatch and rejects foreign generations", async (t) => {
  const calls = [];
  const runner = new TenantRunner({ manifest, token, files: { call: async (request) => { calls.push(request); return { text: "owned" }; } } });
  await runner.listen({ host: "127.0.0.1", port: 0 }); t.after(() => runner.close());
  const url = `http://127.0.0.1:${runner.server.address().port}`;
  const post = (body, credential = token, path = "/files") => fetch(`${url}${path}`, { method: "POST", headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const request = { instanceId: "user-a", generation: 1, operation: "read", root: "workspace", path: "a" };
  assert.equal((await post(request, "b".repeat(64))).status, 403); assert.equal(calls.length, 0);
  assert.equal((await post({ ...request, generation: 2 })).status, 403);
  assert.equal((await post({ ...request, instanceId: "user-b" })).status, 403);
  assert.equal((await post(request, token, "/exec")).status, 404);
  assert.equal((await post({ ...request, path: "../peer" })).status, 403);
  const result = await post(request); assert.equal(result.status, 200); assert.deepEqual(await result.json(), { text: "owned" });
  assert.deepEqual(calls, [{ operation: "read", root: "workspace", path: "a" }]);
});
test("runner enforces one operation and exposes no helper error contents", async (t) => {
  let finish; let entered;
  const pending = new Promise((resolve) => entered = resolve);
  const runner = new TenantRunner({ manifest, token, files: { call: async () => { entered(); await new Promise((resolve) => finish = resolve); throw new Error("administrator-secret-canary"); } } });
  await runner.listen({ host: "127.0.0.1", port: 0 }); t.after(() => runner.close());
  const post = () => fetch(`http://127.0.0.1:${runner.server.address().port}/files`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ instanceId: "user-a", generation: 1, operation: "read", root: "workspace", path: "a" }) });
  const first = post(); await pending; assert.equal((await post()).status, 429);
  finish(); const result = await first; assert.equal(result.status, 403); assert.ok(!(await result.text()).includes("secret-canary"));
});
test("profile updates accept only platform broker credentials and manual permissions", async (t) => {
  const profiles = [];
  const runner = new TenantRunner({ manifest, token, configureProfile: async (profile) => profiles.push(profile) });
  await runner.listen({ host: "127.0.0.1", port: 0 }); t.after(() => runner.close());
  const profile = { model: "fixture/approved", enabled_providers: ["fixture"], provider: { fixture: {
    npm: "@ai-sdk/openai-compatible", name: "fixture", whitelist: ["approved"], models: { approved: { name: "approved" } },
    options: { baseURL: "http://172.31.240.1:4792/v1", apiKey: "b".repeat(64) } } },
    permission: { bash: "ask", edit: "ask", external_directory: "deny", webfetch: "ask", websearch: "ask" } };
  const post = (value) => fetch(`http://127.0.0.1:${runner.server.address().port}/profile`, { method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ instanceId: "user-a", generation: 1, profile: value }) });
  assert.equal((await post({ ...profile, permission: { bash: "allow" } })).status, 403);
  const foreign = structuredClone(profile); foreign.provider.fixture.options.baseURL = "http://peer/v1";
  assert.equal((await post(foreign)).status, 403);
  assert.equal((await post({ ...profile, skills: { paths: ["/peer/skills"] } })).status, 403);
  for (const whitelist of [undefined, [], ["other"], ["approved", "approved"], "approved", ["approved", "other"]]) {
    const invalid = structuredClone(profile);
    if (whitelist === undefined) delete invalid.provider.fixture.whitelist;
    else invalid.provider.fixture.whitelist = whitelist;
    assert.equal((await post(invalid)).status, 403);
  }
  assert.equal((await post(profile)).status, 200); assert.deepEqual(profiles, [profile]);
  const reasoning = structuredClone(profile);
  reasoning.provider.fixture.models.approved = { name: "approved", reasoning: true,
    variants: { low: { reasoningEffort: "low" }, high: { reasoningEffort: "high" }, max: { reasoningEffort: "max" } } };
  assert.equal((await post(reasoning)).status, 200);
  assert.deepEqual(profiles[1], reasoning);
  for (const variant of [{ reasoningEffort: "low", baseURL: "http://peer" }, { reasoningEffort: "high" },
    { apiKey: "foreign" }, { reasoningEffort: "low", disabled: false }, null, []]) {
    const invalid = structuredClone(reasoning); invalid.provider.fixture.models.approved.variants.low = variant;
    assert.equal((await post(invalid)).status, 403);
  }
  for (const entry of [{ name: "approved", reasoning: true, variants: { invented: { reasoningEffort: "invented" } } },
    { name: "approved", reasoning: false, variants: reasoning.provider.fixture.models.approved.variants },
    { name: "approved", options: { baseURL: "http://peer" } }, null]) {
    const invalid = structuredClone(profile); invalid.provider.fixture.models.approved = entry;
    assert.equal((await post(invalid)).status, 403);
  }
});
test("gateway configuration is published before startup and restart preserves private state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "scikeel-gateway-")); t.after(() => rm(root, { recursive: true, force: true }));
  const config = { ...manifest, workspaceDir: `${root}/workspace`, stateDir: `${root}/state`, home: `${root}/home`, scratchDir: `${root}/scratch` };
  for (const key of ["workspaceDir", "stateDir", "home", "scratchDir"]) await mkdir(config[key]);
  const socket = createServer(); await new Promise((done) => socket.listen(0, "127.0.0.1", done)); const port = socket.address().port;
  await new Promise((done) => socket.close(done));
  const gateway = new TenantGateway({ manifest: config, token, address: "127.0.0.1", port, spawnImpl: (_command, _args, options) => {
    assert.equal(options.env.SCIKEEL_SESSION_TITLE_POLICY, "conversation-v1");
    return spawn(process.execPath, [fileURLToPath(new URL("../fixtures/sandbox-gateway.mjs", import.meta.url))], { ...options, env: { ...options.env, FIXTURE_PORT: String(port) } }); } });
  t.after(() => gateway.stop());
  const profile = { model: "fixture/one", permission: { bash: "ask", edit: "ask", external_directory: "deny", webfetch: "ask", websearch: "ask" } };
  await gateway.start(profile);
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/v1/health`)).json()).model, "fixture/one");
  const published = JSON.parse(await readFile(`${config.stateDir}/runtime/xdg-config/opencode/opencode.json`, "utf8"));
  const skills = "/opt/scikeel/tools/resources/skills-core";
  assert.deepEqual(published.skills, { paths: [skills] });
  assert.deepEqual(published.permission.external_directory, { "*": "deny", [skills]: "allow", [`${skills}/*`]: "allow" });
  assert.equal(published.permission.bash, "ask");
  assert.equal(published.permission.edit, "ask");
  assert.equal(Object.keys(published.permission.external_directory)[0], "*");

  const brokerToken = "b".repeat(64);
  const imageDigest = "sha256:" + "c".repeat(64);
  await gateway.start({ ...profile, model: "fixture/two", enabled_providers: ["fixture"], provider: { fixture: {
    npm: "@ai-sdk/openai-compatible", name: "fixture", models: { two: { name: "two" } },
    options: { baseURL: "http://172.31.240.1:4792/v1", apiKey: brokerToken },
  } } }, { imageDigest });
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/v1/health`)).json()).model, "fixture/two");
  const restarted = JSON.parse(await readFile(`${config.stateDir}/runtime/xdg-config/opencode/opencode.json`, "utf8"));
  assert.deepEqual(restarted.skills, { paths: [skills] });
  assert.deepEqual(restarted.plugin, [["file:///opt/scikeel/tools/science-environment.mjs", { imageDigest, collaborationToken: brokerToken }]]);
  assert.deepEqual(restarted.permission, published.permission);
  await gateway.stop();
});
test("runner health reports an unavailable gateway rather than admitting new jobs after its child exits",async(t)=>{
  let healthy=true;const runner=new TenantRunner({manifest,token,healthy:()=>healthy});
  await runner.listen({host:"127.0.0.1",port:0});t.after(()=>runner.close());
  const url=`http://127.0.0.1:${runner.server.address().port}/health`;
  assert.equal((await fetch(url)).status,200);healthy=false;
  const response=await fetch(url);assert.equal(response.status,503);assert.deepEqual(await response.json(),{ready:false});
});
