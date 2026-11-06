import test from "node:test";
import assert from "node:assert/strict";
import { parseFrame, successFrame, failureFrame, MAX_FRAME } from "../src/protocol.mjs";
const line = value => Buffer.from(JSON.stringify(value) + "\n");
const digest = `sha256:${"a".repeat(64)}`;

test("parses a fixed start frame", () => {
  const frame = parseFrame(line({ schema: 1, requestId: "r1", op: "start", args: { instanceId: "a", generation: 1, imageDigest: digest } }));
  assert.deepEqual(frame.args, { instanceId: "a", generation: 1, imageDigest: digest });
});

test("rejects unknown fields and missing newline", () => {
  assert.throws(() => parseFrame(line({ schema: 1, requestId: "r1", op: "register", args: { instanceId: "a", userId: "b", mounts: [] } })), /invalid_frame/);
  assert.throws(() => parseFrame(Buffer.from(JSON.stringify({ schema: 1, requestId: "r1", op: "inventory", args: {} }))), /invalid_frame/);
  assert.throws(() => parseFrame(Buffer.alloc(MAX_FRAME + 1, 120)), /invalid_frame/);
});

test("encodes success and failure", () => {
  assert.equal(successFrame("r1", { instanceId: "a", generation: 1 }), JSON.stringify({ schema: 1, requestId: "r1", ok: true, result: { instanceId: "a", generation: 1 } }) + "\n");
  assert.equal(failureFrame("r1", "stale_generation"), JSON.stringify({ schema: 1, requestId: "r1", ok: false, error: "stale_generation" }) + "\n");
});
