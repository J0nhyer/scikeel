import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import "@/i18n";
import { useUiStore } from "@/lib/store";
import { AppearancePicker } from "./AppearancePicker";
afterEach(cleanup);
it("offers four exclusive choices, campus decoration, and keyboard selection", () => {
  useUiStore.setState({ theme: "light", campusDecoration: true });
  render(<AppearancePicker />);
  expect(screen.getAllByRole("radio")).toHaveLength(4);
  fireEvent.click(screen.getByRole("radio", { name: "CDUT" }));
  expect(useUiStore.getState().theme).toBe("cdut");
  fireEvent.click(screen.getByRole("switch", { name: "Campus decoration" }));
  expect(useUiStore.getState().campusDecoration).toBe(false);
  fireEvent.keyDown(screen.getByRole("radio", { name: "CDUT" }), { key: "Home" });
  expect(useUiStore.getState().theme).toBe("light");
  expect(screen.queryByRole("switch")).toBeNull();
});
