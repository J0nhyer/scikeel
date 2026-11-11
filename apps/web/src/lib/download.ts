import { toast } from "./toast";

/** Save text as a file via a Blob download. No-op outside the browser. */
export function downloadText(filename: string, text: string, mime = "text/plain"): void {
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") return;
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Save text with user feedback: a Blob download in the browser. */
export async function saveTextWithFeedback(
  filename: string,
  text: string,
  mime = "text/plain",
): Promise<void> {
  try {
    downloadText(filename, text, mime);
    toast.success(`Downloaded ${filename}`);
  } catch (err) {
    toast.error(`Could not save ${filename}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
