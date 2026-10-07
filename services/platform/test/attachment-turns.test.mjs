import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, test } from "node:test";
import { AttachmentStore } from "../src/attachments.mjs";
import { ATTACHMENT_MARKER, AttachmentTurns } from "../src/attachment-turns.mjs";
const roots=[];afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
test("sent metadata and file inventory survive a follow-up without new uploads",async()=>{
  const root=await mkdtemp(join(tmpdir(),"scikeel-turns-"));roots.push(root);const store=new AttachmentStore({rootDir:root});await store.init();
  const user={id:"user_a"},owner={sessionId:"session_a"};const draft=await store.createDraft(user.id);
  const file=await store.upload(user.id,{draftId:draft.id},"data.csv",Readable.from(["value\n2\n4\n"]));
  const history=[];const turns=new AttachmentTurns({store,readHistory:async()=>history});
  const first=await turns.prepare(user,owner,{parts:[{type:"text",text:"mean?"}],attachmentTurn:{turnId:"turn_one",draftId:draft.id,attachmentIds:[file.id]}});
  assert.match(first.body.system,/data.csv/);assert.equal(first.body.parts[0].text,"mean?");
  assert.equal(first.body.parts.filter((part) => part.synthetic && part.text?.startsWith(ATTACHMENT_MARKER)).length, 1);
  await first.finish(true);history.push({info:{id:first.body.messageID,role:"user"},parts:first.body.parts});
  const replay=await turns.prepare(user,owner,{parts:[{type:"text",text:"mean?"}],attachmentTurn:{turnId:"turn_one",draftId:draft.id,attachmentIds:[file.id]}});assert.equal(replay.replayAccepted,true);
  const follow=await turns.prepare(user,owner,{parts:[{type:"text",text:"read it again"}],attachmentTurn:{turnId:"turn_two",attachmentIds:[]}});
  assert.match(follow.body.system,/data.csv/);
  assert.equal(follow.body.parts.some((part) => part.synthetic && part.text?.startsWith(ATTACHMENT_MARKER)), false);
  await follow.finish(true);
  const decorated=await turns.decorate(user,owner,[{info:{id:first.body.messageID,role:"user"},parts:[{type:"text",text:"mean?"}]}]);
  assert.equal(decorated[0].attachments[0].sha256,file.sha256);assert.equal(decorated[0].attachments[0].name,"data.csv");
});

test("a reverted later attachment is retained but excluded from an earlier turn's input", async () => {
  const root = await mkdtemp(join(tmpdir(), "scikeel-reverted-")); roots.push(root);
  const store = new AttachmentStore({ rootDir: root }); await store.init();
  const user = { id: "user_a" }, owner = { sessionId: "session_a" }, history = [];
  const turns = new AttachmentTurns({ store, readHistory: async () => history });
  const draft = await store.createDraft(user.id);
  for (const [name, turnId] of [["earlier.csv", "turn_one"], ["later.csv", "turn_two"]]) {
    const file = await store.upload(user.id, { draftId: draft.id }, name, Readable.from(["value\n2\n"]));
    const prepared = await turns.prepare(user, owner, { parts: [{ type: "text", text: "read" }], attachmentTurn: { turnId, draftId: draft.id, attachmentIds: [file.id] } });
    await prepared.finish(true); history.push({ info: { id: prepared.body.messageID, role: "user" }, parts: prepared.body.parts });
  }
  const follow = await turns.prepare(user, { ...owner, revertMessageID: history[1].info.id }, { parts: [{ type: "text", text: "continue earlier" }], attachmentTurn: { turnId: "turn_three", attachmentIds: [] } });
  assert.match(follow.body.system, /earlier.csv/); assert.doesNotMatch(follow.body.system, /later.csv/);
  assert.equal(follow.body.parts.some((part) => part.synthetic && part.text?.startsWith(ATTACHMENT_MARKER)), false);
  assert.equal((await store.list(user.id, owner.sessionId)).attachments.length, 2);
  await follow.finish(true);
});

