import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, test } from "node:test";
import { AttachmentStore, ATTACHMENT_LIMITS, validateMessageBudget } from "../src/attachments.mjs";
const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(now) {
  const root = await mkdtemp(join(tmpdir(), "scikeel-attachments-")); roots.push(root);
  const store = new AttachmentStore({ rootDir: join(root, "private"), now }); await store.init();
  return { root, store };
}
const bytes = (text) => Readable.from([Buffer.from(text)]);
test("original byte limits count repeated names separately", () => {
  assert.equal(ATTACHMENT_LIMITS.fileBytes, 25 * 1024 ** 2);
  assert.throws(() => validateMessageBudget(Array.from({ length: 11 }, () => ({ size: 1 }))), { status: 413 });
  assert.throws(() => validateMessageBudget(Array.from({ length: 5 }, () => ({ size: 25 * 1024 ** 2 }))), { status: 413 });
  assert.doesNotThrow(() => validateMessageBudget([{ size: 0 }, { size: 1 }]));
});
test("same names stay separate, survive restart and reject other owners", async () => {
  const { root, store } = await fixture(); const draft = await store.createDraft("user_a");
  const a = await store.upload("user_a", { draftId: draft.id }, "data.csv", bytes("x\n1\n"));
  const b = await store.upload("user_a", { draftId: draft.id }, "data.csv", bytes("x\n2\n"));
  assert.notEqual(a.id, b.id); assert.notEqual(a.sha256, b.sha256);
  await store.claim("user_a", draft.id, "session_a", [a.id, b.id]);
  await assert.rejects(store.claim("user_a", draft.id, "session_b", [a.id]), { status: 409 });
  await assert.rejects(store.get("user_b", { sessionId: "session_a" }, a.id), { status: 404 });
  await assert.rejects(store.get("user_a", { sessionId: "session_b" }, a.id), { status: 404 });
  const reopened = new AttachmentStore({ rootDir: join(root, "private") }); await reopened.init();
  assert.equal((await reopened.list("user_a", "session_a")).attachments.length, 2);
  assert.equal((await readFile(await reopened.path("user_a", { sessionId: "session_a" }, a.id))).toString(), "x\n1\n");
});
test("paths, symlinks, interrupted and oversized streams cannot publish files", async () => {
  const { root, store } = await fixture(); const draft = await store.createDraft("user_a"); const owner = { draftId: draft.id };
  await assert.rejects(store.upload("user_a", owner, "../escape", bytes("bad")), { status: 400 });
  await assert.rejects(store.upload("user_a", owner, "a\\escape", bytes("bad")), { status: 400 });
  await assert.rejects(store.upload("user_a", owner, "large", Readable.from([Buffer.alloc(ATTACHMENT_LIMITS.fileBytes + 1)])), { status: 413 });
  await assert.rejects(store.upload("user_a", owner, "broken", Readable.from((async function* () { yield Buffer.from("partial"); throw new Error("disconnected"); })())));
  assert.equal((await store.draftFiles("user_a", draft.id)).length, 0);
  await symlink(root, join(root, "private", "users", "symlink_user"));
  await assert.rejects(store.createDraft("symlink_user"), { status: 403 });
});
test("originals are immutable, sent removal is rejected and expiry spares sent files", async () => {
  let now = 100; const { store } = await fixture(() => now); const draft = await store.createDraft("user_a");
  const file = await store.upload("user_a", { draftId: draft.id }, "notes.txt", bytes("original"));
  await store.claim("user_a", draft.id, "session_a", [file.id]);
  await store.prepareTurn("user_a", "session_a", { turnId: "turn_a", attachmentIds: [file.id] }, { parts: [{ type: "text", text: "read" }] });
  await store.finishTurn("user_a", "session_a", "turn_a", "accepted");
  const [working] = await store.materialize("user_a", "session_a"); await writeFile(working.path, "changed");
  assert.equal((await readFile(await store.path("user_a", { sessionId: "session_a" }, file.id))).toString(), "original");
  await assert.rejects(store.removePending("user_a", { sessionId: "session_a" }, file.id), { status: 409 });
  now += ATTACHMENT_LIMITS.draftMs + 1; await store.expire();
  assert.equal((await store.get("user_a", { sessionId: "session_a" }, file.id)).size, 8);
});
test("turn retries stay associated and conversation deletion does not delete a fork", async () => {
  const { store } = await fixture(); const draft = await store.createDraft("user_a");
  const file = await store.upload("user_a", { draftId: draft.id }, "notes.txt", bytes("original"));
  await store.claim("user_a", draft.id, "session_a", [file.id]);
  const context = { turnId: "turn_a", attachmentIds: [file.id] }; const prompt = { parts: [{ type: "text", text: "read" }] };
  const turn = await store.prepareTurn("user_a", "session_a", context, prompt); await store.finishTurn("user_a", "session_a", "turn_a", "accepted");
  assert.equal((await store.prepareTurn("user_a", "session_a", context, prompt)).replayAccepted, true);
  await assert.rejects(store.prepareTurn("user_a", "session_a", context, { parts: [] }), { status: 409 });
  const copy = await store.cloneSession("user_a", "session_a", "session_b");
  await store.deleteSession("user_a", "session_a");
  await assert.rejects(store.get("user_a", { sessionId: "session_a" }, file.id), { status: 404 });
  assert.equal(copy.attachments[0].sha256, file.sha256);
  assert.equal((await store.list("user_a", "session_b")).turns[0].messageID, turn.messageID);
});

