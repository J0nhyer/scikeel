import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { CollaborationPicker } from "./CollaborationPicker";
describe("collaboration mode availability", () => {
  it("selects Delegated without starting an execution", async () => {
    const select = vi.fn();
    render(
      <CollaborationPicker
        mode="collaborative"
        disabled={false}
        onSelect={select}
      />,
    );
    await userEvent.setup().click(
      screen.getByRole("button", {
        name: "Autonomy: Medium",
      }),
    );
    expect(screen.getByRole("menuitem", { name: /^Low$/ })).not.toHaveAttribute("data-disabled");
    expect(
      screen.getByRole("menuitem", { name: /^High$/ }),
    ).not.toHaveAttribute("data-disabled");
    expect(screen.getAllByRole("menuitem").map(item => item.textContent)).toEqual(["Low", "Medium", "High", "Full"]);
    expect(select).not.toHaveBeenCalled();
    await userEvent.setup().click(screen.getByRole("menuitem", { name: /^High$/ }));
    expect(select).toHaveBeenCalledWith("delegated");
  });
});
