import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, writeFile, rm, access, symlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { capabilityResult, nativePin, responsesFrame } from "../fixtures/native-protocol.mjs";
import * as protocol from "../fixtures/native-protocol.mjs";
import { extractCodexArchive } from "../../../scripts/dev/fetch-sandbox-codex.mjs";

const workflow = new URL("../../../.github/workflows/sandbox-image.yml", import.meta.url);

test("the native feasibility gate stages the integrity-pinned binary on dedicated CI", async () => {
  const source = await readFile(workflow, "utf8");
  assert.match(source, /native_feasibility_only:/);
  assert.match(source, /node scripts\/dev\/fetch-sandbox-codex\.mjs/);
  assert.match(source, /probe-production-runner\.mjs --native-capabilities/);
  assert.match(source, /native-capabilities-\$\{\{ github.sha \}\}/);
});

async function archiveFixture(t, linked = false) {
  const root = await mkdtemp(join(tmpdir(), "scikeel-native-archive-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, "package/vendor/x86_64-unknown-linux-musl");
  await mkdir(join(target, "bin"), { recursive: true });
  await mkdir(join(target, "codex-resources"));
  await writeFile(join(target, "bin/codex"), "synthetic native binary");
  if (linked) await symlink("../bin/codex", join(target, "codex-resources/bwrap"));
  else await writeFile(join(target, "codex-resources/bwrap"), "synthetic sandbox binary");
  await writeFile(join(root, "package/auth.json"), "must not be extracted");
  const archive = join(root, "fixture.tgz");
  const result = spawnSync("tar", ["-czf", archive, "-C", root, "package"]);
  assert.equal(result.status, 0);
  return { archive, destination: join(root, "tools") };
}

test("pinned staging retains the required sandbox resource without extracting the package home", async t => {
  const { archive, destination } = await archiveFixture(t);
  await extractCodexArchive(archive, destination);
  assert.equal(await readFile(join(destination, "codex"), "utf8"), "synthetic native binary");
  assert.equal(await readFile(join(destination, "codex-resources/bwrap"), "utf8"), "synthetic sandbox binary");
  await assert.rejects(access(join(destination, "auth.json")), { code: "ENOENT" });
  await assert.rejects(extractCodexArchive(archive, destination), /staging failed/);
});

test("pinned staging rejects a symlinked sandbox helper before writing executable bytes", async t => {
  const { archive, destination } = await archiveFixture(t, true);
  await assert.rejects(extractCodexArchive(archive, destination), /staging failed/);
  await assert.rejects(access(join(destination, "codex")), { code: "ENOENT" });
});

test("the native gate cannot pass with any missing, skipped or failed pre-effect check", () => {
  const names = ["denied-command", "allowed-command", "denied-edit", "allowed-edit", "denied-custom", "allowed-custom",
    "crashed-command", "crashed-edit", "crashed-custom"];
  const cases = names.map(name => ({ name, passed: true }));
  assert.equal(capabilityResult(cases).activationEligible, true);
  for (const name of names) {
    assert.equal(capabilityResult(cases.filter(value => value.name !== name)).activationEligible, false);
    assert.equal(capabilityResult(cases.map(value => value.name === name ? { ...value, passed: false } : value)).activationEligible, false);
    assert.equal(capabilityResult(cases.map(value => value.name === name ? { ...value, passed: undefined, skipped: true } : value)).activationEligible, false);
  }
});

test("fixture Responses frames exercise native tool dispatch rather than a text-only model success", () => {
  const item = { type: "function_call", name: "exec_command", call_id: "owned-call", arguments: JSON.stringify({ cmd: "printf fixture" }) };
  const frames = responsesFrame(item).trim().split("\n\n").map(line => JSON.parse(line.slice(6)));
  assert.deepEqual(frames.map(frame => frame.type), ["response.created", "response.output_item.done", "response.completed"]);
  assert.deepEqual(frames[1].item, item);
});

test("native diagnostics retain only advertised tool names and tool results, not prompts", () => {
  const value = { tools: [{ type: "function", name: "exec_command", description: "must not retain", parameters: {} }],
    input: [{ role: "system", content: "must not retain" }, { type: "function_call_output", call_id: "owned", output: "sandbox unavailable" }] };
  assert.deepEqual(protocol.nativeToolFacts?.(value), { toolCatalog: [{ type: "function", name: "exec_command" }],
    toolResults: ["sandbox unavailable"] });
});

test("feasibility uses the repository download pin and never a host Codex installation", async () => {
  const download = await readFile(new URL("../../../scripts/dev/fetch-sandbox-codex.mjs", import.meta.url), "utf8");
  assert.ok(download.includes(`const version="${nativePin.version}"`));
  assert.ok(download.includes("package/vendor/x86_64-unknown-linux-musl/codex-resources/bwrap"), "the native sandbox resource must not be discarded");
  const fixture = await readFile(new URL("../fixtures/native-protocol.mjs", import.meta.url), "utf8");
  assert.ok(fixture.includes('const binary = "/opt/scikeel/tools/bin/codex"'));
  assert.ok(!fixture.includes("/home/ubuntu/.codex"));
  const source = await readFile(workflow, "utf8");
  assert.ok(source.includes("--network=none --read-only --user 1000:1000 --memory=768m"));
  assert.ok(source.includes("--cap-drop=ALL --security-opt no-new-privileges"), "CI must retain the production zero-capability/no-new-privileges boundary");
  assert.ok(source.includes("persist-credentials: false"));
  assert.ok(!source.includes("--privileged"));
});