test("a failed first turn keeps its draft removable after claiming a new conversation", async () => {
  const { store } = await fixture();
  const draft = await store.createDraft("user_a");
  const file = await store.upload("user_a", { draftId: draft.id }, "retry.csv", bytes("value\n2\n4\n"));
  await store.claim("user_a", draft.id, "session_a", [file.id]);
  await store.removePending("user_a", { draftId: draft.id }, file.id);
  await assert.rejects(store.get("user_a", { sessionId: "session_a" }, file.id), { status: 404 });
});

test("restart removes unpublished blobs left by an interrupted metadata write", async () => {
  const { root, store } = await fixture(); const draft = await store.createDraft("user_a");
  const file = await store.upload("user_a", { draftId: draft.id }, "keep.txt", bytes("keep"));
  const orphan = join(root, "private", "users", "user_a", "blobs", "orphan_blob");
  await mkdir(orphan); await writeFile(join(orphan, "original-upload.tmp"), "partial");
  const restarted = new AttachmentStore({ rootDir: join(root, "private") }); await restarted.init();
  await assert.rejects(readFile(join(orphan, "original-upload.tmp")), { code: "ENOENT" });
  assert.equal((await restarted.get("user_a", { draftId: draft.id }, file.id)).sha256, file.sha256);
});

test("a rejected image turn can retry with a supported model without re-uploading", async () => {
  const { store } = await fixture(); const draft = await store.createDraft("user_a");
  const file = await store.upload("user_a", { draftId: draft.id }, "data.csv", bytes("value\n2\n4\n"));
  await store.claim("user_a", draft.id, "session_a", [file.id]);
  const context = { turnId: "turn_retry", attachmentIds: [file.id] };
  const first = await store.prepareTurn("user_a", "session_a", context, { model: "text-only", parts: [{ type: "text", text: "read" }] });
  await store.finishTurn("user_a", "session_a", context.turnId, "rejected");
  const retry = await store.prepareTurn("user_a", "session_a", context, { model: "vision", parts: [{ type: "text", text: "read" }] });
  assert.notEqual(retry.messageID, first.messageID); assert.equal(retry.uncertain, undefined);
  await store.finishTurn("user_a", "session_a", context.turnId, "accepted");
  await assert.rejects(store.prepareTurn("user_a", "session_a", context, { model: "third", parts: [{ type: "text", text: "read" }] }), { status: 409 });
});
