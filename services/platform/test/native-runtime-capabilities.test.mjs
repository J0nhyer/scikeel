import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, writeFile, rm, access, symlink } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { crc32, inflateSync } from "node:zlib";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { capabilityResult, nativePin, responsesFrame } from "../fixtures/native-protocol.mjs";
import * as protocol from "../fixtures/native-protocol.mjs";
import { extractCodexArchive } from "../../../scripts/dev/fetch-sandbox-codex.mjs";
import { validateGuardLock, buildGuardRuntime } from "../../../scripts/dev/build-codex-guard-runtime.mjs";
import * as integration from "../../../scripts/dev/build-codex-guard-runtime.mjs";

const workflow = new URL("../../../.github/workflows/sandbox-image.yml", import.meta.url);

test('the pinned bubblewrap fix makes only loopback address creation idempotent and keeps errors fatal',async()=>{
 const lock=JSON.parse(await readFile(new URL('../../../runtime/codex-patches/required-effect-guard.lock.json',import.meta.url),'utf8'));
 const patch=await readFile(new URL('../../../runtime/codex-patches/loopback-address.patch',import.meta.url),'utf8');
 assert.equal(lock.bwrapPatchSha256,createHash('sha256').update(patch).digest('hex'));
 assert.deepEqual(patch.split('\n').filter(line=>line.startsWith('+')&&!line.startsWith('+++')),
  ['+                               NLM_F_CREATE | NLM_F_REPLACE | NLM_F_ACK,']);
 assert.deepEqual(patch.split('\n').filter(line=>line.startsWith('-')&&!line.startsWith('---')),
  ['-                               NLM_F_CREATE | NLM_F_EXCL | NLM_F_ACK,']);
 assert.match(patch,/codex-rs\/vendor\/bubblewrap\/network\.c/);
});

test('native feasibility executes the real effect fixture in gVisor as well as ordinary Docker',async()=>{
 const source=await readFile(workflow,'utf8');
 assert.match(source,/--runtime=scikeel-gvisor/);
 assert.match(source,/runsc version release-20260928\.0/);
 assert.match(source,/native-gvisor-capabilities-/);
});

