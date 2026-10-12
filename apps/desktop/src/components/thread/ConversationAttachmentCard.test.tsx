import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConversationAttachmentCard } from "./ConversationAttachmentCard";
import { historyToThread } from "@/lib/runtime";
vi.mock("@/lib/conversationAttachments",async(importOriginal)=>({...await importOriginal<typeof import("@/lib/conversationAttachments")>(),attachmentPreviewUrl:vi.fn(async()=>"/api/attachments/read?ticket=one")}));
const file={id:"att_one",name:"data.csv",size:10,mime:"text/csv",sha256:"hash",createdAt:1,sessionId:"session_a"};
beforeEach(()=>vi.clearAllMocks());
describe("persistent conversation attachment cards",()=>{
  it("keeps attachment-only messages in restored history",()=>{
    expect(historyToThread([{id:"msg_one",role:"user",parts:[],attachments:[file]}]).blocks).toMatchObject([{kind:"user",text:"",messageID:"msg_one",attachments:[file]}]);
  });
  it("shows the original size, accessible preview and download",async()=>{
    render(<ConversationAttachmentCard attachment={file} owner={{sessionId:"session_a"}} />);
    expect(screen.getByText("data.csv")).toBeInTheDocument();expect(screen.getByText("10 B")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button",{name:"Preview data.csv"}));
    await waitFor(()=>expect(screen.getByRole("dialog")).toBeInTheDocument());
    expect(screen.getByTitle("data.csv")).toHaveAttribute("sandbox","");
    fireEvent.click(screen.getByRole("button",{name:"Close preview"}));expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

it("keeps image-processing explanations folded without losing download", () => {
  render(<ConversationAttachmentCard attachment={{ ...file, imageDelivery: "resized" }} owner={{ sessionId: "session_a" }} />);
  expect(screen.getByText("Image resized for the model; original retained.")).not.toBeVisible();
  expect(screen.getByRole("button", { name: "Download data.csv" })).toBeEnabled();
});
