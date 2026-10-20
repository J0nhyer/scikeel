import { act, cleanup, render, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectEnvironmentPanel } from "./ProjectEnvironmentPanel";
const mocks=vi.hoisted(()=>({describe:vi.fn(),request:vi.fn(),install:vi.fn()}));
vi.mock("@/lib/runtime",()=>({getClient:()=>({describeProjectEnvironment:mocks.describe,requestProjectEnvironment:mocks.request,approveProjectEnvironment:mocks.install})}));
afterEach(()=>{cleanup();vi.resetAllMocks();});
describe("private project environment approvals",()=>{
  it("requires a separate user confirmation and disables installs during an active task",async()=>{
    mocks.describe.mockResolvedValue({venvState:"absent",inputHash:"a".repeat(64),packages:["fixture"],imageDigest:"sha256:"+"b".repeat(64)});
    mocks.request.mockResolvedValue({id:"c".repeat(64),patterns:["fixture"],metadata:{project:"project",operation:"install",inputHash:"a".repeat(64)}});
    mocks.install.mockResolvedValue({selection:{kind:"private"}});
    const view=render(<ProjectEnvironmentPanel sessionId="owned" running={false} visible />);
    fireEvent.click(screen.getByRole("button",{name:"Environment"}));
    fireEvent.click(await screen.findByRole("button",{name:"Prepare private dependencies"}));
    await screen.findByText("Approve installation of these locked dependencies for this project?");
    expect(mocks.install).not.toHaveBeenCalled();
    view.rerender(<ProjectEnvironmentPanel sessionId="owned" running visible />);
    expect(screen.getByRole("button",{name:"Approve and install"})).toBeDisabled();
    view.rerender(<ProjectEnvironmentPanel sessionId="owned" running={false} visible />);
    fireEvent.click(screen.getByRole("button",{name:"Approve and install"}));
    await waitFor(()=>expect(mocks.install).toHaveBeenCalledWith("owned","c".repeat(64)));
  });
  it("makes no environment request before the details are opened",async()=>{
    const view=render(<ProjectEnvironmentPanel sessionId="owned" running={false} visible={false} />);
    expect(mocks.describe).not.toHaveBeenCalled();
    view.rerender(<ProjectEnvironmentPanel sessionId="owned" running={false} visible />);
    await act(async()=>{});
    expect(mocks.describe).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("Shared science environment")).not.toBeInTheDocument();
  });
  it("shows an initial details failure with Retry and Close",async()=>{
    mocks.describe.mockRejectedValueOnce(new Error("Unavailable")).mockResolvedValueOnce({venvState:"absent",inputHash:null,packages:[]});
    render(<ProjectEnvironmentPanel sessionId="owned" running={false} visible />);
    fireEvent.click(screen.getByRole("button",{name:"Environment"}));
    expect(await screen.findByRole("alert")).toHaveTextContent("Environment details could not be loaded.");
    fireEvent.click(screen.getByRole("button",{name:"Retry"}));
    expect(await screen.findByText("Built-in dependencies")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button",{name:"Close"}));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();expect(mocks.describe).toHaveBeenCalledTimes(2);
  });
});