test("native feasibility stages the complete production requirements, including the pinned read-only profile prerequisite", async t => {
  const directory = await mkdtemp(join(tmpdir(), "scikeel-native-requirements-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "requirements.toml");
  await protocol.stageNativeRequirements(path);
  const content = await readFile(path, "utf8");
  assert.equal(content, await readFile(new URL("../../../runtime/sandbox/codex-requirements.toml", import.meta.url), "utf8"));
  // ConfigRequirements::try_from in the pinned native source rejects every
  // PermissionProfile unless the managed sandbox allowlist includes read-only.
  assert.match(content, /^allowed_sandbox_modes = \["read-only", "workspace-write"\]$/m);
  assert.match(content, /^allow_managed_hooks_only = true$/m);
  assert.match(content, /^plugins = false$/m);
  assert.match(content, /required-effect-guard\.mjs --guard/);
  assert.doesNotMatch(content, /danger-full-access/);
});

test("the native feasibility gate stages the integrity-pinned binary on dedicated CI", async () => {
  const source = await readFile(workflow, "utf8");
  assert.match(source, /native_feasibility_only:/);
  assert.match(source, /node scripts\/dev\/fetch-sandbox-codex\.mjs/);
  assert.match(source, /probe-production-runner\.mjs --native-capabilities/);
  assert.match(source, /native-capabilities-\$\{\{ github.sha \}\}/);
});

test("native CI caches exact compiler inputs without fuzzy restoration or skipping Rust evidence", async () => {
  const source = await readFile(workflow, "utf8");
  const { load } = createRequire(import.meta.url)("js-yaml");
  const steps = load(source).jobs["native-feasibility"].steps;
  const cache = steps.find(step => step.id === "native-cache");
  assert.equal(cache?.uses, "actions/cache/restore@v4");
  assert.equal(cache.with["restore-keys"], undefined);
  assert.ok(steps.find(step => step.id === "native-build").run.includes("pnpm runtime:codex:build"));
  assert.ok(source.includes("uses: actions/cache/restore@v4"));
  assert.ok(source.includes("uses: actions/cache/save@v4"));
  assert.ok(source.includes("codex-36650394c5b38c2990ccf2a3457165ca3e9d9726-rust1.95.0-x86_64-unknown-linux-gnu"));
  assert.ok(source.includes("hashFiles('runtime/codex-patches/**', 'scripts/dev/build-codex-guard-runtime.mjs', 'pnpm-lock.yaml')"));
  assert.ok(!source.includes("restore-keys:"));
  assert.ok(source.indexOf("uses: actions/cache/save@v4") < source.indexOf("name: Verify real pre-effect guards"));
  const builder = await readFile(new URL("../../../scripts/dev/build-codex-guard-runtime.mjs", import.meta.url), "utf8");
  assert.ok(builder.includes('regression("red")'));
  assert.ok(builder.includes('regression("green")'));
  assert.ok(builder.includes('run("cargo", ["build", "--locked"'));
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
    "crashed-command", "crashed-edit", "crashed-custom", "stopped-command", "stopped-edit", "stopped-custom", "allowed-question", "denied-question",
    "allowed-running-command", "stopped-running-command",
    ...["malformed", "empty", "timedout", "missing"].flatMap(mode => ["command", "edit", "custom"].map(kind => `${mode}-${kind}`))];
  const cases = names.map(name => ({ name, passed: true, ...(name === 'allowed-command' ? { isolationVerified: true } : {}) }));
  assert.equal(capabilityResult(cases).activationEligible, true);
  for (const name of names) {
    assert.equal(capabilityResult(cases.filter(value => value.name !== name)).activationEligible, false);
    assert.equal(capabilityResult(cases.map(value => value.name === name ? { ...value, passed: false } : value)).activationEligible, false);
    assert.equal(capabilityResult(cases.map(value => value.name === name ? { ...value, passed: undefined, skipped: true } : value)).activationEligible, false);
  }
});

test('native success without actual workspace and network isolation evidence remains ineligible', () => {
  const names = ['denied-command','allowed-command','denied-edit','allowed-edit','denied-custom','allowed-custom',
    'crashed-command','crashed-edit','crashed-custom','stopped-command','stopped-edit','stopped-custom',
    'allowed-question','denied-question','allowed-running-command','stopped-running-command',
    ...['malformed','empty','timedout','missing'].flatMap(mode=>['command','edit','custom'].map(kind=>`${mode}-${kind}`))];
  assert.equal(capabilityResult(names.map(name=>({name,passed:true}))).activationEligible,false);
});

test("the integrated native guard patch is immutable and requires explicit allow, not hook process success", async () => {
  const lock = JSON.parse(await readFile(new URL("../../../runtime/codex-patches/required-effect-guard.lock.json", import.meta.url), "utf8"));
  const patch = await readFile(new URL("../../../runtime/codex-patches/required-effect-guard.patch", import.meta.url), "utf8");
  assert.equal(lock.patchSha256, createHash("sha256").update(patch).digest("hex"));
  assert.ok(patch.includes('+    let mut should_block = true;'));
  assert.ok(patch.includes('parsed.explicit_allow'));
  assert.ok(patch.includes('required_guard_count == 1'));
  assert.ok(patch.includes('hook_events.len() == required_guard_count'));
  assert.deepEqual(validateGuardLock(lock), lock);
  for (const key of ["policy", "upstreamCommit", "upstreamVersion", "rustVersion", "patchSha256", "bwrapPatchSha256", "bwrapSha256", "lockFormat", "upstreamLockSha256", "workspaceLockSha256"])
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
  assert.deepEqual(protocol.nativeToolFacts?.(value), { reasoningEffort: null, imageInput: false, toolCatalog: [{ type: "function", name: "exec_command" }],
    toolResults: ["sandbox unavailable"] });
});

test("feasibility uses the repository download pin and never a host Codex installation", async () => {
  const download = await readFile(new URL("../../../scripts/dev/fetch-sandbox-codex.mjs", import.meta.url), "utf8");
  assert.ok(download.includes(`const version="${nativePin.version}"`));
  assert.ok(download.includes("package/vendor/x86_64-unknown-linux-musl/codex-resources/bwrap"), "the native sandbox resource must not be discarded");
  const fixture = await readFile(new URL("../fixtures/native-protocol.mjs", import.meta.url), "utf8");
  assert.ok(fixture.includes('const binary = "/opt/scikeel/tools/bin/codex"'));
  assert.ok(!fixture.includes("/home/ubuntu/.codex"));
  assert.ok(fixture.includes("/proc/net/dev"), "the isolation probe must use the proc network view under seccomp");
  assert.ok(!fixture.includes("socket.if_nameindex"), "the isolation probe must not require the blocked netlink interface API");
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

test("the native CI parser install retains frozen platform dependency and override metadata", async () => {
  const { load } = createRequire(import.meta.url)("js-yaml");
  const rootPackage = JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8"));
  const lock = load(await readFile(new URL("../../../pnpm-lock.yaml", import.meta.url), "utf8"));
  assert.equal(lock.importers["services/platform"].dependencies["js-yaml"].specifier, rootPackage.pnpm.overrides["js-yaml@4"]);
  assert.equal(lock.importers["services/platform"].dependencies["js-yaml"].version, "4.3.1");
  assert.equal(lock.importers["services/platform"].dependencies["smol-toml"].version, "1.9.0");
});

test("the native fixture denies foreign, replayed and malformed dynamic tool calls before any effect", () => {
  assert.equal(typeof protocol.NativeConnection, "function");
  const child = new EventEmitter();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const connection = new protocol.NativeConnection(child, "allow");
  Object.assign(connection, { thread: "owned-thread", turn: "owned-turn", expectedCallId: "owned-call" });
  const params = { threadId: "owned-thread", turnId: "owned-turn", callId: "owned-call", tool: "research_checkpoint", arguments: { checkpoint: "fixture" } };
  for (const changed of [{ threadId: "foreign" }, { turnId: "foreign" }, { callId: "foreign" }, { callId: undefined },
    { arguments: null }, { tool: "exec_command" }]) {
    connection.receive({ id: 20, method: "item/tool/call", params: { ...params, ...changed } });
    assert.equal(connection.customEffects, 0);
  }
  connection.receive({ id: 21, method: "item/tool/call", params });
  assert.equal(connection.customEffects, 1);
  connection.receive({ id: 21, method: "item/tool/call", params });
  assert.equal(connection.customEffects, 1, "a repeated native call cannot repeat its effect");
});

test("native effect evidence requires the owned item start before its completion", () => {
  assert.equal(typeof protocol.orderedNativeToolEvidence, "function");
  const start = { method: "item/started", params: { threadId: "owned-thread", turnId: "owned-turn", item: { id: "tool-1", type: "commandExecution" } } };
  const complete = { ...start, method: "item/completed" };
  const expected = { callId: "tool-1", itemType: "commandExecution" };
  assert.equal(protocol.orderedNativeToolEvidence([start, complete], "owned-thread", "owned-turn", expected), true);
  for (const frames of [[complete, start], [start], [complete], [
    { ...start, params: { ...start.params, threadId: "foreign" } }, complete], [start,
    { ...complete, params: { ...complete.params, item: { id: "foreign", type: "commandExecution" } } }]])
    assert.equal(protocol.orderedNativeToolEvidence(frames, "owned-thread", "owned-turn", expected), false);
});

test("native effect events cannot substitute another call or tool type in the same owned turn", () => {
  const start = { method: "item/started", params: { threadId: "owned-thread", turnId: "owned-turn", item: { id: "owned-call", type: "commandExecution" } } };
  const complete = { ...start, method: "item/completed" };
  for (const expected of [undefined, {}, { callId: "different-call", itemType: "commandExecution" },
    { callId: "owned-call", itemType: "fileChange" }])
    assert.equal(protocol.orderedNativeToolEvidence([start, complete], "owned-thread", "owned-turn", expected), false);
  assert.equal(protocol.orderedNativeToolEvidence([start, { ...complete, params: { ...complete.params,
    item: { id: "owned-call", type: "fileChange" } } }], "owned-thread", "owned-turn",
    { callId: "owned-call", itemType: "commandExecution" }), false);
});

test("native parser regressions require actual Rust RED and GREEN before publishing a binary", async () => {
  assert.equal(typeof integration.validateRustRegression, "function");
  const output = "test engine::output_parser::tests::scikeel_required_guard_allow_preserves_original_input ... FAILED\n" +
    "test engine::output_parser::tests::scikeel_required_guard_rejects_all_input_rewrites ... FAILED\n";
  assert.equal(integration.validateRustRegression({ status: 101, stdout: output }, "red"), true);
  for (const result of [{ status: 0, stdout: output }, { status: 101, stdout: "compiler failed" }, { status: null, stdout: output }])
    assert.throws(() => integration.validateRustRegression(result, "red"), /Rust regression/);
  assert.throws(() => integration.validateRustRegression({ status: 0, stdout: "test result: ok. 0 passed; 0 failed" }, "green"), /Rust regression/);
  const source = await readFile(new URL("../../../scripts/dev/build-codex-guard-runtime.mjs", import.meta.url), "utf8");
  assert.ok(source.includes('"--package", "codex-hooks", "--lib", "scikeel_required_guard"'));
  const patch = await readFile(new URL("../../../runtime/codex-patches/required-effect-guard-tests.patch", import.meta.url), "utf8");
  assert.ok(patch.includes("scikeel_required_guard_allow_preserves_original_input"));
  assert.ok(patch.includes("scikeel_required_guard_handler_deny_beats_allow_in_either_order"));
});

test("the native fixture binds hook authority to the exact owned tool input, not hook receipt", () => {
  assert.equal(typeof protocol.validNativeGuardInput, "function");
  const expected = { thread: "owned-thread", turn: "owned-turn", call: "owned-call", cwd: "/fixture/workspace", tool: "Bash", input: { command: "printf allowed" } };
  const input = { session_id: expected.thread, turn_id: expected.turn, tool_use_id: expected.call,
    cwd: expected.cwd, tool_name: expected.tool, tool_input: expected.input, hook_event_name: "PreToolUse" };
  assert.equal(protocol.validNativeGuardInput(input, expected), true);
  for (const changed of [{ session_id: "foreign" }, { turn_id: "foreign" }, { tool_use_id: "foreign" },
    { cwd: "/host" }, { tool_name: "apply_patch" }, { tool_input: { command: "printf changed" } },
    { tool_input: { ...expected.input, injected: true } }, { hook_event_name: "PostToolUse" }])
    assert.equal(protocol.validNativeGuardInput({ ...input, ...changed }, expected), false);
  assert.equal(protocol.validNativeGuardInput(null, expected), false);
});

test("native authorization includes all original arguments alongside canonical command input", () => {
  assert.equal(typeof protocol.nativeGuardInput, "function");
  const args = { cmd: "printf allowed", workdir: "/fixture/workspace", shell: "/bin/bash", login: false };
  const item = { type: "function_call", name: "exec_command", arguments: JSON.stringify(args) };
  assert.deepEqual(protocol.nativeGuardInput(item), { nativeTool: "exec_command", nativeInput: args, canonicalInput: { command: args.cmd } });
  const changed = { ...item, arguments: JSON.stringify({ ...args, workdir: "/host" }) };
  assert.notDeepEqual(protocol.nativeGuardInput(changed), protocol.nativeGuardInput(item), "same command cannot hide a changed execution directory");
  assert.throws(() => protocol.nativeGuardInput({ ...item, arguments: "not-json" }));
});

test("native question answers require the owned thread, turn, item and exact question", () => {
  const child = new EventEmitter();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const connection = new protocol.NativeConnection(child, "allow");
  Object.assign(connection, { thread: "owned-thread", turn: "owned-turn", expectedCallId: "owned-call" });
  const params = { threadId: "owned-thread", turnId: "owned-turn", itemId: "owned-call", isBlocking: true,
    questions: [{ id: "fixture_choice", header: "Choice", question: "Select fixture outcome?", options: [
      { label: "Continue", description: "Continue fixture" }, { label: "Pause", description: "Pause fixture" }] }] };
  for (const changed of [{ threadId: "foreign" }, { turnId: "foreign" }, { itemId: "foreign" }, { isBlocking: false },
    { questions: [{ ...params.questions[0], id: "foreign" }] }]) {
    connection.receive({ id: 40, method: "item/tool/requestUserInput", params: { ...params, ...changed } });
    assert.equal(connection.questionAnswers ?? 0, 0);
  }
  connection.receive({ id: 41, method: "item/tool/requestUserInput", params });
  assert.equal(connection.questionAnswers, 1);
  connection.receive({ id: 41, method: "item/tool/requestUserInput", params });
  assert.equal(connection.questionAnswers, 1);
  assert.equal(connection.customEffects, 0, "answering a question does not authorize another tool effect");
});

test("native reasoning and attachment evidence observes serialized provider inputs without retaining content", () => {
  const facts = protocol.nativeToolFacts({ reasoning: { effort: "low" }, input: [
    { type: "message", role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,synthetic-image-canary" }] },
  ] });
  assert.equal(facts.reasoningEffort, "low");
  assert.equal(facts.imageInput, true);
  assert.ok(!JSON.stringify(facts).includes("synthetic-image-canary"));
  assert.equal(protocol.nativeToolFacts({ input: [] }).imageInput, false);
});

test("the native image fixture contains a complete decodable PNG with valid chunk checksums", () => {
  const bytes = Buffer.from(protocol.pixel.slice("data:image/png;base64,".length), "base64");
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  const chunks = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset), type = bytes.toString("ascii", offset + 4, offset + 8);
    assert.equal(crc32(bytes.subarray(offset + 4, offset + 8 + length)), bytes.readUInt32BE(offset + 8 + length),
      `The native decoder must not discard an invalid ${type} fixture chunk`);
    chunks.push(type);
    if (type === "IHDR") {
      assert.equal(bytes.readUInt32BE(offset + 8), 1);
      assert.equal(bytes.readUInt32BE(offset + 12), 1);
    } else if (type === "IDAT") assert.equal(inflateSync(bytes.subarray(offset + 8, offset + 8 + length)).length, 3);
    offset += length + 12;
  }
  assert.deepEqual(chunks, ["IHDR", "IDAT", "IEND"]);
});

test("native fixture cleanup waits for exit and kills an already running child process group", async t => {
  const root = await mkdtemp(join(tmpdir(), "scikeel-native-stop-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ready = join(root, "child-ready.txt"), late = join(root, "late-effect.txt");
  const descendant = `require('node:fs').writeFileSync(${JSON.stringify(ready)},'started');setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(late)},'late effect'),500);`;
  const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'inherit'});setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ["-e", parent], { detached: true, stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} });
  const connection = new protocol.NativeConnection(child, "stopped");
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try { await access(ready); break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await access(ready);
  await connection.close();
  await new Promise(resolve => setTimeout(resolve, 700));
  await assert.rejects(access(late), { code: "ENOENT" });
  assert.equal(connection.exitObserved, true);
});

test("native fixture cleanup cannot forget a surviving child when the app-server has already exited", async t => {
  const root = await mkdtemp(join(tmpdir(), "scikeel-native-orphan-"));
  const ready = join(root, "child-ready.txt"), late = join(root, "late-effect.txt");
  const descendant = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(ready)},'started');setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(late)},'late effect'),500);`;
  const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});process.exit(0);`;
  const child = spawn(process.execPath, ["-e", parent], { detached: true, stdio: ["pipe", "pipe", "pipe"] });
  t.after(async () => { try { process.kill(-child.pid, "SIGKILL"); } catch {} await rm(root, { recursive: true, force: true }); });
  const connection = new protocol.NativeConnection(child, "stopped");
  await connection.exited;
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try { await access(ready); break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await access(ready);
  await connection.close();
  await new Promise(resolve => setTimeout(resolve, 700));
  await assert.rejects(access(late), { code: "ENOENT" });
});

