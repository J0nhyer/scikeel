import test from "node:test";
import assert from "node:assert/strict";
import { probeSyntheticScience } from "../../../scripts/dev/probe-synthetic-science.mjs";

const digest = `sha256:${"a".repeat(64)}`;
test("scientific acceptance requires real evidence and reconciles failed starts", async () => {
  const stopped = [];
  const client = { register: async () => ({ generation: 1 }), start: async () => { throw new Error("launcher failed"); },
    stop: async (args) => stopped.push(args) };
  await assert.rejects(probeSyntheticScience({ client, imageDigest: digest }), /launcher failed/);
  assert.deepEqual(stopped, [{ instanceId: "sandbox-test-a", generation: 1, reason: "synthetic-science-cleanup" }]);
});
test("incomplete evidence fails instead of reporting a successful image", async () => {
  let stopped = 0;
  const client = { register: async () => ({ generation: 1 }), start: async () => ({ runnerEndpoint: "http://fixture" }), stop: async () => stopped++ };
  await assert.rejects(probeSyntheticScience({ client, imageDigest: digest,
    fetchImpl: async () => ({ status: 200, json: async () => ({ imports: true }) }) }), /incomplete/);
  assert.equal(stopped, 1);
});
test("scientific evidence includes secure file resolution and hidden host controls", async () => {
  const client = { register: async () => ({ generation: 1 }), start: async () => ({ runnerEndpoint: "http://fixture" }),
    stop: async () => {}, inspect: async () => ({ status: "ready", generation: 1, imageDigest: digest, quota: { enforced: true }, limits: { owned: true } }) };
  await assert.rejects(probeSyntheticScience({ client, imageDigest: digest,
    fetchImpl: async () => ({ status: 200, json: async () => ({ imports: true, figure: true, noPrivateVenv: true, baselineWriteRejected: true }) }) }), /incomplete/);
});
