import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Toaster } from "@/components/ui/Toaster";
import { PdfPreview } from "./PdfPreview";

/** Every page renders through here, tagged with its page number so a test can
 *  tell which pages were actually painted. */
const rendered: number[] = [];
const getPage = vi.fn(async (pageNumber: number) => ({
  getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
  render: () => {
    rendered.push(pageNumber);
    return { promise: Promise.resolve(), cancel: vi.fn() };
  },
}));
const destroy = vi.fn();
const getDocument = vi.fn(() => ({
  promise: Promise.resolve({ numPages: 2, getPage }),
  destroy,
}));
vi.mock("pdfjs-dist", () => ({ GlobalWorkerOptions: {}, getDocument: () => getDocument() }));

/** jsdom has no IntersectionObserver; the preview falls back to painting every
 *  page. This fake lets a test drive which pages are near the viewport. */
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  private readonly callback: IntersectionObserverCallback;
  private readonly elements = new Set<Element>();
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    FakeIntersectionObserver.instances.push(this);
  }
  observe(element: Element) {
    this.elements.add(element);
  }
  unobserve(element: Element) {
    this.elements.delete(element);
  }
  disconnect() {
    this.elements.clear();
  }
  emit(visible: Element[]) {
    this.callback(
      [...this.elements].map((target) => ({
        target,
        isIntersecting: visible.includes(target),
        intersectionRatio: visible.includes(target) ? 1 : 0,
      })) as unknown as IntersectionObserverEntry[],
      this as unknown as IntersectionObserver,
    );
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  rendered.length = 0;
  FakeIntersectionObserver.instances.length = 0;
  getDocument.mockReturnValue({ promise: Promise.resolve({ numPages: 2, getPage }), destroy });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    (() => ({} as CanvasRenderingContext2D)) as unknown as HTMLCanvasElement["getContext"],
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
});

it("stacks every page into one scrollable document", async () => {
  const view = render(<PdfPreview url="/paper.pdf" />);
  expect(await screen.findByRole("img", { name: "PDF page 1 of 2" })).toBeInTheDocument();
  expect(screen.getByRole("img", { name: "PDF page 2 of 2" })).toBeInTheDocument();
  // Without an observer every page is considered on screen and painted.
  await waitFor(() => expect(rendered).toEqual(expect.arrayContaining([1, 2])));
  view.unmount();
  expect(destroy).toHaveBeenCalled();
});

it("scrolls to the requested page instead of replacing the canvas", async () => {
  const view = render(<PdfPreview url="/paper.pdf" />);
  const page2 = await screen.findByRole("img", { name: "PDF page 2 of 2" });
  const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView");

  await userEvent.click(screen.getByRole("button", { name: "Next page" }));

  expect(scrollIntoView.mock.contexts).toContain(page2);
  expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
  expect(screen.getByRole("img", { name: "PDF page 1 of 2" })).toBeInTheDocument();
  view.unmount();
});

it("paints only pages near the viewport and releases far ones", async () => {
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = FakeIntersectionObserver;
  const view = render(<PdfPreview url="/paper.pdf" />);
  const page1 = await screen.findByRole("img", { name: "PDF page 1 of 2" });
  const page2 = screen.getByRole("img", { name: "PDF page 2 of 2" });
  await waitFor(() => expect(FakeIntersectionObserver.instances).toHaveLength(1));
  const observer = FakeIntersectionObserver.instances[0];

  await waitFor(() => expect(rendered).toContain(1));
  expect(rendered).not.toContain(2);

  act(() => observer.emit([page2]));
  await waitFor(() => expect(rendered).toContain(2));
  await waitFor(() => expect(page1.querySelector("canvas")?.width).toBe(0));

  act(() => observer.emit([page1]));
  await waitFor(() => expect(rendered.filter((page) => page === 1)).toHaveLength(2));
  view.unmount();
});

it("shows a load failure instead of leaving an empty preview", async () => {
  getDocument.mockReturnValueOnce({ promise: Promise.reject(new Error("Paper is unavailable")), destroy });
  const view = render(<><PdfPreview url="/missing.pdf" /><Toaster /></>);
  expect(await screen.findByRole("alert")).toHaveTextContent("Paper is unavailable");
  expect(screen.getByRole("alert")).toHaveAttribute("data-error-card", "true");
  expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
  view.unmount();
  expect(destroy).toHaveBeenCalled();
});
