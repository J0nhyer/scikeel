import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { GatewayAccountMenu } from "./GatewayAccountMenu";

const navigate = vi.fn();
vi.mock("react-router-dom", async () => ({
  ...(await vi.importActual<typeof import("react-router-dom")>("react-router-dom")),
  useNavigate: () => navigate,
}));

describe("GatewayAccountMenu", () => {
  it("shows the signed-in identity, admin badge, settings and logout", async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><GatewayAccountMenu user={{ id: "usr_1", username: "alice", role: "admin" }} /></MemoryRouter>);
    expect(screen.getByText("A")).toBeInTheDocument();
    expect(screen.getByText("alice")).toBeInTheDocument();
    expect(screen.getByText("Admin")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "alice account" }));
    expect(screen.getByRole("menuitem", { name: "Sign out" }).closest("form")).toHaveAttribute("action", "/auth/logout");
    await user.click(screen.getByRole("menuitem", { name: "Settings" }));
    expect(navigate).toHaveBeenCalledWith("/settings/models");
  });
  it("can reach sign out with keyboard menu navigation", async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><GatewayAccountMenu user={{ id: "usr_2", username: "bob", role: "user" }} /></MemoryRouter>);
    screen.getByRole("button", { name: "bob account" }).focus();
    await user.keyboard("{Enter}{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Sign out" })).toHaveFocus();
  });
});
