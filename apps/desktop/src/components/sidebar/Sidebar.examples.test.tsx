import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { ExampleMenu } from "./ExampleMenu";

const navigateSpy = vi.hoisted(() => vi.fn());
vi.mock("react-router-dom", async (importOriginal) => ({
  ...await importOriginal<typeof import("react-router-dom")>(),
  useNavigate: () => navigateSpy,
}));

describe("ExampleMenu", () => {
  beforeEach(async () => { await i18n.changeLanguage("en"); });

  it("renders nothing when there are no examples", () => {
    const { container } = render(<ExampleMenu examples={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("lists the four examples and navigates on select", async () => {
    render(<ExampleMenu />);
    await userEvent.click(screen.getByRole("button", { name: "Examples" }));
    const items = await screen.findAllByRole("menuitem");
    expect(items).toHaveLength(4);
    expect(screen.getByText("文献综述与引用核查")).toBeInTheDocument();
    await userEvent.click(screen.getByText("文献综述与引用核查"));
    expect(navigateSpy).toHaveBeenCalledWith("/example/lit-review-citations");
  });

  it("keeps the menu inside a phone viewport", async () => {
    render(<ExampleMenu />);
    await userEvent.click(screen.getByRole("button", { name: "Examples" }));
    const menu = await screen.findByRole("menu");
    expect(menu.className).toContain("max-w-[calc(100vw-24px)]");
  });
});
