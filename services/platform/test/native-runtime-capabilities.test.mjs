import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, writeFile, rm, access, symlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { capabilityResult, nativePin, responsesFrame } from "../fixtures/native-protocol.mjs";
import * as protocol from "../fixtures/native-protocol.mjs";
import { extractCodexArchive } from "../../../scripts/dev/fetch-sandbox-codex.mjs";
import { validateGuardLock, buildGuardRuntime } from "../../../scripts/dev/build-codex-guard-runtime.mjs";
import * as integration from "../../../scripts/dev/build-codex-guard-runtime.mjs";

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
    "crashed-command", "crashed-edit", "crashed-custom",
    ...["malformed", "empty", "timedout", "missing"].flatMap(mode => ["command", "edit", "custom"].map(kind => `${mode}-${kind}`))];
  const cases = names.map(name => ({ name, passed: true }));
  assert.equal(capabilityResult(cases).activationEligible, true);
  for (const name of names) {
    assert.equal(capabilityResult(cases.filter(value => value.name !== name)).activationEligible, false);
    assert.equal(capabilityResult(cases.map(value => value.name === name ? { ...value, passed: false } : value)).activationEligible, false);
    assert.equal(capabilityResult(cases.map(value => value.name === name ? { ...value, passed: undefined, skipped: true } : value)).activationEligible, false);
  }
});

test("the integrated native guard patch is immutable and requires explicit allow, not hook process success", async () => {
  const lock = JSON.parse(await readFile(new URL("../../../runtime/codex-patches/required-effect-guard.lock.json", import.meta.url), "utf8"));
  const patch = await readFile(new URL("../../../runtime/codex-patches/required-effect-guard.patch", import.meta.url), "utf8");
  assert.equal(lock.patchSha256, createHash("sha256").update(patch).digest("hex"));
  assert.ok(patch.includes('+    let mut should_block = true;'));
  assert.ok(patch.includes('== Some("allow")'));
  assert.ok(patch.includes('required_guard_count > 0'));
  assert.ok(patch.includes('hook_events.len() == required_guard_count'));
  assert.deepEqual(validateGuardLock(lock), lock);
  for (const key of ["policy", "upstreamCommit", "upstreamVersion", "rustVersion", "patchSha256", "bwrapSha256", "lockFormat", "upstreamLockSha256", "workspaceLockSha256"])
    assert.throws(() => validateGuardLock({ ...lock, [key]: "foreign" }), /Invalid pinned/);
  if (process.env.CI !== "true") await assert.rejects(buildGuardRuntime(), /Dedicated native CI required/);
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

test("Web native integration requires an explicit successful guard and cannot compile on this small host", async () => {
  const path = new URL("../../../scripts/dev/build-codex-guard-runtime.mjs", import.meta.url);
  const source = await readFile(path, "utf8").catch(() => "");
  assert.ok(source.includes("required-effect-guard-v1"), "the fail-open native pin requires a separate reviewed Web integration");
  assert.ok(source.includes("totalmem() < 8 * 1024 ** 3"));
  assert.ok(source.includes("Dedicated native CI required"));
  const workflowSource = await readFile(workflow, "utf8");
  assert.ok(workflowSource.includes("pnpm runtime:codex:build"));
});

test("native release lock reconciliation changes only local workspace versions and preserves upstream dependency pins", () => {
  const lock = { version: 4, package: [
    ...Array.from({ length: 155 }, (_, i) => ({ name: `fixture-${i}`, version: "0.0.0", dependencies: ["external 1.2.3"] })),
    { name: "external", version: "1.2.3", source: "registry+https://github.com/rust-lang/crates.io-index", checksum: "a".repeat(64) },
  ] };
  const reconciled = integration.reconcileWorkspaceVersions?.(lock);
  assert.ok(reconciled, "the tagged upstream lock needs checked workspace-only version reconciliation");
  assert.equal(reconciled.package.filter(value => value.version === "0.157.1").length, 155);
  assert.equal(lock.package[0].version, "0.0.0", "input remains untouched");
  assert.deepEqual(reconciled.package.at(-1), lock.package.at(-1));
  assert.deepEqual(reconciled.package[0].dependencies, lock.package[0].dependencies);
  assert.throws(() => integration.reconcileWorkspaceVersions({ ...lock, package: lock.package.slice(1) }), /workspace version/);
  assert.throws(() => integration.reconcileWorkspaceVersions({ ...lock, version: 3 }), /workspace version/);
});
