import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Composer } from "./Composer";
const mocks=vi.hoisted(()=>({upload:vi.fn(),remove:vi.fn(async()=>{}),draft:vi.fn(async()=>"draft_one")}));
vi.mock("@/lib/webMode",async(importOriginal)=>({...await importOriginal<typeof import("@/lib/webMode")>(),isGatewayWeb:true}));
vi.mock("@/lib/conversationAttachments",async(importOriginal)=>({...await importOriginal<typeof import("@/lib/conversationAttachments")>(),uploadConversationAttachment:mocks.upload,removePendingAttachment:mocks.remove,createAttachmentDraft:mocks.draft}));
beforeEach(()=>{mocks.upload.mockReset();mocks.remove.mockClear();});
describe("Web composer attachments",()=>{
  it("keeps text and ready attachments when prompt acceptance fails",async()=>{
    mocks.upload.mockResolvedValue({id:"file_a",name:"data.csv",size:4,mime:"text/csv",sha256:"hash",createdAt:1});
    const onSend=vi.fn(async()=>false);render(<Composer onSend={onSend} currentSessionId="session_a" draftKey="web_retry" />);
    const picker=screen.getByLabelText("Attach files");fireEvent.change(picker,{target:{files:[new File(["x\n1"],"data.csv")]}});
    await screen.findByText("data.csv");await waitFor(()=>expect(mocks.upload).toHaveBeenCalledOnce());
    fireEvent.change(screen.getByRole("textbox"),{target:{value:"calculate"}});
    await waitFor(()=>expect(screen.getByRole("button",{name:"Send"})).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button",{name:"Send"}));await waitFor(()=>expect(onSend).toHaveBeenCalledOnce());
    expect(screen.getByRole("textbox")).toHaveValue("calculate");expect(screen.getByText("data.csv")).toBeInTheDocument();
    expect(onSend.mock.calls[0]).toEqual(["calculate",undefined,expect.objectContaining({attachmentIds:["file_a"]})]);
  });
  it("retains the original draft when a first send creates a session but is rejected", async () => {
    mocks.upload.mockResolvedValue({ id: "file_new", name: "new.csv", size: 4, mime: "text/csv", sha256: "hash", createdAt: 1 });
    let rejectAcceptance!: (accepted: boolean) => void;
    const onSend = vi.fn((_text: string, _names?: string[], _context?: import("@ai4s/shared").AttachmentPromptContext) => new Promise<boolean>((resolve) => { rejectAcceptance = resolve; }));
    const { rerender } = render(<Composer onSend={onSend} draftKey="web_first_retry" />);
    fireEvent.change(screen.getByLabelText("Attach files"), { target: { files: [new File(["x\n1"], "new.csv")] } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
    rerender(<Composer onSend={onSend} draftKey="web_first_retry" currentSessionId="new_session" />);
    await act(async () => rejectAcceptance(false));
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2));
    expect(onSend.mock.calls[1][2]).toEqual(expect.objectContaining({ draftId: "draft_one", attachmentIds: ["file_new"] }));
    await act(async () => rejectAcceptance(false));
  });
  it("keeps a first-send queue when routing remounts the composer onto its created session", async () => {
    mocks.upload.mockResolvedValue({ id: "file_remount", name: "remount.csv", size: 4, mime: "text/csv", sha256: "hash", createdAt: 1 });
    let settle!: (accepted: boolean) => void;
    const onSend = vi.fn(() => new Promise<boolean>((resolve) => { settle = resolve; }));
    const { unmount } = render(<Composer onSend={onSend} draftKey="web_remount" />);
    fireEvent.change(screen.getByLabelText("Attach files"), { target: { files: [new File(["x"], "remount.csv")] } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Send" })); await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
    unmount(); render(<Composer onSend={onSend} draftKey="web_remount" currentSessionId="remounted_session" />);
    await act(async () => settle(false));
    expect(screen.getByRole("button", { name: "Remove remount.csv" })).toBeInTheDocument();
  });
  it("blocks both Enter and send while an upload is pending, and permits removal",async()=>{
    mocks.upload.mockImplementation(()=>new Promise(()=>{}));const onSend=vi.fn();render(<Composer onSend={onSend} draftKey="web_pending" />);
    fireEvent.change(screen.getByLabelText("Attach files"),{target:{files:[new File(["x"],"pending.txt")]}});
    await screen.findByText("pending.txt");fireEvent.change(screen.getByRole("textbox"),{target:{value:"hello"}});fireEvent.keyDown(screen.getByRole("textbox"),{key:"Enter"});
    expect(onSend).not.toHaveBeenCalled();expect(screen.getByRole("button",{name:"Send"})).toBeDisabled();
    fireEvent.click(screen.getByRole("button",{name:"Remove pending.txt"}));expect(screen.queryByText("pending.txt")).not.toBeInTheDocument();
  });
});
