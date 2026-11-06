import test from "node:test";
import assert from "node:assert/strict";
import { classifyBenchmark } from "./probe-docker-runtime.mjs";

test("accepts a 2x emulation slowdown", () => {
  assert.deepEqual(classifyBenchmark({ amd64Ms: 320, arm64Ms: 160 }), { decision: "accept", ratio: 2 });
});

test("falls back at 5x", () => {
  assert.deepEqual(classifyBenchmark({ amd64Ms: 800, arm64Ms: 160 }), { decision: "fallback", ratio: 5 });
});
