import assert from "node:assert/strict";
import { test } from "node:test";
import { collaborationHooks } from "../../../runtime/sandbox/collaboration.mjs";
const chain = {
  min() {
    return this;
  },
  max() {
    return this;
  },
};
const schema = { enum: () => chain, string: () => chain };
test("pending research blocks all later tools and returns only a real answer", async () => {
  const pending = { id: "decision", execution: 1 };
  let answer = null,
    paused = false;
  const hooks = collaborationHooks({
    schema,
    token: "a".repeat(64),
    request: async (_sid, b) =>
      b.action === "guard"
        ? { blocked: !answer }
        : {
            state: {
              pending,
              phase: paused ? "paused" : "running",
              execution: 1,
              decisions: answer ? [{ ...pending, answer }] : [],
            },
          },
  });
  await assert.rejects(
    hooks["tool.execute.before"]({ tool: "write", sessionID: "s" }),
    /answer/,
  );
  await assert.rejects(
    hooks["tool.execute.before"]({
      tool: "research_checkpoint",
      sessionID: "s",
    }),
    /answer/,
  );
  answer = "Continue";
  const output = await hooks.tool.research_checkpoint.execute(
    {},
    { sessionID: "s", abort: new AbortController().signal },
  );
  assert.equal(JSON.parse(output).userAnswer, "Continue");
  await hooks["tool.execute.before"]({ tool: "write", sessionID: "s" });
  paused = true;
  await assert.rejects(
    hooks.tool.research_checkpoint.execute({}, { sessionID: "s" }),
    /paused/,
  );
});
test("bridge failures never become permission", async () => {
  const h = collaborationHooks({
    schema,
    token: "a".repeat(64),
    request: async () => {
      throw new Error("unavailable");
    },
  });
  await assert.rejects(
    h["tool.execute.before"]({ sessionID: "s" }),
    /unavailable/,
  );
});

test("abort cancels a pending checkpoint without returning suggested approval", async () => {
  const controller = new AbortController();
  const state = {
    pending: { id: "decision", execution: 1 },
    phase: "waiting_input",
    execution: 1,
    decisions: [],
  };
  const h = collaborationHooks({
    token: "a".repeat(64),
    request: async () => ({ state }),
  });
  const waiting = h.tool.research_checkpoint.execute(
    {},
    { sessionID: "s", abort: controller.signal },
  );
  setTimeout(() => controller.abort(new Error("user stopped")), 10);
  await assert.rejects(waiting, /user stopped/);
});

test("a checkpoint preflight registers before a concurrent write can pass its barrier", async () => {
  let blocked = false;
  const h = collaborationHooks({
    token: "a".repeat(64),
    request: async (_sid, value) => {
      if (value.action === "guard") return { blocked };
      await new Promise((r) => setTimeout(r, 10));
      blocked = true;
      return { state: { pending: { id: "decision" } } };
    },
  });
  const checkpoint = h["tool.execute.before"](
    { sessionID: "s", callID: "c", tool: "research_checkpoint" },
    { args: { kind: "plan", question: "Plan?", suggestedAnswer: "Continue" } },
  );
  const write = h["tool.execute.before"]({ sessionID: "s", tool: "write" }, {});
  await Promise.all([checkpoint, assert.rejects(write, /answer/)]);
});
