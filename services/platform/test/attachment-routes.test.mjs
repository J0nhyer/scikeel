import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { AttachmentStore } from "../src/attachments.mjs";
import { createAttachmentRouter } from "../src/attachment-routes.mjs";
const fixtures = [];
afterEach(async () => { for (const f of fixtures.splice(0)) { f.server.closeAllConnections(); await new Promise((r) => f.server.close(r)); await rm(f.root,{recursive:true,force:true}); } });
async function fixture() {
  const root=await mkdtemp(join(tmpdir(),"scikeel-attachment-routes-")); const store=new AttachmentStore({rootDir:root}); await store.init();
  const router=createAttachmentRouter({store,resolveOwner:async (user, sessionId) => { if (sessionId !== `${user.id}_session`) throw Object.assign(new Error("not found"),{status:404}); return {userId:user.id,sessionId}; }});
  const server=createServer(async (req,res) => { const user={id:req.headers["x-test-user"] ?? "user_a"}; try { if (!await router(req,res,user)) {res.writeHead(404); res.end();} } catch(e) {res.writeHead(e.status??500,{"content-type":"application/json"});res.end(JSON.stringify({error:e.message}));} });
  await new Promise((r) => server.listen(0,"127.0.0.1",r)); const base=`http://127.0.0.1:${server.address().port}`; fixtures.push({root,server});return {base,store};
}
test("owner-scoped upload, ticket and byte-identical original downloads",async()=>{
  const {base}=await fixture();const draft=await(await fetch(`${base}/api/attachments/drafts`,{method:"POST"})).json();
  const upload=await fetch(`${base}/api/attachments/upload?draftId=${draft.id}&name=data.csv`,{method:"POST",body:"value\n2\n4\n"});assert.equal(upload.status,201);const file=await upload.json();
  assert.equal(file.size,10);assert.equal(file.mime,"text/csv");assert.equal(JSON.stringify(file).includes("rootDir"),false);
  const issue=await fetch(`${base}/api/attachments/${file.id}/ticket`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({draftId:draft.id,download:true})});assert.equal(issue.status,200);const {ticket}=await issue.json();
  const read=await fetch(`${base}/api/attachments/read?ticket=${ticket}`);assert.equal(await read.text(),"value\n2\n4\n");assert.match(read.headers.get("content-disposition"),/attachment/);
  assert.equal((await fetch(`${base}/api/attachments/read?ticket=${ticket}`,{headers:{"x-test-user":"user_b"}})).status,404);
  assert.equal((await fetch(`${base}/api/attachments/${file.id}?draftId=${draft.id}`,{method:"DELETE",headers:{"x-test-user":"user_b"}})).status,404);
  assert.equal((await fetch(`${base}/api/attachments/${file.id}?draftId=${draft.id}`,{method:"DELETE"})).status,204);
  assert.equal((await fetch(`${base}/api/attachments/read?ticket=${ticket}`)).status,404);
});
test("cross-origin mutation and another conversation cannot claim files",async()=>{
  const {base}=await fixture();assert.equal((await fetch(`${base}/api/attachments/drafts`,{method:"POST",headers:{origin:"https://other.invalid"}})).status,403);
  const draft=await(await fetch(`${base}/api/attachments/drafts`,{method:"POST"})).json();
  const file=await(await fetch(`${base}/api/attachments/upload?draftId=${draft.id}&name=notes.txt`,{method:"POST",body:"hi"})).json();
  const claim=await fetch(`${base}/api/attachments/claim`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({draftId:draft.id,sessionId:"user_b_session",attachmentIds:[file.id]})});assert.equal(claim.status,404);
  assert.equal((await fetch(`${base}/api/attachments/upload?sessionId=user_b_session&name=notes.txt`,{method:"POST",body:"hi"})).status,404);
});
