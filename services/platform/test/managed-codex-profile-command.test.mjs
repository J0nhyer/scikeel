import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";

const command = new URL("../src/managed-codex-profile-command.mjs", import.meta.url);
async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), "scikeel-service-command-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = join(root, "personal"), dataDir = join(root, "platform");
  await fs.mkdir(source, { mode: 0o700 }); await fs.mkdir(dataDir, { mode: 0o700 });
  const catalog = join(source, "catalog.json");
  await fs.writeFile(catalog, JSON.stringify({ models: [{ slug: "gpt-6.1-sol", display_name: "Allowed model",
    input_modalities: ["text"], supported_reasoning_levels: [], base_instructions: "DO_NOT_IMPORT_SOURCE_INSTRUCTIONS" }] }), { mode: 0o600 });
  await fs.writeFile(join(source, "config.toml"), stringify({ model: "gpt-6.1-sol", model_provider: "fixture", model_catalog_json: catalog,
    model_providers: { fixture: { base_url: "http://203.0.113.31:18001/v1", wire_api: "responses" } } }), { mode: 0o600 });
  await fs.writeFile(join(source, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "synthetic-command-private-key" }), { mode: 0o600 });
  const run = (...args) => spawnSync(process.execPath, [command.pathname, ...args], { encoding: "utf8", timeout: 10000,
    env: { PATH: process.env.PATH, HOME: root, LANG: "C.UTF-8" } });
  return { source, dataDir, run };
}

test("the operator initializes and explicitly synchronizes one service home without exposing private source data", async t => {
  const f = await fixture(t), args = ["--data-dir", f.dataDir, "--source", f.source];
  const before = await fs.readFile(join(f.source, "config.toml"), "utf8");
  const first = f.run("initialize", ...args);
  assert.equal(first.status, 0, "The controlled profile command must support initialization");
  const receipt = JSON.parse(first.stdout);
  assert.equal(receipt.status, "ready"); assert.deepEqual(receipt.models, ["gpt-6.1-sol"]);
  assert.match(receipt.sourceRevision, /^[a-f0-9-]{36}$/);
  const saved = await fs.readFile(join(f.dataDir, "codex-service", "service-profile.json"), "utf8");
  assert.equal((await fs.stat(join(f.dataDir, "codex-service"))).mode & 0o777, 0o700);
  assert.equal((await fs.stat(join(f.dataDir, "codex-service", "service-profile.json"))).mode & 0o777, 0o600);
  const repeated = f.run("initialize", ...args);
  assert.notEqual(repeated.status, 0);
  assert.equal(await fs.readFile(join(f.dataDir, "codex-service", "service-profile.json"), "utf8"), saved);
  const missingRevision = f.run("synchronize", ...args);
  assert.notEqual(missingRevision.status, 0);
  const conflict = f.run("synchronize", ...args, "--expected-revision", "not-current");
  assert.notEqual(conflict.status, 0);
  assert.equal(await fs.readFile(join(f.dataDir, "codex-service", "service-profile.json"), "utf8"), saved);
  const synced = f.run("synchronize", ...args, "--expected-revision", receipt.sourceRevision);
  assert.equal(synced.status, 0); assert.notEqual(JSON.parse(synced.stdout).sourceRevision, receipt.sourceRevision);
  assert.equal(await fs.readFile(join(f.source, "config.toml"), "utf8"), before);
  for (const result of [first, repeated, missingRevision, conflict, synced])
    for (const secret of [f.source, f.dataDir, "203.0.113.31", "synthetic-command-private-key", "DO_NOT_IMPORT"])
      assert(!(result.stdout + result.stderr).includes(secret), "Operator output must not disclose private source data");
});

test("the operator rejects overlapping personal/service roots and unexpected options without modifying either root", async t => {
  const f = await fixture(t);
  for (const args of [["initialize", "--data-dir", f.source, "--source", f.source],
    ["initialize", "--data-dir", f.dataDir, "--source", join(f.dataDir, "tenant")],
    ["initialize", "--data-dir", f.dataDir, "--source", f.source, "--api-key", "synthetic-forbidden-argument"]]) {
    const result = f.run(...args);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /invalid_service_profile_operation/);
    assert(!result.stderr.includes("synthetic-forbidden-argument"));
    assert(!result.stderr.includes(f.source));
  }
  assert.deepEqual(await fs.readdir(f.dataDir), []);
  assert.deepEqual((await fs.readdir(f.source)).sort(), ["auth.json", "catalog.json", "config.toml"]);
});

test("the same operator command synchronizes a replacement host model without code or tenant changes", async t => {
  const f = await fixture(t), args = ["--data-dir", f.dataDir, "--source", f.source];
  const first = f.run("initialize", ...args); assert.equal(first.status, 0);
  const receipt = JSON.parse(first.stdout), path = join(f.source, "config.toml");
  const config = parse(await fs.readFile(path, "utf8")); config.model = "fixture-replacement-model";
  const catalog = JSON.parse(await fs.readFile(config.model_catalog_json, "utf8"));
  catalog.models.push({ ...catalog.models[0], slug: config.model });
  await fs.writeFile(config.model_catalog_json, JSON.stringify(catalog));
  await fs.writeFile(path, stringify(config));
  const synced = f.run("synchronize", ...args, "--expected-revision", receipt.sourceRevision);
  assert.equal(synced.status, 0); assert.deepEqual(JSON.parse(synced.stdout).models, [config.model]);
  assert.equal(JSON.stringify(synced.stdout).includes("synthetic-command-private-key"), false);
});
