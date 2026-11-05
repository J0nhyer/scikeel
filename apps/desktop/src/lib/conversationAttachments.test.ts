import { afterEach, describe, expect, it, vi } from "vitest";
import { attachmentRequestKey, uploadConversationAttachment, attachmentPreviewUrl } from "./conversationAttachments";
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
