import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, test } from "node:test";
import { AttachmentStore } from "../src/attachments.mjs";
import { AttachmentTurns } from "../src/attachment-turns.mjs";
const roots=[];afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
test("sent metadata and file inventory survive a follow-up without new uploads",async()=>{
  const root=await mkdtemp(join(tmpdir(),"scikeel-turns-"));roots.push(root);const store=new AttachmentStore({rootDir:root});await store.init();
  const user={id:"user_a"},owner={sessionId:"session_a"};const draft=await store.createDraft(user.id);
  const file=await store.upload(user.id,{draftId:draft.id},"data.csv",Readable.from(["value\n2\n4\n"]));
  const history=[];const turns=new AttachmentTurns({store,readHistory:async()=>history});
  const first=await turns.prepare(user,owner,{parts:[{type:"text",text:"mean?"}],attachmentTurn:{turnId:"turn_one",draftId:draft.id,attachmentIds:[file.id]}});
  assert.match(first.body.system,/data.csv/);assert.equal(first.body.parts[0].text,"mean?");
  await first.finish(true);history.push({info:{id:first.body.messageID,role:"user"},parts:first.body.parts});
  const replay=await turns.prepare(user,owner,{parts:[{type:"text",text:"mean?"}],attachmentTurn:{turnId:"turn_one",draftId:draft.id,attachmentIds:[file.id]}});assert.equal(replay.replayAccepted,true);
  const follow=await turns.prepare(user,owner,{parts:[{type:"text",text:"read it again"}],attachmentTurn:{turnId:"turn_two",attachmentIds:[]}});
  assert.match(follow.body.system,/data.csv/);await follow.finish(true);
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
  assert.equal((await store.list(user.id, owner.sessionId)).attachments.length, 2);
  await follow.finish(true);
});
