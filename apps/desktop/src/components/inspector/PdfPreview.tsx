import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Loader2, ZoomIn, ZoomOut } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

/** Render one page at a time so phone browsers do not depend on PDF plugins or
 * allocate canvases for an entire paper. */
export function PdfPreview({ url }: { url: string }) {
  const { t } = useTranslation("inspector");
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(600);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    let loading: ReturnType<typeof import("pdfjs-dist").getDocument> | undefined;
    setPdf(null);
    setPage(1);
    setError(null);
    setBusy(true);
    void import("pdfjs-dist").then(async (library) => {
      if (cancelled) return;
      library.GlobalWorkerOptions.workerSrc = workerUrl;
      loading = library.getDocument({ url, isEvalSupported: false, useSystemFonts: true });
      const document = await loading.promise;
      if (!cancelled) setPdf(document);
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

  useEffect(() => {
    if (!pdf) return;
    let cancelled = false;
    let rendering: RenderTask | undefined;
    setBusy(true);
    setError(null);
    void pdf.getPage(page).then(async (documentPage) => {
      if (cancelled || !canvas.current) return;
      const original = documentPage.getViewport({ scale: 1 });
      const scale = Math.max(0.1, (width - 24) / original.width) * zoom;
      const viewport = documentPage.getViewport({ scale });
      const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(6_000_000 / (viewport.width * viewport.height)));
      const target = canvas.current;
      target.width = Math.ceil(viewport.width * ratio);
      target.height = Math.ceil(viewport.height * ratio);
      target.style.width = `${viewport.width}px`;
      target.style.height = `${viewport.height}px`;
      const context = target.getContext("2d");
      if (!context) throw new Error("PDF canvas is unavailable");
      rendering = documentPage.render({ canvasContext: context, viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
      await rendering.promise;
      if (!cancelled) setBusy(false);
    }).catch((e: unknown) => {
      if (!cancelled) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); }
    });
    return () => { cancelled = true; rendering?.cancel(); };
  }, [pdf, page, width, zoom]);

  const button = "flex h-9 w-9 shrink-0 items-center justify-center rounded-input text-text hover:bg-surface-2 disabled:opacity-40";
  return <div ref={container} className="flex min-h-[480px] w-full flex-col bg-surface-2">
    <div className="sticky top-0 z-10 flex items-center justify-center gap-1 border-b border-border bg-surface px-2 py-1">
      <button type="button" className={button} aria-label={t("filePreview.pdfPrevious")} title={t("filePreview.pdfPrevious")} disabled={!pdf || busy || page <= 1} onClick={() => setPage((current) => current - 1)}><ChevronLeft size={16} /></button>
      <input type="number" min={1} max={pdf?.numPages ?? 1} value={page} disabled={!pdf || busy}
        aria-label={t("filePreview.pdfPageNumber")} className="h-8 w-14 rounded-input border border-border bg-surface px-1 text-center text-xs"
        onChange={(event) => { const value = Number(event.target.value); if (Number.isInteger(value) && value >= 1 && value <= (pdf?.numPages ?? 1)) setPage(value); }} />
      <span className="min-w-8 text-xs tabular-nums text-muted">/ {pdf?.numPages ?? "-"}</span>
      <button type="button" className={button} aria-label={t("filePreview.pdfNext")} title={t("filePreview.pdfNext")} disabled={!pdf || busy || page >= pdf.numPages} onClick={() => setPage((current) => current + 1)}><ChevronRight size={16} /></button>
      <button type="button" className={button} aria-label={t("filePreview.pdfZoomOut")} title={t("filePreview.pdfZoomOut")} disabled={!pdf || busy || zoom <= 0.5} onClick={() => setZoom((current) => Math.max(0.5, current - 0.25))}><ZoomOut size={16} /></button>
      <button type="button" className={button} aria-label={t("filePreview.pdfZoomIn")} title={t("filePreview.pdfZoomIn")} disabled={!pdf || busy || zoom >= 2} onClick={() => setZoom((current) => Math.min(2, current + 0.25))}><ZoomIn size={16} /></button>
      {busy && <Loader2 size={14} className="shrink-0 animate-spin text-muted" />}
    </div>
    {error && <div role="alert" className="p-4 text-sm text-error">{error}</div>}
    <div className="min-w-0 overflow-auto p-3">
      <canvas ref={canvas} role="img" aria-label={t("filePreview.pdfPage", { page, total: pdf?.numPages ?? 0 })}
        aria-busy={busy} className="mx-auto block bg-white shadow-sm" hidden={!pdf || !!error} />
    </div>
  </div>;
}
