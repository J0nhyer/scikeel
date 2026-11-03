# Web New-Session Visibility and First-Message Hydration

Status: implemented. The verified Web bundle is served by recovery reader
`2026-11-03T05-31-17-804Z-37b7a28a-reader` (tree-identical to the candidate; main asset
`index-DJBZyCAV.js`). The full candidate publication is blocked by the selected-assistant file
write/read live gate (`GET /api/workspace/text` 404), not by the Web fix; platform health is 200
and user data is preserved.

## 1. User requirements

- After a user sends the first message of a new Web conversation, the conversation view must stay on that conversation. It must not disappear and fall back to the new-session screen while the workspace catalogue is still catching up.
- Reopening the conversation must not require a browser refresh merely to make the session visible again.
- When a conversation is reopened while its turn is still running, the transcript must include the first user message. The transcript must not start at the assistant's first reply.
- A page reload during a running turn must hydrate the conversation from the server history, not from a partial live-event fold.
- The fixes must work in the Web client at phone widths. No desktop-only control or host-filesystem dependency is introduced.
- No server, sandbox image, model or assistant selection change is required. This is a Web-client repair.
- Existing behavior must be preserved: an optimistic send is shown immediately; a loaded conversation is not refetched on every open; a failed history load remains retryable; a failed send keeps its error line; deleting a session removes it.

## 2. Verified observations (2026-11-03)

The live platform serves Web assets from
`/opt/open-science-desktop/.deploy/web-releases/2026-11-02T17-24-50-530Z-a6bba2a0/web`
and runs platform source from
`/opt/open-science-desktop/.deploy/web-releases/2026-11-02T14-07-51-335Z-98e5d2b4/source`.
The deployed source is byte-identical to
`/opt/open-science-desktop/.worktrees/web-chat-interruption-recovery-20261102`
for `apps/desktop/src`, so the worktree is the correct source checkout for this fix.

The user's live conversation `ses_e60c37099ffeyVL6uiturk7WzA` provides the evidence:

- The session was created at `2026-11-03 10:28:28.646 CST`.
- The first user message was persisted at `10:28:33.471 CST`; the first assistant message followed at
  `10:28:33.539 CST`.
- The conversation's catalogue/canonical record has `updatedAt = 10:29:43.972 CST`, the first point
  at which a history read had indexed the conversation into the catalogue.
- The native OpenCode database contains 36 messages; message 0 is the user message
  `msg_19f3ca23f001xRQuAgMBWB46E0` with a 305-character text part.
- The platform canonical state contains the same message as event 1, role `user`, state `completed`.
- Running the platform's `ConversationRouter.messages(..., { synchronize: true })` offline against that
  native and canonical data returns 36 messages with the user message first.

Limit of this evidence: the user's browser DOM was not captured. The fact that both native and
canonical history contain the first message establishes that the missing display is client-side
hydration, not data loss. The exact client race is established from the code paths below.

## 3. Root causes

### 3.1 A new session is dropped from the list while the catalogue indexes it

`performTurn` creates the session, inserts an optimistic `New session` row into `sessions`, and then
calls `refreshSessions()` (`apps/desktop/src/lib/runtime.ts:2116-2141`). `refreshSessions` replaces
`sessions` with the result of `listSessions` (`runtime.ts:4940-4975`). On the platform Web client that
list is the workspace catalogue (`OpenCodeClient.listSessions`, `packages/sdk/src/OpenCodeClient.ts:678-703`),
which does not contain the conversation until a history read indexes it. The optimistic row is therefore
discarded.

`missingSessionId` rejects the focused session when `status === "ready" && sessionListComplete` and the
id is absent from `sessions` (`apps/desktop/src/app/routes/LiveSessionPage.tsx:37-50`). The rejection
effect resets the layout, blanks the draft view and navigates to `/live` (`LiveSessionPage.tsx:141-155`).
That is the observed "session appears, then returns to the new-session screen" behavior. After the
catalogue catches up, a browser refresh can list and open the session again.

### 3.2 A live-only thread is treated as a loaded history

An SSE fold creates or updates `threads[sid]` with `loaded: true` (`runtime.ts:3641-3646`). `foldEvent`
handles assistant text, tool, reasoning and idle events only; it never creates a user block
(`runtime.ts:6099-6280`). A user message is shown only by the optimistic echo at send time
(`runtime.ts:1962-1975`) or by `historyToThread`.

