import { useEffect, useRef, useState } from "react";
import type { AttachmentOwner, AttachmentPromptContext, ConversationAttachment } from "@ai4s/shared";
import { attachmentLimits, attachmentRequestKey, createAttachmentDraft, prepareImageDelivery, removePendingAttachment, uploadConversationAttachment, uploadImageDelivery } from "@/lib/conversationAttachments";
import { toast } from "@/lib/toast";
export interface PendingAttachment {
  localId: string; file: File; state: "uploading" | "ready" | "failed"; progress: number;
  attachment?: ConversationAttachment; error?: string; controller?: AbortController; removed?: boolean;
}
interface DraftQueue {
  owner: AttachmentOwner; draftPromise?: Promise<string>; items: PendingAttachment[];
  active: number; listeners: Set<() => void>; send?: { digest: string; turnId: string }; updatedAt: number;
}
const queues = new Map<string, DraftQueue>();
const notify = (queue: DraftQueue) => { queue.updatedAt = Date.now(); for (const listener of queue.listeners) listener(); };
function pump(queue: DraftQueue) {
  for (const item of queue.items) {
    if (queue.active >= 2) break;
    if (item.state !== "uploading" || item.controller || item.removed) continue;
    queue.active++; item.controller = new AbortController();
    const run = async () => {
      if (!queue.owner.sessionId && !queue.owner.draftId) {
        queue.draftPromise ??= createAttachmentDraft(); queue.owner.draftId = await queue.draftPromise;
      }
      if (item.removed) return;
      item.attachment ??= await uploadConversationAttachment({ owner: queue.owner, file: item.file, signal: item.controller!.signal, onProgress: (value) => { item.progress = value; notify(queue); } });
      if (item.removed) { await removePendingAttachment(queue.owner, item.attachment.id); return; }
      if (item.attachment.imageDelivery === "unavailable") {
        const image = await prepareImageDelivery(item.file);
        item.attachment = await uploadImageDelivery(queue.owner, item.attachment.id, image.blob, image.imageDelivery, item.controller!.signal);
      }
      if (!item.removed) { item.state = "ready"; item.progress = 100; }
    };
    void run().catch((error: unknown) => { if (!item.removed) { item.state = "failed"; item.error = error instanceof Error ? error.message : String(error); } }).finally(() => { queue.active--; item.controller = undefined; notify(queue); pump(queue); });
  }
}
/** Queue ownership belongs to a pane, never to whichever workspace is active. */
export function useComposerAttachments(key: string, sessionId?: string | null) {
  const slotKey = `${key}:${sessionId ?? "draft"}`;
  const [, rerender] = useState(0); const queueRef = useRef<DraftQueue | null>(null); const previousKey = useRef("");
  if (!queueRef.current || previousKey.current !== slotKey) {
    const previous = queueRef.current ?? queues.get(`${key}:draft`);
    const graft = previous && (previousKey.current === `${key}:draft` || !queueRef.current) && previous.send && sessionId;
    previousKey.current = slotKey;
    let queue = queues.get(slotKey);
    if (!queue && graft) { queue = previous; queues.set(slotKey, queue); queues.delete(`${key}:draft`); }
    if (!queue) { queue = { owner: sessionId ? { sessionId } : {}, items: [], active: 0, listeners: new Set(), updatedAt: Date.now() }; queues.set(slotKey, queue); }
    queueRef.current = queue;
  }
  const queue = queueRef.current;
  useEffect(() => { const listener = () => rerender((v) => v + 1); queue.listeners.add(listener); return () => { queue.listeners.delete(listener); }; }, [queue]);
  useEffect(() => {
    if (sessionId && !queue.items.length) queue.owner = { sessionId };
    for (const [slot, other] of queues) if (!other.listeners.size && !other.items.length && Date.now() - other.updatedAt > 3600000) queues.delete(slot);
  }, [queue, sessionId]);
  const add = (files: File[]) => {
    const combined = [...queue.items.map((item) => item.file), ...files];
    if (combined.length > attachmentLimits.files || combined.some((f) => f.size > attachmentLimits.fileBytes) || combined.reduce((sum, file) => sum + file.size, 0) > attachmentLimits.messageBytes) { toast.error("Attach up to 10 files, 25 MiB each, and 100 MiB per message."); return; }
    queue.items.push(...files.map((file) => ({ localId: attachmentRequestKey(), file, state: "uploading" as const, progress: 0 })));
    queue.send = undefined; notify(queue); pump(queue);
  };
  const remove = (localId: string) => {
    const item = queue.items.find((value) => value.localId === localId); if (!item) return;
    item.removed = true; item.controller?.abort(); queue.items = queue.items.filter((value) => value !== item); queue.send = undefined;
    if (item.attachment) void removePendingAttachment(queue.owner, item.attachment.id).catch(() => {});
    notify(queue);
  };
  const retry = (localId: string) => { const item = queue.items.find((value) => value.localId === localId); if (!item) return; item.state = "uploading"; item.error = undefined; queue.draftPromise = undefined; notify(queue); pump(queue); };
  const prepareSend = async (text: string): Promise<AttachmentPromptContext> => {
    if (queue.items.some((item) => item.state !== "ready")) throw new Error("Finish or remove pending attachments before sending.");
    const ids = queue.items.map((item) => item.attachment!.id); const digest = JSON.stringify({ text, ids });
    if (!queue.send || queue.send.digest !== digest) queue.send = { digest, turnId: attachmentRequestKey() };
    return { turnId: queue.send.turnId, attachmentIds: ids, ...(queue.owner.draftId ? { draftId: queue.owner.draftId } : {}) };
  };
  const acceptSend = (ids: string[]) => { queue.items = queue.items.filter((item) => !ids.includes(item.attachment?.id ?? "")); queue.send = undefined; notify(queue); };
  return { items: queue.items, add, remove, retry, prepareSend, acceptSend, blocked: queue.items.some((item) => item.state !== "ready"), busy: queue.items.some((item) => item.state === "uploading"), owner: queue.owner };
}
