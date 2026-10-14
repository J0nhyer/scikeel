import { afterEach, describe, expect, it, vi } from "vitest";
import { attachmentRequestKey, uploadConversationAttachment, attachmentPreviewUrl } from "./conversationAttachments";
const workspaceHeaders=vi.hoisted(()=>vi.fn(()=>({"x-scikeel-runtime-generation":"7"})));
vi.mock("./webMode",()=>({platformWorkspaceMutationHeaders:workspaceHeaders}));
afterEach(() => vi.unstubAllGlobals());
describe("Web conversation attachment API",()=>{
  it("creates request identifiers without secure-context randomUUID",()=>{
    const a=attachmentRequestKey();expect(a).toMatch(/^turn_[a-f0-9]+$/);expect(attachmentRequestKey()).not.toBe(a);
  });
  it("rejects a file over 25 MiB before starting an upload",async()=>{
    const file=new File([],"large.csv");Object.defineProperty(file,"size",{value:26*1024**2});
    await expect(uploadConversationAttachment({owner:{draftId:"draft_one"},file})).rejects.toThrow(/25 MiB/);
  });
  it("uses an authenticated owner-scoped ticket and never puts bearer tokens in URLs",async()=>{
    const fetch=vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit)=>new Response(JSON.stringify({ticket:"one-file-ticket"}),{status:200}));vi.stubGlobal("fetch",fetch);
    expect(await attachmentPreviewUrl({id:"att_one",name:"data.csv",size:1,mime:"text/csv",sha256:"hash",createdAt:1,sessionId:"session_a"}, {sessionId:"session_a"},true)).toBe("/api/attachments/read?ticket=one-file-ticket");
    expect(fetch.mock.calls[0][1]).toMatchObject({credentials:"same-origin",method:"POST",body:JSON.stringify({sessionId:"session_a",download:true,preview:false})});
  });
});

it("session-owned XHR attachment uploads carry the current workspace generation",async()=>{
  const headers=new Map<string,string>();
  class Upload {
    upload={};withCredentials=false;status=201;responseText=JSON.stringify({id:"att_one"});onload:()=>void=()=>{};
    open(){}setRequestHeader(key:string,value:string){headers.set(key,value);}
    send(){this.onload();}
  }
  vi.stubGlobal("XMLHttpRequest",Upload);
  await uploadConversationAttachment({owner:{sessionId:"session_a"},file:new File(["value\n2\n"],"data.csv")});
  expect(headers.get("x-scikeel-runtime-generation")).toBe("7");
});