On a reload during a running turn, the directory-scoped event stream can deliver assistant events before
the user opens the session. Those events create a partial thread with assistant blocks and
`loaded: true`, but no user message. `openSession` then treats the thread as already loaded and skips
the server history (`runtime.ts:5295`). The first user message stays missing until a later history load
(a fresh reload after the turn settles, or a retry path).

The two defects interact: the first defect resets the pane while the turn is still running; the second
then makes the recovered live thread start at the assistant reply.

## 4. Design

### 4.1 Retain locally created sessions until the catalogue confirms them

Add a bounded store set:

```ts
/** Sessions this client created that the workspace catalogue has not returned yet. */
locallyCreatedSessions: Record<string, true>;
```

- When `performTurn` optimistically inserts a newly created Web session, it records its id. The row
  itself stays in `sessions`, so later title/directory updates (SSE `session.updated`, rename, move,
  title generation) are what the next merge retains.
- A shared `mergeLocallyCreatedSessions(state, next, { append })` merges the current row for every
  pending id the new catalogue list does not contain, then sorts by `updated`; it drops a pending id
  whose row is no longer present. It is used by `refreshSessions`, the managed bootstrap's first page,
  and the catalogue continuation pages.
- The map is capped at 100 ids, keeping the newest insertions.
- The map is cleared on account presentation reset and runtime switch. An id is removed on
  `deleteSession`, on archive (`setSessionArchived`), on a remote `session.deleted` event, and by the
  merge when the catalogue returns the id. A row created by the `present new-session` artifact
  presentation is registered too.
- The map is intentionally in-memory. A full page reload during the short indexing window is not part
  of this defect; the catalogue normally has the conversation by then. Persisting pending sessions
  across reloads is explicitly out of scope.

`missingSessionId` itself does not change. Its input list now contains the locally created session, so
it no longer classifies a just-created conversation as missing. This keeps the guard's existing
protection against sessions from another account or a deleted session.

### 4.2 Confirm history before treating a thread as loaded

Add an optional flag to `Thread`:

```ts
/** True only after a server history read succeeded. Live SSE folds and the
 *  optimistic send echo set `loaded` so the pane can paint, but they do not
 *  contain earlier user messages. */
historyLoaded?: boolean;
```

- `emptyThread` remains `loaded: false` with no confirmed history.
- Optimistic echoes and SSE folds never set `historyLoaded`.
- Every successful history-producing path sets `historyLoaded: true`:
  `openSession`, `loadHistory`, `reconcileRunning`, and the post-revert history rebuild.
- A shared predicate decides whether an open must fetch:

```ts
function needsHistory(thread: Thread | undefined, sendInFlight: boolean): boolean {
  if (!thread?.loaded) return true;
  if (sendInFlight) return false;
  if (thread.historyError) return true;
  if (thread.historyLoaded) return false;
  return !thread.blocks.some((block) => block.kind === "user");
}
```

Rationale:

