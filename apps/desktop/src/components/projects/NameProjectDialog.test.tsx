import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { NameProjectDialog } from "./NameProjectDialog";
afterEach(cleanup);
const props = () => ({ defaultName: "New project", title: "Name project", subtitle: "Choose a name", busy: false, onSave: vi.fn(), onCancel: vi.fn() });
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
