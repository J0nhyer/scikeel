import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,rm,symlink} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {TenantPolicy} from "../src/tenant-policy.mjs";
import {ManagedAttachmentCopies} from "../src/managed-attachment-copies.mjs";
async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),"scikeel-copy-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const account={userId:"a",instanceId:"tenant-a",generation:1,workspaceDir:"/tenant/workspace"};
  const policy=new TenantPolicy({accounts:[account]});policy.registerSession(account,{id:"session-a",directory:"/tenant/workspace/project"});
  const writes=new Map();const calls=[];
  const copies=new ManagedAttachmentCopies({tenantPolicy:policy,resolveContext:async()=>account,files:{call:async(context,request)=>{
    assert.equal(context.userId,"a");calls.push(request);
    if(request.operation==="writeChunk") {
      const previous=writes.get(request.path)??Buffer.alloc(0);assert.equal(previous.length,request.offset);
      writes.set(request.path,Buffer.concat([previous,Buffer.from(request.bytes)]));
    }
    if(request.operation==="remove")writes.delete(request.path);
  }}});
  const bytes=Buffer.alloc(1024*1024+17,255);bytes[0]=0;
  const file={id:"file-a",name:"paper.pdf",size:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex"),sourcePath:join(root,"original")};
  await writeFile(file.sourcePath,bytes);
  return {root,copies,writes,calls,file,bytes};
}
test("binary attachment working copies cross bounded RPC chunks without publishing platform original paths",async(t)=>{
  const f=await fixture(t);const [copy]=await f.copies.materialize({userId:"a",sessionId:"session-a",files:[f.file]});
  assert.ok(copy.path.startsWith("/tenant/workspace/.scikeel/attachments/session-a/"));assert.equal(copy.sourcePath,undefined);
  assert.ok([...f.writes.values()][0].equals(f.bytes));
  assert.ok(f.calls.filter(value=>value.operation==="writeChunk").every(value=>value.bytes.length<=256*1024));
});
test("foreign session, original symlinks and changed source bytes cannot create an accepted copy",async(t)=>{
  const f=await fixture(t);
  await assert.rejects(f.copies.materialize({userId:"b",sessionId:"session-a",files:[f.file]}));
  await assert.rejects(f.copies.materialize({userId:"a",sessionId:"foreign",files:[f.file]}));
  const link=join(f.root,"link");await symlink(f.file.sourcePath,link);
  await assert.rejects(f.copies.materialize({userId:"a",sessionId:"session-a",files:[{...f.file,sourcePath:link}]}));
  await writeFile(f.file.sourcePath,Buffer.alloc(f.file.size));
  await assert.rejects(f.copies.materialize({userId:"a",sessionId:"session-a",files:[f.file]}));assert.equal(f.writes.size,0);
});
