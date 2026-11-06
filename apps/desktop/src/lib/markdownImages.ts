/** Markdown documents reach the workspace's images by relative path
 *  (`figure1.png`, `../figures/plot.png`). The web client serves files only
 *  through short-lived tickets, so each path must be resolved against the
 *  document's own directory before an <img> can load it.
 *
 *  The server rejects `..`, `.`, empty and backslash path segments outright;
 *  normalizing here keeps a legitimate `../figures/x.png` working while a path
 *  that escapes the workspace never reaches the file API. */

/** A workspace-relative path for a markdown image source, or null when the
 *  source must not be treated as a workspace file (remote URL, app-absolute
 *  path, protocol-relative URL, or a path that escapes the workspace root). */
export function normalizeMarkdownAssetPath(baseDirectory: string, source: string): string | null {
  // A query/fragment is not part of a workspace filename (`figure.png?raw=1`).
  const path = source.split(/[?#]/, 1)[0];
  if (!path) return null;

  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // A stray `%` is a literal filename character, not an encoding error.
  }

  // Reject anything that is not a relative workspace path. Backslashes are
  // rejected rather than normalized: the platform API refuses them.
  if (
    !decoded ||
    decoded.startsWith("/") ||
    decoded.includes("\\") ||
    /^[a-z][a-z0-9+.-]*:/i.test(decoded) ||
    [...decoded].some((char) => char.charCodeAt(0) < 0x20)
  ) {
    return null;
  }

  // A source that names no file at all (`.`, `./`) must not resolve to the
  // document's directory.
  if (!decoded.split("/").some((part) => part && part !== ".")) return null;

  const parts: string[] = [];
  for (const part of [...baseDirectory.split("/"), ...decoded.split("/")]) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.length ? parts.join("/") : null;
}

/** Sources the browser can load without touching the workspace file API. */
export function isDirectImageSource(source: string): boolean {
  return /^(https?:|blob:|data:image\/)/i.test(source) || source.startsWith("//");
}

export type ResolveMarkdownImage = (src: string) => Promise<string | null>;

/** A resolved preview URL outlives one render but must not outlive its ticket:
 *  platform file tickets expire after 180 seconds, so refresh comfortably
 *  before that. A failure is retried sooner — the agent may be writing the
 *  image right now. */
const RESOLVED_TTL_MS = 120_000;
const FAILED_TTL_MS = 5_000;

interface ResolvedImage {
  url: string | null;
  expiresAt: number;
}

const resolvedImages = new Map<string, ResolvedImage>();
const pendingImages = new Map<string, Promise<string | null>>();

/** Resolve a markdown image once per workspace/source. Chat re-renders on every
 *  streamed token and a document re-renders on every editor keystroke; without
 *  this, each render would mint another file ticket (the platform caps them at
 *  256 per user). */
export function resolveMarkdownImage(
  cacheKey: string,
  source: string,
  resolve: ResolveMarkdownImage,
): Promise<string | null> {
  const key = `${cacheKey}\u0000${source}`;
  const cached = resolvedImages.get(key);
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.url);

  const pending = pendingImages.get(key);
  if (pending) return pending;

  const request = Promise.resolve()
    .then(() => resolve(source))
    .then(
      (url) => {
        pendingImages.delete(key);
        resolvedImages.set(key, {
          url,
          expiresAt: Date.now() + (url ? RESOLVED_TTL_MS : FAILED_TTL_MS),
        });
        return url;
      },
      () => {
        pendingImages.delete(key);
        resolvedImages.set(key, { url: null, expiresAt: Date.now() + FAILED_TTL_MS });
        return null;
      },
    );
  pendingImages.set(key, request);
  return request;
}

/** Drop every cached resolution. Workspace switching and tests use this; the
 *  URLs are only valid for the workspace that produced them. */
export function clearMarkdownImageCache(): void {
  resolvedImages.clear();
  pendingImages.clear();
}
