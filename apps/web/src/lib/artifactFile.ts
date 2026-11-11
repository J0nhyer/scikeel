// Read/preview workspace files through the gateway. Paths are root-relative;
// `root` picks the tree ("workspace" = the active session folder, default;
// "base" = the folder all session workspaces live under).
import type { FileRoot } from "@ai4s/shared";
import { gatewayOrigin, gatewayToken } from "./webMode";

export type { FileRoot };

export interface ArtifactFile {
  path: string;
  mime: string;
  /** "utf8" for text, "base64" for binary. */
  encoding: "utf8" | "base64";
  data: string;
  size: number;
}

async function fileRequestError(response: Response): Promise<Error> {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return new Error(body?.error || `File request failed (${response.status})`);
}

/** Read a root-relative file through the gateway. */
export async function readArtifact(path: string, root?: FileRoot, dir?: string): Promise<ArtifactFile | null> {
  const url = await previewUrl(path, root, dir);
  if (!url) return null;
  const response = await fetch(url);
  if (!response.ok) return null;
  const blob = await response.blob();
  const mime = blob.type || "application/octet-stream";
  if (mime.startsWith("text/") || /json|javascript|xml|yaml|markdown/.test(mime)) {
    return { path, mime, encoding: "utf8", data: await blob.text(), size: blob.size };
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return { path, mime, encoding: "base64", data: btoa(binary), size: blob.size };
}

interface FileTicket {
  ticket: string;
  path?: string;
}

async function requestFileTicket(path: string, root?: FileRoot, dir?: string): Promise<FileTicket> {
  // The gateway token must NOT ride in this URL: it feeds an <iframe>/<img>
  // src and the "open in a tab" action, and a document can read its own
  // location whatever its sandbox — so one prompt-injected HTML artifact
  // would post the token out and hand over the whole gateway. Trade it,
  // over an Authorization header, for a ticket that unlocks this one file.
  const t = gatewayToken();
  const query =
    `path=${encodeURIComponent(path)}` +
    `${root ? `&root=${root}` : ""}${dir ? `&dir=${encodeURIComponent(dir)}` : ""}`;
  const res = await fetch(`${gatewayOrigin()}/v1/fs/ticket?${query}`, {
    headers: t ? { authorization: `Bearer ${t}` } : {},
  });
  if (!res.ok) throw await fileRequestError(res);
  const result = (await res.json()) as FileTicket;
  if (!result.ticket) throw new Error("The server did not provide a file preview URL");
  return result;
}

/** Same-origin URL a workspace file is previewable at. */
export async function previewUrl(path: string, root?: FileRoot, dir?: string): Promise<string | null> {
  const { ticket } = await requestFileTicket(path, root, dir);
  return `${gatewayOrigin()}/v1/fs/read?ticket=${encodeURIComponent(ticket)}`;
}

/** Download the original file without buffering it in browser memory. Refresh
 *  the ticket on each click so a long-open preview can still be downloaded. */
export async function downloadArtifact(path: string, root?: FileRoot, dir?: string): Promise<void> {
  const url = await previewUrl(path, root, dir);
  if (!url) throw new Error("File download is unavailable");
  const filename = path.split(/[\\/]/).pop() || "download";
  const link = document.createElement("a");
  link.href = `${url}&download=${encodeURIComponent(filename)}`;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/** Resolve a file mentioned in an agent message to a real workspace-relative
 *  path. Agent prose may name a file without its directory ("index.html" for
 *  "canvas-project/index.html"); the gateway finds it by basename. Returns
 *  null when no such file exists. */
export async function resolveArtifactPath(path: string, dir?: string): Promise<string | null> {
  // Use the resolved workspace path so bare names and full paths deduplicate.
  // Older gateways only return a ticket; keep their original path as a fallback.
  // Never turn a planned filename into a download without checking it exists.
  // Only share pending lookups: a missing file may be created on the next turn.
  const key = JSON.stringify([gatewayOrigin(), dir, path]);
  const pending = webResolvedPaths.get(key);
  if (pending) return pending;
  const lookup = requestFileTicket(path, undefined, dir)
    .then((result) => result.path ?? path)
    .catch(() => null);
  webResolvedPaths.set(key, lookup);
  // A resolved path is the answer the next mention wants; only a failure is
  // forgotten (a missing file may be created on the next turn).
  void lookup.then(
    (value) => { if (value === null) webResolvedPaths.delete(key); },
    () => webResolvedPaths.delete(key),
  );
  return lookup;
}

const webResolvedPaths = new Map<string, Promise<string | null>>();

/** Forget every resolution — they are only valid for one workspace folder. */
export function clearResolvedPaths(): void {
  webResolvedPaths.clear();
}

/** Write text to a root-relative path. The Web client edits through the
 *  platform workspace API (`WorkspaceTextEditor`), not this helper. */
export async function writeWorkspaceFile(
  _path: string,
  _content: string,
  _root?: FileRoot,
): Promise<void> {
  throw new Error("Writing a file directly is not available in the Web client.");
}

export interface DirEntry {
  path: string;
  name: string;
  isDir: boolean;
  size: number;
  /** Seconds since the epoch. */
  modified: number;
  revision?: string;
  capabilities?: string[];
}

/** List one directory under the root (non-recursive; "" = the root). */
export async function listDir(rel: string, root?: FileRoot, dir?: string): Promise<DirEntry[]> {
  const t = gatewayToken();
  const url =
    `${gatewayOrigin()}/v1/fs/list?path=${encodeURIComponent(rel)}` +
    `${root ? `&root=${root}` : ""}${dir ? `&dir=${encodeURIComponent(dir)}` : ""}`;
  const r = await fetch(url, { headers: t ? { Authorization: `Bearer ${t}` } : {} });
  if (!r.ok) throw await fileRequestError(r);
  return (await r.json()) as DirEntry[];
}

/** Build a `data:` URL from a read artifact for <img>/<iframe>/pdf.js. */
export function toDataUrl(f: ArtifactFile): string {
  if (f.encoding === "base64") return `data:${f.mime};base64,${f.data}`;
  return `data:${f.mime};charset=utf-8,${encodeURIComponent(f.data)}`;
}

/** Decode a base64 artifact into raw bytes for binary renderers (docx/xlsx/pptx). */
export function base64ToBytes(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}
