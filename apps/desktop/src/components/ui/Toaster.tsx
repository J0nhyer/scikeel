import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { CheckCircle2, X, XCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast, useToastStore, type Toast } from "@/lib/toast";
import { MAX_VISIBLE_FEEDBACK } from "@/lib/notificationPolicy";
import { cn } from "@/lib/cn";

function Notification({ item, region }: { item: Toast; region: RefObject<HTMLDivElement> }) {
  const { t } = useTranslation("common");
  const element = useRef<HTMLDivElement>(null);
  const pause = useToastStore(s => s.pause); const resume = useToastStore(s => s.resume);
  const dismiss = useToastStore(s => s.dismiss);
  useLayoutEffect(() => {
    const node = element.current;
    const fallback = region.current;
    return () => {
      if (node?.contains(document.activeElement)) {
        (item.returnFocus?.isConnected ? item.returnFocus : fallback)?.focus({ preventScroll: true });
      }
    };
  }, [item.returnFocus, region]);
  return <div ref={element} data-notification-card data-error-card={item.tone === "error" ? "true" : undefined}
    onMouseEnter={() => pause(item.id)}
    onMouseLeave={() => { if (!element.current?.contains(document.activeElement)) resume(item.id); }}
    onFocus={() => pause(item.id)}
    onBlur={event => {
      if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))
          && !event.currentTarget.matches(":hover")) resume(item.id);
    }}
    className={cn("pointer-events-auto flex w-full min-w-0 items-start gap-2 rounded-card border bg-surface p-2 shadow-card",
      item.tone === "error" ? "border-error/30 text-error" : "border-border text-text")}>
    {item.tone === "error" ? <XCircle size={16} className="mt-3 shrink-0" /> : <CheckCircle2 size={16} className="mt-3 shrink-0 text-ok" />}
    <div className="min-w-0 flex-1 py-2">
      <p role={item.tone === "error" ? "alert" : "status"}
        className="whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">{item.message}</p>
      {item.action && <button type="button" className="min-h-11 min-w-11 underline" onClick={() => {
        try {
          const result = item.action!.run();
          void Promise.resolve(result).catch(() => toast.error(t("notification.actionFailed"), { accountId: item.accountId }));
        } catch { toast.error(t("notification.actionFailed"), { accountId: item.accountId }); }
        dismiss(item.id);
      }}>{item.action.label}</button>}
    </div>
    <button type="button" aria-label={t("notification.close")} className="grid min-h-11 min-w-11 shrink-0 place-items-center rounded hover:bg-surface-2"
      onClick={() => dismiss(item.id)}><X size={16} /></button>
  </div>;
}

function readViewport() {
  const visual = typeof window === "undefined" ? undefined : window.visualViewport;
  const height = visual?.height ?? (typeof window === "undefined" ? 260 : window.innerHeight);
  const dialog = typeof document !== "undefined" && [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')]
    .some(node => node.getBoundingClientRect().height > 0);
  return { top: visual?.offsetTop ?? 0, height, hidden: height < 48, dialog };
}

/** Fixed feedback never changes document flow or the composer's measured height. */
export function Toaster() {
  const { t } = useTranslation("common"); const region = useRef<HTMLDivElement>(null);
  const errors = useToastStore(s => s.errors);
  const toasts = useToastStore(s => s.toasts);
  const [viewport, setViewport] = useState(readViewport);
  useEffect(() => {
    const measure = () => {
      const visual = window.visualViewport;
      const top = visual?.offsetTop ?? 0;
      const height = visual?.height ?? window.innerHeight;
      const dialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')]
        .some(node => node.getBoundingClientRect().height > 0);
      const next = { top, height, hidden: height < 48, dialog };
      setViewport(old => old.top === next.top && old.height === next.height && old.hidden === next.hidden && old.dialog === next.dialog ? old : next);
    };
    measure();
    const observer = new MutationObserver(measure); observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", measure); window.visualViewport?.addEventListener("resize", measure); window.visualViewport?.addEventListener("scroll", measure);
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); window.visualViewport?.removeEventListener("resize", measure); window.visualViewport?.removeEventListener("scroll", measure); };
  }, []);
  // Re-check wall-clock deadlines before displaying a resumed tab.
  useLayoutEffect(() => { useToastStore.getState().pruneExpired(); }, [toasts]);
  const visible = viewport.dialog ? errors : [...errors, ...toasts].slice(0, MAX_VISIBLE_FEEDBACK);
  return <div ref={region} role="region" tabIndex={-1} aria-label={t("notification.region")}
    className="pointer-events-none fixed inset-x-0 z-[120] mx-auto flex w-[calc(100%-24px)] max-w-md flex-col items-center justify-center overflow-y-auto outline-none"
    style={{ top: viewport.top, height: viewport.height, visibility: viewport.hidden ? "hidden" : undefined }}>
    <div className="m-auto flex w-full flex-col gap-2 py-3">
      {visible.map(item => <Notification key={item.id} item={item} region={region} />)}
    </div>
  </div>;
}
