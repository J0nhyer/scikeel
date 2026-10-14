import type { HistoryMessage } from "@ai4s/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { interactionDraftIdentity, interactionFailure, loadInteractionDraft, questionReceipt, saveInteractionDraft } from "./interactionState";
beforeEach(()=>{localStorage.clear();vi.restoreAllMocks();});
describe("interaction drafts and outcomes",()=>{
  it("isolates accounts and sessions and persists selections and free text",()=>{
    const key=interactionDraftIdentity("a","session","question");
    const draft={selected:{0:["A"]},custom:{1:"My answer"}};
    saveInteractionDraft(key,draft);expect(loadInteractionDraft(key)).toEqual(draft);
    expect(loadInteractionDraft(interactionDraftIdentity("b","session","question"))).toBeUndefined();
    expect(loadInteractionDraft(interactionDraftIdentity("a","other","question"))).toBeUndefined();
  });
  it("does not mistake a generic 400 or 404 for a resolved answer",()=>{
    expect(interactionFailure({status:400}).status).toBe("retryable");
    expect(interactionFailure({status:404}).status).toBe("retryable");
    expect(interactionFailure({status:400,code:"QuestionNotFoundError"}).status).toBe("expired");
    expect(interactionFailure(new Error("connection lost")).status).toBe("unknown");
  });
  it("ignores malformed stored drafts",()=>{
    localStorage.setItem("scikeel.interaction-drafts.v1",JSON.stringify([{identity:"bad",updatedAt:Date.now(),draft:{selected:{0:[123]},custom:{}}}]));
    expect(loadInteractionDraft("bad")).toBeUndefined();
  });
});

it("requires the exact question tool and answers to confirm a lost acknowledgement",()=>{
 const request={type:"question.asked" as const,sessionId:"session",requestId:"question",questions:[],tool:{messageID:"message",callID:"call"}};
 const history: HistoryMessage[] = [{id:"message",role:"assistant" as const,parts:[{type:"tool",tool:"question",callID:"call",state:{status:"completed",metadata:{answers:[["A"]]}}}]}];
 expect(questionReceipt(history,request,[["A"]])).toBe(true);
 expect(questionReceipt(history,request,[["B"]])).toBe(false);
 expect(questionReceipt(history,{...request,tool:{messageID:"other",callID:"call"}},[["A"]])).toBe(false);
 expect(questionReceipt(history,{...request,tool:undefined},[["A"]])).toBe(false);
});
