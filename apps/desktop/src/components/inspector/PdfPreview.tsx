import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Loader2, ZoomIn, ZoomOut } from "lucide-react";
import { ErrorNotice } from "@/components/ui/ErrorNotice";
import { useTranslation } from "react-i18next";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

/** Page gutter on each side of the stack (`p-3`). */
const PAGE_GUTTER = 24;
/** Render pages this far outside the viewport, so scrolling reveals paper
 *  rather than a blank slot. Keeps at most a handful of canvases alive. */
const PRELOAD_MARGIN = "600px 0px";
/** Keep a zoomed page under the 6-megapixel canvas budget. */
const MAX_PAGE_PIXELS = 6_000_000;

type PageSize = { width: number; height: number };

/** Every page is stacked in one document. Pages near the viewport paint into a
 *  canvas; pages that leave release their pixels, so a long paper costs a few
 *  screens of memory rather than one canvas per page. */
export function PdfPreview({ url }: { url: string }) {
  const { t } = useTranslation("inspector");
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [sizes, setSizes] = useState<PageSize[] | null>(null);
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(600);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [visible, setVisible] = useState<Set<number>>(() => new Set([1]));
  const container = useRef<HTMLDivElement>(null);
  const pageSlots = useRef<(HTMLDivElement | null)[]>([]);
  /** Where the current page sat in the pane before a zoom changed every page's
   *  height, so the reader stays on the same paragraph instead of being thrown
   *  back a couple of pages. */
  const zoomAnchor = useRef<{ page: number; offset: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    let loading: ReturnType<typeof import("pdfjs-dist").getDocument> | undefined;
    setPdf(null);
    setSizes(null);
    setCurrentPage(1);
    setVisible(new Set([1]));
    setError(null);
    setBusy(true);
    void import("pdfjs-dist").then(async (library) => {
      if (cancelled) return;
      library.GlobalWorkerOptions.workerSrc = workerUrl;
      loading = library.getDocument({ url, isEvalSupported: false, useSystemFonts: true });
      const document = await loading.promise;
      // Measure every page up front so the stack has stable heights before a
      // page is painted; scrolling never jumps as canvases come and go.
      const measured = await Promise.all(
        Array.from({ length: document.numPages }, (_, index) =>
          document.getPage(index + 1).then((page) => {
            const viewport = page.getViewport({ scale: 1 });
            return { width: viewport.width, height: viewport.height };
          }),
        ),
      );
      if (!cancelled) {
        setPdf(document);
        setSizes(measured);
        setBusy(false);
      }
    }).catch((e: unknown) => {
      if (!cancelled) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); }
    });
    return () => { cancelled = true; void loading?.destroy(); };
  }, [url]);

  useEffect(() => {
    const target = container.current;
    if (!target) return;
    const observer = new ResizeObserver(([entry]) => { if (entry.contentRect.width > 0) setWidth(entry.contentRect.width); });
    observer.observe(target);
    return () => observer.disconnect();
  }, []);

  // One observer for the whole stack: it decides which pages paint and which
  // page the toolbar calls current. Far pages stop painting and free their
  // canvases, which is what keeps phone browsers alive on a long paper.
  useEffect(() => {
    if (!pdf || !sizes) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(new Set(Array.from({ length: pdf.numPages }, (_, index) => index + 1)));
      return;
    }
    const ratios = new Map<number, number>();
    const observer = new IntersectionObserver((entries) => {
      setVisible((current) => {
        const next = new Set(current);
        for (const entry of entries) {
          const page = Number((entry.target as HTMLElement).dataset.page);
          if (entry.isIntersecting) next.add(page);
          else next.delete(page);
        }
        return next;
      });
      for (const entry of entries) {
        const page = Number((entry.target as HTMLElement).dataset.page);
        ratios.set(page, entry.isIntersecting ? entry.intersectionRatio : 0);
      }
      let bestPage = 0;
      let bestRatio = 0;
      for (const [page, ratio] of ratios) {
        if (ratio > bestRatio) { bestPage = page; bestRatio = ratio; }
      }
      if (bestPage > 0) setCurrentPage(bestPage);
    }, { rootMargin: PRELOAD_MARGIN, threshold: [0, 0.25, 0.5, 0.75, 1] });
    for (const slot of pageSlots.current) if (slot) observer.observe(slot);
    return () => observer.disconnect();
  }, [pdf, sizes]);

  const scrollToPage = (page: number) => {
    const total = pdf?.numPages ?? 1;
    const target = Math.min(total, Math.max(1, page));
    pageSlots.current[target - 1]?.scrollIntoView({ block: "start", inline: "nearest", behavior: "smooth" });
    setCurrentPage(target);
  };

  const changeZoom = (next: number) => {
    const slot = pageSlots.current[currentPage - 1];
    const scroller = slot ? scrollParent(slot) : null;
    zoomAnchor.current = slot && scroller
      ? { page: currentPage, offset: slot.getBoundingClientRect().top - scroller.getBoundingClientRect().top }
      : null;
    setZoom(next);
  };

  // Re-apply the page offset after the stack has been laid out at the new
  // zoom. The browser's scroll anchoring does not cover a height change this
  // large across a whole document.
  useLayoutEffect(() => {
    const pending = zoomAnchor.current;
    if (!pending) return;
    zoomAnchor.current = null;
    const slot = pageSlots.current[pending.page - 1];
    const scroller = slot ? scrollParent(slot) : null;
    if (!slot || !scroller) return;
    const offset = slot.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    scroller.scrollTop += offset - pending.offset;
  }, [zoom]);

  const button = "flex h-9 w-9 shrink-0 items-center justify-center rounded-input text-text hover:bg-surface-2 disabled:opacity-40";
  return <div ref={container} className="flex min-h-[480px] w-full flex-col bg-surface-2">
    <div className="sticky top-0 z-10 flex items-center justify-center gap-1 border-b border-border bg-surface px-2 py-1">
      <button type="button" className={button} aria-label={t("filePreview.pdfPrevious")} title={t("filePreview.pdfPrevious")} disabled={!pdf || busy || currentPage <= 1} onClick={() => scrollToPage(currentPage - 1)}><ChevronLeft size={16} /></button>
      <input type="number" min={1} max={pdf?.numPages ?? 1} value={currentPage} disabled={!pdf || busy}
        aria-label={t("filePreview.pdfPageNumber")} className="h-8 w-14 rounded-input border border-border bg-surface px-1 text-center text-xs"
        onChange={(event) => { const value = Number(event.target.value); if (Number.isInteger(value) && value >= 1 && value <= (pdf?.numPages ?? 1)) scrollToPage(value); }} />
      <span className="min-w-8 text-xs tabular-nums text-muted">/ {pdf?.numPages ?? "-"}</span>
      <button type="button" className={button} aria-label={t("filePreview.pdfNext")} title={t("filePreview.pdfNext")} disabled={!pdf || busy || currentPage >= (pdf?.numPages ?? 1)} onClick={() => scrollToPage(currentPage + 1)}><ChevronRight size={16} /></button>
      <button type="button" className={button} aria-label={t("filePreview.pdfZoomOut")} title={t("filePreview.pdfZoomOut")} disabled={!pdf || busy || zoom <= 0.5} onClick={() => changeZoom(Math.max(0.5, zoom - 0.25))}><ZoomOut size={16} /></button>
      <button type="button" className={button} aria-label={t("filePreview.pdfZoomIn")} title={t("filePreview.pdfZoomIn")} disabled={!pdf || busy || zoom >= 2} onClick={() => changeZoom(Math.min(2, zoom + 0.25))}><ZoomIn size={16} /></button>
      {busy && <Loader2 size={14} className="shrink-0 animate-spin text-muted" />}
    </div>
    {error && <ErrorNotice issueId={`pdf:${url}:${error}`} summary={error} />}
    <div className="min-w-0 p-3">
      {pdf && sizes && sizes.map((size, index) => {
        const pageNumber = index + 1;
        const scale = Math.max(0.1, (width - PAGE_GUTTER) / size.width) * zoom;
        return (
          <div
            key={pageNumber}
            ref={(element) => { pageSlots.current[index] = element; }}
            data-page={pageNumber}
            role="img"
            aria-label={t("filePreview.pdfPage", { page: pageNumber, total: pdf.numPages })}
            className="relative mx-auto mb-3 bg-white shadow-sm scroll-mt-12"
            style={{ width: `${size.width * scale}px`, height: `${size.height * scale}px` }}
          >
            <PdfPageCanvas pdf={pdf} pageNumber={pageNumber} scale={scale} active={visible.has(pageNumber)} />
          </div>
        );
      })}
    </div>
  </div>;
}