function pendingNativeConnection() {
  const child = new EventEmitter();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const connection = new protocol.NativeConnection(child, "stopped");
  Object.assign(connection, { thread: "owned-thread", turn: "owned-turn", expectedCallId: "owned-call" });
  return { child, connection };
}

const commandStart = { method: "item/started", params: { threadId: "owned-thread", turnId: "owned-turn",
  item: { id: "owned-call", type: "commandExecution" } } };

test("native running-command evidence waits for asynchronous exact owned start notification", async () => {
  const { connection } = pendingNativeConnection();
  const waiting = connection.waitForStarted("commandExecution", 500);
  setTimeout(() => connection.receive(commandStart), 30);
  assert.equal(await waiting, true);
});

test("native start wait cannot accept foreign identity, another item type or completion alone", async () => {
  const { connection } = pendingNativeConnection();
  for (const params of [{ ...commandStart.params, threadId: "foreign" }, { ...commandStart.params, turnId: "foreign" },
    { ...commandStart.params, item: { id: "foreign", type: "commandExecution" } },
    { ...commandStart.params, item: { id: "owned-call", type: "fileChange" } }])
    connection.receive({ ...commandStart, params });
  connection.receive({ ...commandStart, method: "item/completed" });
  await assert.rejects(connection.waitForStarted("commandExecution", 60), /owned native item did not start/);
});

test("native start wait propagates observed process exit instead of claiming authority", async () => {
  const { child, connection } = pendingNativeConnection();
  const waiting = connection.waitForStarted("commandExecution", 500);
  setTimeout(() => child.emit("close", 0), 20);
  await assert.rejects(waiting, /native process closed/);
});

test("late native effects remain under observation when the timer wakes before its requested deadline", async () => {
  let clock = 100, waits = 0;
  const elapsed = await protocol.observeLateEffects(100, 5500, { now: () => clock, wait: async ms => {
    waits++; clock += waits === 1 ? ms - 1 : ms;
  } });
  assert(elapsed >= 5500, "One early timer wake must not end the required native late-effect observation window");
  assert.equal(waits, 2);
});

test("late native effects already observed through cleanup need no additional deadline delay", async () => {
  let waits = 0;
  const elapsed = await protocol.observeLateEffects(100, 5500, { now: () => 5700, wait: async () => { waits++; } });
  assert.equal(elapsed, 5600); assert.equal(waits, 0);
});
