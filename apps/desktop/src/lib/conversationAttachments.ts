import type { AttachmentOwner, ConversationAttachment } from "@ai4s/shared";
export type { AttachmentOwner, ConversationAttachment };
export const attachmentLimits = { files: 10, fileBytes: 25 * 1024 ** 2, messageBytes: 100 * 1024 ** 2, imageBytes: 512 * 1024 };
export function attachmentRequestKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `turn_${Array.from(bytes, (n) => n.toString(16).padStart(2, "0")).join("")}`;
}
const query = (owner: AttachmentOwner) => new URLSearchParams(Object.entries(owner).filter((entry): entry is [string, string] => typeof entry[1] === "string")).toString();
async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`/api/attachments${path}`, { credentials: "same-origin", ...options });
  if (!res.ok) { const data = await res.json().catch(() => ({})) as { error?: string }; throw new Error(data.error || `Attachment request failed (${res.status})`); }
  return res.status === 204 ? undefined as T : await res.json() as T;
}
export async function createAttachmentDraft(): Promise<string> { return (await request<{ id: string }>("/drafts", { method: "POST" })).id; }
export const claimAttachments = (draftId: string, sessionId: string, attachmentIds: string[]) => request<ConversationAttachment[]>("/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ draftId, sessionId, attachmentIds }) });
export const removePendingAttachment = (owner: AttachmentOwner, fileId: string) => request<void>(`/${encodeURIComponent(fileId)}?${query(owner)}`, { method: "DELETE" });
export const listConversationAttachments = (sessionId: string) => request<{ attachments: ConversationAttachment[]; turns: { turnId: string; messageID: string; attachmentIds: string[]; status: string }[] }>(`?sessionId=${encodeURIComponent(sessionId)}`);
export async function attachmentPreviewUrl(file: ConversationAttachment, owner: AttachmentOwner, download = false): Promise<string> {
  const { ticket } = await request<{ ticket: string }>(`/${encodeURIComponent(file.id)}/ticket`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...owner, download, preview: !download && file.mime.startsWith("image/") }) });
  return `/api/attachments/read?ticket=${encodeURIComponent(ticket)}`;
}
function upload(path: string, file: Blob, signal?: AbortSignal, onProgress?: (value: number) => void): Promise<ConversationAttachment> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest(); const abort = () => xhr.abort();
    const finish = (error?: Error) => { signal?.removeEventListener("abort", abort); if (error) reject(error); };
    xhr.open(path.includes("/image?") ? "PUT" : "POST", `/api/attachments${path}`); xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(Math.round(e.loaded / e.total * 100)); };
    xhr.onload = () => {
      let data: ConversationAttachment & { error?: string };
      try { data = JSON.parse(xhr.responseText) as typeof data; } catch { finish(new Error(`Upload failed (${xhr.status})`)); return; }
      if (xhr.status < 200 || xhr.status >= 300) { finish(new Error(data.error || `Upload failed (${xhr.status})`)); return; }
      finish(); resolve(data);
    };
    xhr.onerror = () => finish(new Error("Upload failed. Check your connection and retry."));
    xhr.onabort = () => finish(new DOMException("Upload cancelled", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { finish(new DOMException("Upload cancelled", "AbortError")); return; }
    xhr.send(file);
  });
}
export async function uploadConversationAttachment({ owner, file, signal, onProgress }: { owner: AttachmentOwner; file: File; signal?: AbortSignal; onProgress?: (value: number) => void }): Promise<ConversationAttachment> {
  if (file.size > attachmentLimits.fileBytes) throw new Error("Each attachment must be at most 25 MiB");
  return upload(`/upload?${query(owner)}&name=${encodeURIComponent(file.name || "pasted.png")}`, file, signal, onProgress);
}
export async function prepareImageDelivery(file: File): Promise<{ blob: Blob; imageDelivery: "resized" | "still" }> {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image(); image.src = url; await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error("Cannot decode this image. Try PNG, JPEG or WebP.")); });
    if (image.width * image.height > 64 * 1024 ** 2) throw new Error("Image dimensions are too large. Use a smaller image.");
    const canvas = document.createElement("canvas");
    for (let attempt = 0; attempt < 8; attempt++) {
      const scale = Math.min(1, 2560 / Math.max(image.width, image.height)) * 0.8 ** attempt;
      canvas.width = Math.max(1, Math.floor(image.width * scale)); canvas.height = Math.max(1, Math.floor(image.height * scale));
      const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("Image preparation is unavailable");
      ctx.fillStyle = "white"; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Image preparation failed")), "image/webp", Math.max(0.45, 0.85 - attempt * 0.06)));
      if (blob.size <= attachmentLimits.imageBytes) return { blob, imageDelivery: file.type === "image/gif" ? "still" : "resized" };
    }
    throw new Error("Image is too complex. Use a smaller image.");
  } finally { URL.revokeObjectURL(url); }
}
export const uploadImageDelivery = (owner: AttachmentOwner, fileId: string, blob: Blob, delivery: string, signal?: AbortSignal) => upload(`/${encodeURIComponent(fileId)}/image?${query(owner)}&delivery=${delivery}`, blob, signal);