async function turnFixture() {
  const root = await mkdtemp(join(tmpdir(), "scikeel-empty-marker-"));
  roots.push(root);
  const store = new AttachmentStore({ rootDir: root });
  await store.init();
  const user = { id: "user_a" };
  const owner = { sessionId: "session_a" };
  const history = [];
  const turns = new AttachmentTurns({ store, readHistory: async () => history });
  return { store, user, owner, history, turns };
}

for (const attachmentIds of [[], undefined]) {
  test(`empty attachment context preserves a greeting (${attachmentIds ? "explicit" : "normalized"})`, async () => {
    const { store, user, owner, turns } = await turnFixture();
    const parts = [{ type: "text", text: "你好" }];
    const prompt = {
      system: "Keep answers concise.", parts,
      attachmentTurn: { turnId: "turn_hello", attachmentIds },
    };
    const prepared = await turns.prepare(user, owner, prompt);
    assert.deepEqual(prepared.body.parts, parts);
    assert.equal(prepared.body.system, prompt.system);
    assert.equal(prepared.body.messageID, prepared.turn.messageID);
    assert.equal(prepared.files.length, 0);
    assert.equal(prepared.metadata.length, 0);
    await prepared.finish(true);
    const replay = await turns.prepare(user, owner, prompt);
    assert.equal(replay.replayAccepted, true);
    assert.equal((await store.list(user.id, owner.sessionId)).turns.length, 1);
  });
}

test("an uncertain empty turn reconciles by message ID without a marker", async () => {
  const { user, owner, history, turns } = await turnFixture();
  const prompt = {
    parts: [{ type: "text", text: "你好" }],
    attachmentTurn: { turnId: "turn_uncertain", attachmentIds: [] },
  };
  const prepared = await turns.prepare(user, owner, prompt);
  prepared.abandon();
  await assert.rejects(
    turns.prepare(user, owner, prompt),
    (error) => error.code === "turn_uncertain",
  );
  history.push({ info: { id: prepared.body.messageID, role: "user" }, parts: prepared.body.parts });
  const recovered = await turns.prepare(user, owner, prompt);
  assert.equal(recovered.replayAccepted, true);
});

test("a fresh text request without attachment context keeps the existing bypass", async () => {
  const { user, owner, turns } = await turnFixture();
  assert.equal(await turns.prepare(user, owner, { parts: [{ type: "text", text: "你好" }] }), null);
});

test("legacy markers preserve forked file association without marking the new empty turn", async () => {
  const { store, user, owner, history, turns } = await turnFixture();
  const file = await store.upload(user.id, { sessionId: owner.sessionId }, "data.csv", Readable.from(["value\n2\n4\n"]));
  const first = await turns.prepare(user, owner, {
    parts: [{ type: "text", text: "read this file" }],
    attachmentTurn: { turnId: "turn_file", attachmentIds: [file.id] },
  });
  await first.finish(true);
  const forkOwner = { sessionId: "session_fork" };
  await store.cloneSession(user.id, owner.sessionId, forkOwner.sessionId, [first.body.messageID]);
  const legacyParts = [
    { type: "text", text: "read this file" },
    { type: "text", synthetic: true, text: `${ATTACHMENT_MARKER}turn_file` },
  ];
  history.push({ info: { id: "msg_remapped_fork", role: "user" }, parts: legacyParts });
  const follow = await turns.prepare(user, forkOwner, {
    parts: [{ type: "text", text: "read it again" }],
    attachmentTurn: { turnId: "turn_follow", attachmentIds: [] },
  });
  assert.match(follow.body.system, /data.csv/);
  assert.equal(follow.files[0].sha256, file.sha256);
  assert.notEqual(follow.files[0].id, file.id);
  assert.equal(follow.body.parts.length, 1);
  const decorated = await turns.decorate(user, forkOwner, history);
  assert.equal(decorated[0].attachments[0].sha256, file.sha256);
  assert.deepEqual(decorated[0].parts, [{ type: "text", text: "read this file" }]);
  assert.deepEqual(history[0].parts, legacyParts);
  await follow.finish(true);
});
