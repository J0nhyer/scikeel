import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { capabilityResult, nativePin, responsesFrame } from "../fixtures/native-protocol.mjs";
import * as protocol from "../fixtures/native-protocol.mjs";

const workflow = new URL("../../../.github/workflows/sandbox-image.yml", import.meta.url);

test("the native feasibility gate stages the integrity-pinned binary on dedicated CI", async () => {
  const source = await readFile(workflow, "utf8");
  assert.match(source, /native_feasibility_only:/);
  assert.match(source, /node scripts\/dev\/fetch-sandbox-codex\.mjs/);
  assert.match(source, /probe-production-runner\.mjs --native-capabilities/);
  assert.match(source, /native-capabilities-\$\{\{ github.sha \}\}/);
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
  const fixture = await readFile(new URL("../fixtures/native-protocol.mjs", import.meta.url), "utf8");
  assert.ok(fixture.includes('const binary = "/opt/scikeel/tools/bin/codex"'));
  assert.ok(!fixture.includes("/home/ubuntu/.codex"));
  const source = await readFile(workflow, "utf8");
  assert.ok(source.includes("--network=none --read-only --user 1000:1000 --memory=768m"));
  assert.ok(source.includes("persist-credentials: false"));
  assert.ok(!source.includes("--privileged"));
});
