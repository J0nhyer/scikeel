import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { resetPendingSends } from "@/lib/composerStash";
import { Composer } from "./Composer";
const mocks=vi.hoisted(()=>({upload:vi.fn(),remove:vi.fn(async()=>{}),draft:vi.fn(async()=>"draft_one")}));
vi.mock("@/lib/webMode",async(importOriginal)=>({...await importOriginal<typeof import("@/lib/webMode")>(),isGatewayWeb:true}));
vi.mock("@/lib/conversationAttachments",async(importOriginal)=>({...await importOriginal<typeof import("@/lib/conversationAttachments")>(),uploadConversationAttachment:mocks.upload,removePendingAttachment:mocks.remove,createAttachmentDraft:mocks.draft}));
beforeEach(()=>{mocks.upload.mockReset();mocks.remove.mockClear();resetPendingSends();});
describe("Web composer attachments",()=>{
  it("requires nonblank text alongside ready attachments for click and Enter", async () => {
    mocks.upload.mockResolvedValue({ id: "file_text", name: "text.csv", size: 4, mime: "text/csv", sha256: "hash", createdAt: 1 });
    const onSend = vi.fn(async () => false);
    render(<Composer onSend={onSend} draftKey="web_requires_text" />);
    fireEvent.change(screen.getByLabelText("Attach files"), { target: { files: [new File(["data"], "text.csv")] } });
    await waitFor(() => expect(mocks.upload).toHaveBeenCalledOnce());
    for (const value of ["", "   \n "]) {
      fireEvent.change(screen.getByRole("textbox"), { target: { value } });
      expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
      expect(onSend).not.toHaveBeenCalled();
      expect(screen.getByText("text.csv")).toBeInTheDocument();
    }
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Read this" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("Read this", undefined, expect.objectContaining({ attachmentIds: ["file_text"] })));
  });

  it("hides approval switching even when supplied by the session", () => {
    render(<Composer onSend={vi.fn()} approvalMode="full" onApprovalModeChange={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Approval mode" })).not.toBeInTheDocument();
  });
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
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Read the attachment" } });
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
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Read the attachment" } });
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

describe("Web composer send state", () => {
  const startSend = async (onSend: ReturnType<typeof vi.fn>) => {
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "start the analysis" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
    return input;
  };

  it("clears the draft and shows a starting indicator as soon as a send starts", async () => {
    let decide!: (accepted: boolean) => void;
    const onStop = vi.fn();
    const onSend = vi.fn(() => new Promise<boolean>((resolve) => { decide = resolve; }));
    render(<Composer onSend={onSend} onStop={onStop} draftKey="web_sending_start_ready" currentSessionId="session_a" />);

    const input = await startSend(onSend);
    expect(input).toHaveValue("");
    // Admission is not a running turn yet: Stop would abort an idle session
    // while the prompt POST still lands, so only the starting indicator shows.
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(screen.getByRole("status", { name: "Sending" })).toBeInTheDocument();

    await act(async () => decide(true));
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument());
    expect(input).toHaveValue("");
  });

  it("shows a starting status while a first send has no session to stop yet", async () => {
    let decide!: (accepted: boolean) => void;
    const onSend = vi.fn(() => new Promise<boolean>((resolve) => { decide = resolve; }));
    render(<Composer onSend={onSend} draftKey="web_sending_start" />);

    const input = await startSend(onSend);
    expect(input).toHaveValue("");
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(screen.getByRole("status", { name: "Sending" })).toBeInTheDocument();

    await act(async () => decide(true));
  });

  it("restores the draft when a Web send is rejected", async () => {
    let decide!: (accepted: boolean) => void;
    const onSend = vi.fn(() => new Promise<boolean>((resolve) => { decide = resolve; }));
    render(<Composer onSend={onSend} draftKey="web_send_restore" />);

    const input = await startSend(onSend);
    expect(input).toHaveValue("");

    await act(async () => decide(false));
    await waitFor(() => expect(input).toHaveValue("start the analysis"));
  });

  it("keeps an in-flight draft through a remount and restores it on rejection", async () => {
    let decide!: (accepted: boolean) => void;
    const onSend = vi.fn(() => new Promise<boolean>((resolve) => { decide = resolve; }));
    const first = render(<Composer onSend={onSend} draftKey="web_remount_rejected" />);
    const input = await startSend(onSend);
    expect(input).toHaveValue("");

    first.unmount();
    // The first Web send binds the pane to its new session before the prompt
    // is accepted, so this remount is the normal path. `sending` is still true
    // in the runtime store even though this instance never submitted.
    render(<Composer onSend={onSend} draftKey="web_remount_rejected" currentSessionId="remounted_session" sending />);
    const remounted = screen.getByRole("textbox");
    expect(remounted).toHaveValue("");
    expect(screen.getByRole("status", { name: "Sending" })).toBeInTheDocument();

    await act(async () => decide(false));
    await waitFor(() => expect(remounted).toHaveValue("start the analysis"));
  });
});

it("inspects and retires pending uploads by their exact pane key", async () => {
  const { hasPendingComposerAttachments, retireComposerAttachments } = await import("./useComposerAttachments");
  mocks.upload.mockImplementationOnce(() => new Promise(() => {}));
  const surface = render(<Composer onSend={vi.fn()} draftKey="retire_project" />);
  fireEvent.change(screen.getByLabelText("Attach files"), { target: { files: [new File(["x"], "pending.csv")] } });
  await waitFor(() => expect(mocks.upload).toHaveBeenCalled());
  expect(hasPendingComposerAttachments("local:retire_project")).toBe(true);
  act(() => retireComposerAttachments("local:retire_project"));
  expect(hasPendingComposerAttachments("local:retire_project")).toBe(false);
  expect(mocks.remove).not.toHaveBeenCalled();
  surface.unmount();
});