- A never-loaded or failed thread must fetch (preserves #139 retry behavior).
- A confirmed history thread must not refetch.
- An optimistic send has a user block and is authoritative until its prompt is accepted; it must not
  be replaced by the empty history that exists before the prompt.
- A send with a hidden echo (goal/auto-review) is protected by `sendInFlight`.
- A live-only thread with assistant blocks and no user block is exactly the reload-during-running
  state; it must fetch the server history, which contains the first user message.
- A live-only thread that already has a user block is the current optimistic send; it does not refetch.

`loadHistory` uses the same predicate and, after the fetch, skips only when another successful history
load landed (`latest.historyLoaded`). A live fold must not swallow the reload.

### 4.3 Sends race the hydration fetch

`openSession` and `loadHistory` decide to fetch with `needsHistory` before awaiting the server. The
composer is usable during that await. If a send starts in the meantime, its optimistic user block is
newer than the snapshot. Both paths re-check after the fetch: they skip the commit when
`sendingSessions[id]` is set, or when the thread had no user block before the fetch and now has one.
This keeps the user's message and avoids marking the thread `historyLoaded` with pre-prompt history.

### 4.4 History must keep the live-fold keys

Replacing a still-streaming thread with history is only safe if later SSE events update the existing
blocks rather than append duplicates. `historyToThread` now returns an index keyed by native part id
(`text:`, `reasoning:`), tool call id (`tool:`, `presentation:`), artifact path (`artifact:`) and
review fence (`review:`). `HistoryPart` carries the native `id` for this purpose.

### 4.5 No platform change

The catalogue indexing delay is a platform characteristic, not a correctness failure. The client must
not treat a bounded asynchronous index as authority to delete a session it just created. No server
schema, route, sandbox image or assistant selection changes.

### 4.6 Alternatives rejected

- Disabling `missingSessionId`: it protects against sessions from another account, a deleted session or
  a runtime switch. Keep it.
- Delaying the guard by a fixed timeout: arbitrary and still wrong after the timeout.
- Marking the optimistic thread as `historyLoaded: true`: hides the missing first message further.
- Fetching history on every open: refetches a loaded conversation on every click and can replace live
  blocks with a slightly older snapshot.
- Persisting pending sessions in `sessionStorage`: additional state and cross-tab semantics do not
  address the reported post-create refresh; defer until a reload-during-indexing defect is observed.

## 5. Acceptance

1. With the catalogue returning a list that omits a just-created session, the session remains in
   `sessions` after the automatic `refreshSessions`; `locallyCreatedSessions` holds it.
2. When the catalogue later returns the session, it appears exactly once and the pending entry is
   removed.
3. A live-only thread with assistant blocks, no user block and no confirmed history fetches history on
   open and renders the first user message before the assistant blocks.
4. A live-only thread with a user block (optimistic send) is not replaced on open.
5. A thread with a send in flight but no user block (hidden echo) is not replaced on open.
6. A thread with `historyLoaded: true` and no user block is not refetched.
7. A failed history load remains retryable; a failed send keeps its error line.
8. Deleting a session also removes its pending entry.
9. Focused tests, the full frontend suite, typecheck, lint and the release Web build pass; code review
   is clear.
10. The published release reports `published`, the platform health endpoint returns 200, and the served
    bundle identity matches the release manifest.
11. Archiving or remotely deleting a pending session removes its id; a later catalogue refresh does
    not resurrect the row.
12. A send that starts while a hydration fetch is in flight keeps its optimistic user block.
13. History rebuilt from the server keeps the live-fold index, so a later event updates the existing
    block instead of appending a duplicate.

## 6. Non-goals

- Making the platform catalogue index synchronously at session creation.
- Persisting locally created sessions across a full browser reload during the indexing window.
- Changing assistant selection, model catalog, sandbox images or platform routing.
- Desktop-specific behavior or desktop acceptance.

## 7. Risks

- **Duplicate rows**: merging a pending session with a catalogue entry must replace, not duplicate. The
  merge removes any id the fresh list contains.
- **Stale rows**: a locally created session that is deleted or archived (locally or from another
  client) must not linger. The delete, archive and `session.deleted` paths remove the pending id; the
  merge also drops an id whose row is gone. The cap bounds the set. The catalogue is the source of
  truth once it lists the id.
- **Live blocks versus history**: replacing a live-only thread with history can drop a block streamed
  between the fetch and the state write. The next event refolds it; server history is authoritative
  for completion.
- **Failed sends**: a failed prompt leaves a user echo and an error line; the user-block rule keeps that
  transcript instead of replacing it with an empty history.
- **Old thread objects in tests**: `historyLoaded` is optional; a test that simulates a loaded history
  must set it, otherwise the new gate correctly fetches. Existing tests that seed only a user block
  keep their current behavior.

## 8. Verification and rollout

- Test-driven: write the failing store tests first, observe RED, implement, observe GREEN.
- Focused commands run through `scripts/dev/safe-desktop-task.mjs` (never Vitest directly on this host):
  - `node scripts/dev/safe-desktop-task.mjs test src/lib/runtime.store.test.ts src/lib/runtime.test.ts`
- Full verification and publication run through the release tool from the worktree:
  - `pnpm web:release run --source /opt/open-science-desktop/.worktrees/web-chat-interruption-recovery-20261102`
- Code review runs on the complete diff before publication.
- Publication must leave the previous bundle recoverable and must not run platform/image work for this
  Web-only change.
- Update `PROGRESS.md` with the verified release outcome.
