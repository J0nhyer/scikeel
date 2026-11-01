import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CollaborationStore } from "../src/collaboration.mjs";
import { readAssistantLedgerInventory } from "../src/assistant-inventory.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "scikeel-collaboration-recovery-"));
  let cancels = 0;
  const store = new CollaborationStore({
    rootDir: root,
    now: () => 1000,
    cancel: async () => { cancels++; },
  });
  const owner = {
    userId: "usr_a",
    sessionId: "ses_a",
    instanceId: "user-usr_a",
    generation: 1,
    directory: "/workspace",
    workspaceDir: "/workspace",
    runtime: "codex",
  };
  return { root, store, owner, cancels: () => cancels };
}

test("a waiting checkpoint without a live turn becomes paused and remains answerable", async () => {
  const f = await fixture();
  try {
    await f.store.begin(f.owner, 0);
    const waiting = await f.store.checkpoint(f.owner, {
      kind: "missing_input",
      question: "Need input",
      execution: 1,
    });
    const settled = await f.store.settled(f.owner, 1);
    assert.equal(settled.phase, "paused");
    assert.equal(settled.pending.id, waiting.pending.id);
    await assert.rejects(f.store.begin(f.owner, settled.revision), /requires an answer/);
    const answered = await f.store.answer(f.owner, {
      id: settled.pending.id,
      execution: 1,
      revision: settled.revision,
      answer: "Use A",
    });
    assert.equal(answered.phase, "paused");
    assert.equal(answered.pending, null);
    const next = await f.store.begin(f.owner, answered.revision);
    assert.equal(next.phase, "running");
    assert.equal(next.execution, 2);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("discard clears a pending decision, cancels the live turn, and permits a new execution", async () => {
  const f = await fixture();
  try {
    await f.store.begin(f.owner, 0);
    const waiting = await f.store.checkpoint(f.owner, {
      kind: "method",
      question: "Use A?",
      suggestedAnswer: "A",
      execution: 1,
    });
    const discarded = await f.store.discard(f.owner, {
      id: waiting.pending.id,
      execution: 1,
      revision: waiting.revision,
    });
    assert.equal(discarded.pending, null);
    assert.equal(discarded.phase, "paused");
    assert.equal(f.cancels(), 1);
    const next = await f.store.begin(f.owner, discarded.revision);
    assert.equal(next.phase, "running");
    assert.equal(next.execution, 2);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a stale pause cannot cancel a newer execution", async () => {
  const f = await fixture();
  try {
    await f.store.begin(f.owner, 0);
    const waiting = await f.store.checkpoint(f.owner, {
      kind: "method",
      question: "Use A?",
      execution: 1,
    });
    await f.store.settled(f.owner, 1);
    const answered = await f.store.answer(f.owner, {
      id: waiting.pending.id,
      execution: 1,
      revision: waiting.revision + 1,
      answer: "A",
    });
    const next = await f.store.begin(f.owner, answered.revision);
    await assert.rejects(
      f.store.pause(f.owner, 1, false, next.revision),
      /Research execution changed/,
    );
    assert.equal((await f.store.get(f.owner)).execution, next.execution);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("an answer and a suspension race never loses the decision", async () => {
  const f = await fixture();
  try {
    await f.store.begin(f.owner, 0);
    const waiting = await f.store.checkpoint(f.owner, {
      kind: "method",
      question: "Use A?",
      execution: 1,
    });
    await Promise.allSettled([
      f.store.answer(f.owner, {
        id: waiting.pending.id,
        execution: 1,
        revision: waiting.revision,
        answer: "A",
      }),
      f.store.suspendPending(f.owner, 1),
    ]);
    const state = await f.store.get(f.owner);
    assert.equal(state.pending, null);
    assert.equal(state.decisions.length, 1);
    assert.ok(["paused", "running", "idle"].includes(state.phase));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("checkpoint rejects a stale execution", async () => {
  const f = await fixture();
  try {
    await f.store.begin(f.owner, 0);
    await assert.rejects(
      f.store.checkpoint(f.owner, { kind: "method", question: "Use A?", execution: 2 }),
      /Research execution changed/,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a paused pending decision is not an active or uncertain assistant execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "scikeel-collaboration-inventory-"));
  try {
    await mkdir(join(root, "collaboration", "usr_a"), { recursive: true, mode: 0o700 });
    await writeFile(
      join(root, "collaboration", "usr_a", "ses_a.json"),
      JSON.stringify({
        version: 1,
        userId: "usr_a",
        sessionId: "ses_a",
        phase: "paused",
        instanceId: "user-usr_a",
        generation: 1,
        runtime: "codex",
        execution: 1,
        pending: { id: "pending-1", execution: 1, kind: "method", question: "Use A?" },
      }),
      { mode: 0o600 },
    );
    const inventory = await readAssistantLedgerInventory({
      roots: {
        collaboration: join(root, "collaboration"),
        research: join(root, "research"),
      },
      records: { collaboration: new Map(), research: new Map() },
    });
    assert.equal(inventory.activeExecutions.length, 0);
    assert.equal(inventory.uncertainEffects.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
