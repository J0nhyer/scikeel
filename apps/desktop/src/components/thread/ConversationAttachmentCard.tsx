import { PdfPreview } from "@/components/inspector/PdfPreview";
import { useTranslation } from "react-i18next";
import { useEffect, useRef, useState } from "react";
import { Download, File, Loader2, RotateCw, X } from "lucide-react";
import type { AttachmentOwner, ConversationAttachment } from "@ai4s/shared";
import { attachmentPreviewUrl } from "@/lib/conversationAttachments";
import { toast } from "@/lib/toast";
import type { PendingAttachment } from "./useComposerAttachments";
function bytes(size: number) { return size < 1024 ? `${size} B` : size < 1024 ** 2 ? `${(size / 1024).toFixed(0)} KB` : `${(size / 1024 ** 2).toFixed(1)} MB`; }
export function ConversationAttachmentCard({ attachment, owner, pending, onRemove, onRetry }: {
  attachment?: ConversationAttachment; owner: AttachmentOwner; pending?: PendingAttachment; onRemove?: () => void; onRetry?: () => void;
}) {
  const { t } = useTranslation("session");
  const name = attachment?.name ?? pending?.file.name ?? "Attachment";
  const mime = attachment?.mime ?? pending?.file.type ?? "";
  const [thumbnail, setThumbnail] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const latest = useRef({ attachment, pending, owner });
  latest.current = { attachment, pending, owner };
  useEffect(() => {
    const { attachment, pending, owner } = latest.current;
    let active = true; let localUrl: string | undefined;
    if (mime.startsWith("image/")) {
      if (pending) { localUrl = URL.createObjectURL(pending.file); setThumbnail(localUrl); }
      else if (attachment) void attachmentPreviewUrl(attachment, owner).then((url) => { if (active) setThumbnail(url); }).catch(() => {});
    }
    return () => { active = false; if (localUrl) URL.revokeObjectURL(localUrl); };
  }, [attachment?.id, pending?.localId, owner.sessionId, owner.draftId, mime]);
  const open = async (download: boolean) => {
    if (!attachment) return; setOpening(true);
    try {
      const url = await attachmentPreviewUrl(attachment, owner, download);
      if (download) { const link = document.createElement("a"); link.href = url; link.download = name; document.body.append(link); link.click(); link.remove(); }
      else setPreview(url);
    } catch (error) { toast.error(error instanceof Error ? error.message : String(error)); }
    finally { setOpening(false); }
  };
  return <>
    <div className="flex min-w-0 max-w-full items-center gap-2 rounded-input border border-border bg-surface-2 p-2 text-xs" data-attachment-id={attachment?.id}>
      <button type="button" onClick={() => void open(false)} disabled={!attachment || pending?.state !== undefined || opening} aria-label={t("composer.attachments.preview", { name })} className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-default">
        {thumbnail ? <img src={thumbnail} alt="" onError={() => setThumbnail(null)} className="h-10 w-10 shrink-0 rounded object-cover" /> : <File size={22} className="shrink-0 text-muted" />}
        <span className="min-w-0"><span className="block break-all text-text">{name}</span><span className="block text-muted">{bytes(attachment?.size ?? pending?.file.size ?? 0)}</span></span>
      </button>
      {pending?.state === "uploading" && <span className="flex shrink-0 items-center gap-1 text-muted"><Loader2 size={12} className="animate-spin" />{pending.progress}%</span>}
      {pending?.state === "failed" && onRetry && <button type="button" onClick={onRetry} aria-label={t("composer.attachments.retry", { name })} title={pending.error} className="shrink-0 p-1 text-warn"><RotateCw size={14} /></button>}
      {!pending && attachment && <button type="button" onClick={() => void open(true)} disabled={opening} aria-label={t("composer.attachments.download", { name })} className="shrink-0 p-1 text-muted hover:text-text"><Download size={14} /></button>}
      {onRemove && <button type="button" onClick={onRemove} aria-label={t("composer.attachments.remove", { name })} className="shrink-0 p-1 text-muted hover:text-text"><X size={14} /></button>}
    </div>
    {pending?.error && <p role="alert" className="w-full break-words text-xs text-warn">{pending.error}</p>}
    {attachment?.imageDelivery === "resized" && <p className="text-xs text-muted">{t("composer.attachments.imageResized")}</p>}
    {attachment?.imageDelivery === "still" && <p className="text-xs text-muted">{t("composer.attachments.imageStill")}</p>}
    {preview && <div role="dialog" aria-modal="true" aria-label={t("composer.attachments.preview", { name })} className="fixed inset-0 z-50 flex flex-col bg-black/60 p-3 sm:p-8" onKeyDown={(e) => { if (e.key === "Escape") setPreview(null); }}>
      <div className="flex min-w-0 items-center justify-between gap-2 rounded-t-card bg-surface p-3"><span className="min-w-0 break-all text-sm text-text">{name}</span><div className="flex shrink-0 gap-2"><button type="button" onClick={() => void open(true)} aria-label={t("composer.attachments.download", { name })} className="p-2 text-muted"><Download size={18} /></button><button type="button" autoFocus onClick={() => setPreview(null)} aria-label={t("composer.attachments.close")} className="p-2 text-muted"><X size={18} /></button></div></div>
      {mime.startsWith("image/") ? <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto rounded-b-card bg-surface"><img src={preview} alt={name} className="max-h-full max-w-full object-contain" /></div> : mime === "application/pdf" ? <div className="min-h-0 flex-1 overflow-auto rounded-b-card bg-surface"><PdfPreview url={preview} /></div> : mime.startsWith("text/") || mime === "application/json" ? <iframe title={name} src={preview} sandbox="" className="min-h-0 flex-1 rounded-b-card bg-white" /> : <div className="rounded-b-card bg-surface p-6 text-sm text-text">{t("composer.attachments.unavailable")}</div>}
    </div>}
  </>;
}
