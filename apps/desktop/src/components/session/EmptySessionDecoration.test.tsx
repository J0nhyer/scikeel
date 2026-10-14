import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useUiStore } from "@/lib/store";
import { EmptySessionDecoration } from "./EmptySessionDecoration";
afterEach(cleanup);
it("responds to campus appearance and its persisted decoration preference", () => {
  useUiStore.setState({ theme: "light", campusDecoration: true });
  render(<EmptySessionDecoration />);
  expect(screen.queryByTestId("campus-empty-decoration")).toBeNull();
  act(() => useUiStore.getState().setTheme("cdut"));
  expect(screen.getByTestId("campus-empty-decoration")).toHaveAttribute("aria-hidden", "true");
  act(() => useUiStore.getState().setCampusDecoration(false));
  expect(screen.queryByTestId("campus-empty-decoration")).toBeNull();
  expect(localStorage.getItem("scikeel.campus-decoration.v1")).toBe("0");
});
