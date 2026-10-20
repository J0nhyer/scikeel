import { useRef, useState } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { ManagementDialog } from "./ManagementDialog";

afterEach(cleanup);

function Example({ busy = false, removeTrigger = false }: { busy?: boolean; removeTrigger?: boolean }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null), cancel = useRef<HTMLButtonElement>(null);
  return <>
    {(!open || !removeTrigger) && <button ref={trigger} onClick={() => setOpen(true)}>Open</button>}
    {open && <ManagementDialog title="Confirm change" onClose={() => setOpen(false)} dismissible={!busy} initialFocusRef={cancel} returnFocusRef={trigger}>
      <button ref={cancel} onClick={() => setOpen(false)}>Close</button>
    </ManagementDialog>}
  </>;
}

it("keeps an active operation open when Escape is pressed", async () => {
  render(<Example busy/>);
  await userEvent.click(screen.getByRole("button", { name: "Open" }));
  await userEvent.keyboard("{Escape}");
  expect(screen.getByRole("dialog", { name: "Confirm change" })).toBeInTheDocument();
});

it("closes when its original trigger has been removed", async () => {
  render(<Example removeTrigger/>);
  await userEvent.click(screen.getByRole("button", { name: "Open" }));
  await userEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(document.activeElement?.isConnected).toBe(true);
});
