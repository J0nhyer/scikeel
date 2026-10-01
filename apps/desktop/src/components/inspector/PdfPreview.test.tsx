import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { PdfPreview } from "./PdfPreview";

const renderPage = vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() }));
const getPage = vi.fn(async () => ({ getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }), render: renderPage }));
const destroy = vi.fn();
const getDocument = vi.fn(() => ({ promise: Promise.resolve({ numPages: 2, getPage }), destroy }));
vi.mock("pdfjs-dist", () => ({ GlobalWorkerOptions: {}, getDocument: () => getDocument() }));

beforeEach(() => {
  vi.clearAllMocks();
  getDocument.mockReturnValue({ promise: Promise.resolve({ numPages: 2, getPage }), destroy });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => ({} as CanvasRenderingContext2D)) as unknown as HTMLCanvasElement["getContext"]);
});

it("renders a PDF page and supports navigation with bounded canvas size", async () => {
  const view = render(<PdfPreview url="/paper.pdf" />);
  await waitFor(() => expect(getPage).toHaveBeenCalledWith(1));
  await userEvent.click(screen.getByRole("button", { name: "Next page" }));
  await waitFor(() => expect(getPage).toHaveBeenCalledWith(2));
  expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
  expect(screen.getByRole("img", { name: "PDF page 2 of 2" })).toHaveAttribute("width");
  view.unmount();
  expect(destroy).toHaveBeenCalled();
});

it("shows a load failure instead of leaving an empty preview", async () => {
  getDocument.mockReturnValueOnce({ promise: Promise.reject(new Error("Paper is unavailable")), destroy });
  const view = render(<PdfPreview url="/missing.pdf" />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Paper is unavailable");
  expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
  view.unmount();
  expect(destroy).toHaveBeenCalled();
});
