import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useToastStore } from "@/lib/toast";
import { Toaster } from "@/components/ui/Toaster";
import { WebTokenGate } from "./WebTokenGate";

beforeEach(() => useToastStore.getState().reset());
afterEach(() => { vi.unstubAllGlobals(); useToastStore.getState().reset(); });

it("shows a rejected token in the global card", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 401 })));
  const onConnect = vi.fn();
  render(<><WebTokenGate onConnect={onConnect} /><Toaster /></>);
  fireEvent.change(screen.getByPlaceholderText("Access token"), { target: { value: "bad" } });
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Remote access change failed");
  expect(screen.getByRole("alert")).toHaveAttribute("data-error-card", "true");
  expect(onConnect).not.toHaveBeenCalled();
});
