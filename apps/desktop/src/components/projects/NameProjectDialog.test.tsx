import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { NameProjectDialog } from "./NameProjectDialog";
import userEvent from "@testing-library/user-event";
afterEach(cleanup);
const props = () => ({ defaultName: "New project", title: "Name project", subtitle: "Choose a name", busy: false, onSave: vi.fn(), onCancel: vi.fn() });
it("portals outside transformed ancestors and closes on Escape from any control", async () => {
  const values = props();
  const view = render(<div style={{ transform: "translateY(-50%)" }}><NameProjectDialog {...values} /></div>);
  const dialog = screen.getByRole("dialog", { name: values.title });
  expect(view.container).not.toContainElement(dialog);
  expect(dialog).toHaveAttribute("aria-modal", "true");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await userEvent.keyboard("{Escape}");
  expect(values.onCancel).toHaveBeenCalledOnce();
});
it("traps keyboard focus inside the modal", async () => {
  render(<><button>Outside</button><NameProjectDialog {...props()} /></>);
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await userEvent.tab();
  expect(screen.getByRole("textbox")).toHaveFocus();
  await userEvent.tab({ shift: true });
  expect(screen.getByRole("button", { name: "Save" })).toHaveFocus();
});
it("retains the typed name with a creation error and refuses whitespace", () => {
  const values = props();
  const { rerender } = render(<NameProjectDialog {...values} />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Reef survey" } });
  rerender(<NameProjectDialog {...values} error="Request failed" />);
  expect(screen.getByRole("textbox")).toHaveValue("Reef survey");
  expect(screen.getByRole("alert")).toHaveTextContent("Request failed");
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "  " } });
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
});
it("prevents Escape and duplicate submit while busy", () => {
  const values = props(); render(<NameProjectDialog {...values} busy />);
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  expect(values.onCancel).not.toHaveBeenCalled(); expect(values.onSave).not.toHaveBeenCalled();
});
it("locks the name and changes Save to entry retry once a project exists", () => {
  const values = props(); render(<NameProjectDialog {...values} created />);
  expect(screen.getByRole("textbox")).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Retry opening" }));
  expect(values.onSave).toHaveBeenCalledWith("New project");
});