/** The nearest ancestor that scrolls vertically — the inspector body on a
 *  session page, or the attachment card in a conversation. */
function scrollParent(element: HTMLElement): HTMLElement | null {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const overflowY = getComputedStyle(parent).overflowY;
    if ((overflowY === "auto" || overflowY === "scroll") && parent.scrollHeight > parent.clientHeight) return parent;
  }
  return null;
}

/** One page's canvas. It paints while `active` and releases its drawing buffer
 *  once the page is far enough away to re-render on approach. */
function PdfPageCanvas({
  pdf,
  pageNumber,
  scale,
  active,
}: {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  active: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    const target = canvas.current;
    if (!active || !target) return;
    let cancelled = false;
    let rendering: RenderTask | undefined;
    setFailure(null);
    void pdf.getPage(pageNumber).then(async (documentPage) => {
      if (cancelled || !canvas.current) return;
      const viewport = documentPage.getViewport({ scale });
      // Bound the drawing buffer: a zoomed page on a high-DPI screen must not
      // allocate hundreds of megabytes per canvas.
      const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(MAX_PAGE_PIXELS / (viewport.width * viewport.height)));
      const current = canvas.current;
      current.width = Math.ceil(viewport.width * ratio);
      current.height = Math.ceil(viewport.height * ratio);
      const context = current.getContext("2d");
      if (!context) throw new Error("PDF canvas is unavailable");
      rendering = documentPage.render({ canvasContext: context, viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
      await rendering.promise;
    }).catch((e: unknown) => {
      if (!cancelled) setFailure(e instanceof Error ? e.message : String(e));
    });
    return () => { cancelled = true; rendering?.cancel(); };
  }, [pdf, pageNumber, scale, active]);

  // Free the pixels of every page outside the preload margin.
  useEffect(() => {
    if (active) return;
    const target = canvas.current;
    if (target) { target.width = 0; target.height = 0; }
  }, [active]);

  return <>
    <canvas ref={canvas} className="block h-full w-full" hidden={failure !== null} />
    {failure && <div className="absolute inset-0 overflow-hidden bg-surface p-3"><ErrorNotice issueId={`pdf-page:${pageNumber}:${failure}`} summary={failure} /></div>}
  </>;
}
