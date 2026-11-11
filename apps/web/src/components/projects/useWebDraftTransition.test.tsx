import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { useWebDraftTransition } from "./useWebDraftTransition";
import { useRuntimeStore, draftKeyFor } from "@/lib/runtime";
import { useLayoutStore } from "@/lib/layout";
import { parkDraft, resetParkedDrafts } from "@/lib/composerStash";
const prepare = vi.fn(async () => ({ path: "/ws/a" }));
const enter = vi.fn(async () => true);
const original = useRuntimeStore.getState().startDraftInWorkspace;
function Surface() {
  const transition = useWebDraftTransition();
  return <><button onClick={() => void transition.requestTransition(prepare)}>Go</button>{transition.confirmation}</>;
}
beforeEach(() => {
  prepare.mockClear(); enter.mockClear(); resetParkedDrafts();
  useLayoutStore.getState().reset(null);
  useRuntimeStore.setState({ startDraftInWorkspace: enter, webReadOnly: false, gatewayUser: null });
});
afterEach(() => { cleanup(); useRuntimeStore.setState({ startDraftInWorkspace: original }); resetParkedDrafts(); });
it("uses a fresh actual pane key for project entry", async () => {
  const old = useLayoutStore.getState().focusedLeafId!;
  render(<MemoryRouter><Surface /></MemoryRouter>);
  await userEvent.click(screen.getByText("Go"));
  const next = useLayoutStore.getState().focusedLeafId!;
  expect(next).not.toBe(old);
  expect(enter).toHaveBeenCalledWith("/ws/a", draftKeyFor(next));
});
it("cancelling unsent input replacement does not create a project or change the pane", async () => {
  const old = useLayoutStore.getState().focusedLeafId!;
  parkDraft(draftKeyFor(old), { text: "Keep this", files: [] });
  render(<MemoryRouter><Surface /></MemoryRouter>);
  await userEvent.click(screen.getByText("Go"));
  expect(screen.getByRole("alertdialog")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(prepare).not.toHaveBeenCalled();
  expect(useLayoutStore.getState().focusedLeafId).toBe(old);
});
it("excludes duplicate transition requests before preparation settles", async () => {
  let done!: (value: { path: string }) => void;
  prepare.mockImplementationOnce(() => new Promise(resolve => { done = resolve; }));
  render(<MemoryRouter><Surface /></MemoryRouter>);
  await userEvent.click(screen.getByText("Go"));
  await userEvent.click(screen.getByText("Go"));
  expect(prepare).toHaveBeenCalledOnce();
  await act(async () => { done({ path: "/ws/a" }); });
});
it("refuses a read-only transition", async () => {
  useRuntimeStore.setState({ webReadOnly: true });
  render(<MemoryRouter><Surface /></MemoryRouter>);
  await userEvent.click(screen.getByText("Go"));
  expect(prepare).not.toHaveBeenCalled();
});

it("does not replace a newer session navigation on the same leaf after preparation", async () => {
  useLayoutStore.getState().reset("ses_b");
  const leaf = useLayoutStore.getState().focusedLeafId!;
  let done!: (value: { path: string }) => void;
  prepare.mockImplementationOnce(() => new Promise(resolve => { done = resolve; }));
  render(<MemoryRouter><Surface /></MemoryRouter>);
  await userEvent.click(screen.getByText("Go"));
  useLayoutStore.getState().bindSession(leaf, "ses_a");
  await act(async () => { done({ path: "/ws/a" }); });
  expect(enter).not.toHaveBeenCalled();
  expect(useLayoutStore.getState().focusedLeafId).toBe(leaf);
});
