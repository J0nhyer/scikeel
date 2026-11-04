import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { useToastStore } from "@/lib/toast";
import { Toaster } from "@/components/ui/Toaster";
import { GatewaySignOut } from "./GatewaySignOut";

const signOut = vi.hoisted(() => vi.fn<() => Promise<void>>());
vi.mock("@/lib/runtime", () => ({ signOutPlatformBrowser: signOut }));
vi.mock("@/lib/webMode", () => ({ isPlatformWeb: true }));
beforeEach(() => { signOut.mockReset().mockResolvedValue(); useToastStore.getState().reset(); });
const renderSignOut = () => render(<><GatewaySignOut /><Toaster /></>);

it("asks before stopping the workspace and coalesces the confirmed submission", async () => {
  let release!: () => void;
  signOut.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
  renderSignOut();
  const button = screen.getByRole("button", { name: "Sign out" });
  const form = button.closest("form")!;
  fireEvent.submit(form); fireEvent.submit(form);
  expect(signOut).not.toHaveBeenCalled();
  expect(screen.getByRole("alertdialog", { name: "Sign out and stop the workspace?" })).toBeInTheDocument();
  const confirm = screen.getByRole("button", { name: "Sign out and stop" });
  fireEvent.click(confirm); fireEvent.click(confirm);
  expect(signOut).toHaveBeenCalledOnce();
  expect(button).toHaveTextContent("Signing out…");
  expect(button).toBeDisabled(); expect(button).toHaveAttribute("aria-busy", "true");
  fireEvent.submit(form);
  expect(signOut).toHaveBeenCalledOnce();
  await act(async () => release());
  expect(button).toBeEnabled();
});

it("cancels without stopping the workspace", async () => {
  const user = userEvent.setup();
  renderSignOut();
  await user.click(screen.getByRole("button", { name: "Sign out" }));
  expect(screen.getByRole("alertdialog", { name: "Sign out and stop the workspace?" }))
    .toHaveTextContent("If this is the last signed-in session, the workspace will stop.");
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  expect(signOut).not.toHaveBeenCalled();
});

it("keeps a failed logout actionable without native form navigation", async () => {
  signOut.mockRejectedValueOnce(new Error("HTTP 502"));
  const user = userEvent.setup();
  renderSignOut();
  const button = screen.getByRole("button", { name: "Sign out" });
  await user.click(button);
  await user.click(screen.getByRole("button", { name: "Sign out and stop" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Could not sign out. Please retry.");
  expect(screen.getByRole("alert")).toHaveAttribute("data-error-card", "true");
  expect(button).toBeEnabled();
  await user.click(button);
  await user.click(screen.getByRole("button", { name: "Sign out and stop" }));
  expect(signOut).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("does not publish local state after unmount while logout is pending", async () => {
  let reject!: (error: Error) => void;
  signOut.mockImplementation(() => new Promise<void>((_resolve, no) => { reject = no; }));
  const view = renderSignOut();
  fireEvent.submit(screen.getByRole("button", { name: "Sign out" }).closest("form")!);
  fireEvent.click(screen.getByRole("button", { name: "Sign out and stop" }));
  view.unmount();
  await act(async () => reject(new Error("HTTP 502")));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("renders the confirmation outside the surrounding form", () => {
  renderSignOut();
  fireEvent.submit(screen.getByRole("button", { name: "Sign out" }).closest("form")!);
  expect(screen.getByRole("alertdialog", { name: "Sign out and stop the workspace?" }).closest("form")).toBeNull();
});

it("keeps a previous failure visible when the retry dialog is cancelled", async () => {
  signOut.mockRejectedValueOnce(new Error("HTTP 502"));
  const user = userEvent.setup();
  renderSignOut();
  await user.click(screen.getByRole("button", { name: "Sign out" }));
  await user.click(screen.getByRole("button", { name: "Sign out and stop" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Could not sign out. Please retry.");
  expect(screen.getByRole("alert")).toHaveAttribute("data-error-card", "true");
  await user.click(screen.getByRole("button", { name: "Sign out" }));
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Could not sign out. Please retry.");
});
