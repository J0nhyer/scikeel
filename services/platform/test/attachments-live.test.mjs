import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { AttachmentStore } from "../src/attachments.mjs";
import { AttachmentTurns } from "../src/attachment-turns.mjs";
import { CliRuntimeManager } from "../src/cli-runtime.mjs";
test("real configured assistants consume image pixels and retained CSV content",{skip:!process.env.OSD_ATTACHMENTS_LIVE,timeout:180000},async()=>{
  const envText=execFileSync("sudo",["-n","cat","/etc/osd-platform.env"],{encoding:"utf8"});
  const env=Object.fromEntries(envText.split("\n").filter((line)=>line && !line.startsWith("#") && line.includes("=")).map((line)=>{const i=line.indexOf("=");return [line.slice(0,i),line.slice(i+1).replace(/^['"]|['"]$/g,"")];}));
  const root=await mkdtemp(join(tmpdir(),"scikeel-attachments-live-"));
  const manager=new CliRuntimeManager({rootDir:join(root,"cli"),codexHome:env.PLATFORM_CODEX_HOME,codexCommand:env.PLATFORM_CODEX_BIN||"codex",claudeConfigDir:env.PLATFORM_CLAUDE_CONFIG_DIR,claudeCommand:env.PLATFORM_CLAUDE_BIN||"claude",turnTimeoutMs:90000});
  const store=new AttachmentStore({rootDir:join(root,"attachments")});
  try{
    await manager.init();await store.init();const selected=(process.env.OSD_ATTACHMENTS_LIVE_RUNTIME||"codex").split(",");
    for(const runtime of selected){
      const user={id:`live_attachment_${runtime}`};await manager.setUserRuntime(user.id,runtime,runtime === "codex" ? (process.env.OSD_ATTACHMENTS_LIVE_MODEL || "gpt-5.6-sol") : process.env.OSD_ATTACHMENTS_LIVE_CLAUDE_MODEL);const directory=join(root,`workspace-${runtime}`);await mkdir(directory);const session=await manager.createSession({userId:user.id,workspaceDir:directory});
      const owner={sessionId:session.id};const draft=await store.createDraft(user.id);const png=await readFile(resolve("../../.deploy/verification/attachment-figure.png"));
      const image=await store.upload(user.id,{draftId:draft.id},"figure.png",Readable.from([png]));const csv=await store.upload(user.id,{draftId:draft.id},"data.csv",Readable.from(["value\n2\n4\n"]));
      const pdf=await store.upload(user.id,{draftId:draft.id},"paper.pdf",Readable.from([await readFile(resolve("../../.deploy/verification/attachment-paper.pdf"))]));
      const turns=new AttachmentTurns({store,readHistory:async()=>session.history});
      const ask=async(text,ids,turnId)=>{
        const prepared=await turns.prepare(user,owner,{parts:[{type:"text",text}],attachmentTurn:{draftId:draft.id,turnId,attachmentIds:ids}});
        await manager.sendPrompt({userId:user.id,sessionId:session.id,text:`${prepared.body.system}\n${prepared.displayText}`,displayText:prepared.displayText,attachmentInput:prepared,variant:runtime === "codex" ? "low" : undefined});await prepared.finish(true);
        const deadline=Date.now()+95000;while(session.status!=="idle" && Date.now()<deadline)await new Promise((done)=>setTimeout(done,300));
        assert.equal(session.status,"idle");const message=session.history.at(-1);assert.equal(message.info.role,"assistant");assert.equal(message.info.error,undefined);
        return message.parts.filter((p)=>p.type==="text").map((p)=>p.text).join("\n");
      };
      const first=await ask("Describe the shape and its color in the attached image, quote the exact visible phrase, read the attached CSV to calculate its arithmetic mean, and quote the exact text in the attached PDF by reading its contents. Reply concisely in English. Do not infer image contents from its filename.",[image.id,csv.id,pdf.id],"turn_live_first");
      assert.match(first,/blue/i);assert.match(first,/triangle/i);assert.match(first,/KEEL\s*47/i);assert.match(first,/3/);assert.match(first,/keel paper 47/i);
      const follow=await ask("Read the same retained CSV again using its file contents and report its two values and their sum. No new files were uploaded.",[],"turn_live_follow");assert.match(follow,/2/);assert.match(follow,/4/);assert.match(follow,/6/);
      console.log(`${runtime}: actual image identified and retained CSV follow-up passed`);
    }
  }finally{await manager.close();await store.close();await rm(root,{recursive:true,force:true});}
});
