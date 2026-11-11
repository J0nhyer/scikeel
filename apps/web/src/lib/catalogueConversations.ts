import { catalogDirectory, type CatalogPage, type ConversationSummary, type GatewayBootstrapClient, type SessionMeta } from "@ai4s/sdk";

/** The page limit the catalogue cursor is bound to. The bootstrap request
 *  must use the same limit, or the continuation is rejected as an invalid
 *  cursor. */
export const CATALOGUE_PAGE_LIMIT = "50";

/** How many catalogue pages one connection may read. The list stays bounded
 *  in memory; a catalogue larger than this is reported as incomplete rather
 *  than silently truncated. */
const MAX_PAGES = 5;

/** Every conversation of the catalogue, page by page.
 *
 *  The bootstrap delivers the first page. The remaining pages carry the
 *  conversations a user must still reach, so the list is only complete when
 *  the cursor is exhausted. A page that cannot be read leaves the list
 *  incomplete rather than silently short: a conversation that is merely
 *  further down the catalogue must never be judged missing. */
export async function collectCatalogueConversations(
  client: GatewayBootstrapClient,
  cursor: string,
  workspace: string,
  options: { signal?: AbortSignal; timeoutMs?: number; limit?: string; isActive?: () => boolean } = {},
): Promise<{ sessions: SessionMeta[]; complete: boolean }> {
  const timeoutMs = options.timeoutMs ?? 15000;
  const limit = options.limit ?? CATALOGUE_PAGE_LIMIT;
  const collected: SessionMeta[] = [];
  const seen = new Set<string>();
  const visited = new Set<string>();
  let next: string | null = cursor;
  try {
    for (let page = 0; next && page < MAX_PAGES; page++) {
      if (visited.has(next)) return { sessions: collected, complete: false };
      visited.add(next);
      const result: CatalogPage<ConversationSummary> = await client.conversations(
        { cursor: next, limit },
        { signal: options.signal ?? AbortSignal.timeout(timeoutMs), timeoutMs },
      );
      if (options.isActive && !options.isActive()) return { sessions: collected, complete: false };
      for (const row of result.items) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        collected.push({
          id: row.id,
          title: row.title,
          directory: catalogDirectory(result, row.directoryRef, workspace),
          ...(row.parentId ? { parentId: row.parentId } : {}),
          updated: row.updatedAt,
        });
      }
      next = result.nextCursor;
    }
  } catch {
    return { sessions: collected, complete: false };
  }
  // The list is complete only when the catalogue ended inside the bound.
  return { sessions: collected, complete: next === null };
}
