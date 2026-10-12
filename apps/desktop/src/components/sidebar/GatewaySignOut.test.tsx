import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { GatewaySignOut } from "./GatewaySignOut";

const signOut = vi.hoisted(() => vi.fn<() => Promise<void>>());
vi.mock("@/lib/runtime", () => ({ signOutPlatformBrowser: signOut }));
vi.mock("@/lib/webMode", () => ({ isPlatformWeb: true }));
beforeEach(() => { signOut.mockReset().mockResolvedValue(); });

it("coalesces repeated form submission and keeps the command busy", async () => {
  let release!: () => void;
  signOut.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
  render(<GatewaySignOut />);
  const button = screen.getByRole("button", { name: "Sign out" });
  const form = button.closest("form")!;
  fireEvent.submit(form); fireEvent.submit(form);
  expect(signOut).toHaveBeenCalledOnce();
  expect(button).toBeDisabled(); expect(button).toHaveAttribute("aria-busy", "true");
  await act(async () => release());
  expect(button).toBeEnabled();
});

it("keeps a failed logout actionable without native form navigation", async () => {
  signOut.mockRejectedValueOnce(new Error("HTTP 502"));
  const user = userEvent.setup();
  render(<GatewaySignOut />);
  const button = screen.getByRole("button", { name: "Sign out" });
  await user.click(button);
  expect(screen.getByRole("alert")).toHaveTextContent("Could not sign out. Please retry.");
  expect(button).toBeEnabled();
  await user.click(button);
  expect(signOut).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("does not publish local state after unmount while logout is pending", async () => {
  let reject!: (error: Error) => void;
  signOut.mockImplementation(() => new Promise<void>((_resolve, no) => { reject = no; }));
  const view = render(<GatewaySignOut />);
  fireEvent.submit(screen.getByRole("button", { name: "Sign out" }).closest("form")!);
  view.unmount();
  await act(async () => reject(new Error("HTTP 502")));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
