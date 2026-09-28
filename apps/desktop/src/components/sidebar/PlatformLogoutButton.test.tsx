import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PlatformLogoutButton } from "./PlatformLogoutButton";

describe("PlatformLogoutButton", () => {
  it("submits to the platform logout endpoint", () => {
    render(<PlatformLogoutButton />);

    const button = screen.getByRole("button", { name: "Sign out" });
    const form = button.closest("form");
    expect(form).toHaveAttribute("action", "/auth/logout");
    expect(form).toHaveAttribute("method", "post");
  });
});
