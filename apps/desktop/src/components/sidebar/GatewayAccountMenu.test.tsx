import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { GatewayAccountMenu } from "./GatewayAccountMenu";
import { useRuntimeStore } from "@/lib/runtime";

const navigate = vi.fn();
vi.mock("@/lib/runtime", async () => ({
  ...(await vi.importActual<typeof import("@/lib/runtime")>("@/lib/runtime")),
  signOutPlatformBrowser: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/webMode", () => ({ isGatewayWeb: true, isPlatformWeb: true }));
vi.mock("react-router-dom", async () => ({
  ...(await vi.importActual<typeof import("react-router-dom")>("react-router-dom")),
  useNavigate: () => navigate,
}));

describe("GatewayAccountMenu", () => {
  it.each(["connecting", "error", "offline"] as const)("keeps logout available with unknown identity while %s", status => {
    useRuntimeStore.setState({ status, gatewayUser: null });
    render(<MemoryRouter><GatewayAccountMenu user={null} /></MemoryRouter>);
    expect(screen.getByRole("button", { name: "Sign out" })).toBeEnabled();
    expect(screen.queryByRole("menuitem", { name: "Settings" })).not.toBeInTheDocument();
    expect(screen.queryByText("Admin")).not.toBeInTheDocument();
  });
  it("shows the signed-in identity, admin badge, settings and logout", async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><GatewayAccountMenu user={{ id: "usr_1", username: "alice", role: "admin" }} /></MemoryRouter>);
    expect(screen.getByText("A")).toBeInTheDocument();
    expect(screen.getByText("alice")).toBeInTheDocument();
    expect(screen.getByText("Admin")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "alice account" }));
    expect(screen.getByRole("menuitem", { name: "Sign out" }).closest("form")).toHaveAttribute("action", "/auth/logout");
    await user.click(screen.getByRole("menuitem", { name: "Settings" }));
    expect(navigate).toHaveBeenCalledWith("/settings/models");
  });
  it("can reach sign out with keyboard menu navigation", async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><GatewayAccountMenu user={{ id: "usr_2", username: "bob", role: "user" }} /></MemoryRouter>);
    screen.getByRole("button", { name: "bob account" }).focus();
    await user.keyboard("{Enter}{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Sign out" })).toHaveFocus();
  });
  it.each(["pointer", "keyboard"])("submits logout before removing the form on %s activation", async (activation) => {
    const user = userEvent.setup();
    render(<MemoryRouter><GatewayAccountMenu user={{ id: "usr_3", username: "alice", role: "user" }} /></MemoryRouter>);
    await user.click(screen.getByRole("button", { name: "alice account" }));
    const item = screen.getByRole("menuitem", { name: "Sign out" });
    const form = item.closest("form")!;
    const submissions: boolean[] = [];
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      submissions.push(form.isConnected);
    });
    if (activation === "keyboard") {
      act(() => item.focus());
      await user.keyboard("{Enter}");
    } else {
      await user.click(item);
    }
    expect(submissions).toEqual([true]);
    // jsdom submits even a removed form; a real browser cancels that submission.
    // Keep the form mounted until the browser's navigation takes over.
    expect(form).toBeInTheDocument();
  });
});
