# Web New-Session Visibility and First-Message Hydration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep a just-created Web conversation visible while the workspace catalogue catches up, and make a reopened live conversation fetch its server history so the first user message is shown above the assistant reply.

**Architecture:** The runtime store remembers sessions it created locally (`locallyCreatedSessions`) and merges them into every `refreshSessions` result until the catalogue returns them, so `missingSessionId` never rejects a live conversation. A second, independent flag on each thread (`historyLoaded`) records whether a server history read has ever succeeded; live SSE folds and the optimistic send echo do not set it. A shared `needsHistory` predicate lets `openSession` and `loadHistory` fetch history for a live-only thread that has no user block, while still preserving an optimistic send, a send in flight, a failed send's error line and an already-confirmed history.

**Tech Stack:** TypeScript, React, Zustand store, Vitest, the existing guarded release tooling (`scripts/dev/safe-desktop-task.mjs`, `pnpm web:release`).

**Spec:** `docs/superpowers/specs/2026-11-03-web-new-session-hydration-design.md`

## Global Constraints

- Source worktree: `/opt/open-science-desktop/.worktrees/web-chat-interruption-recovery-20261102`, branch `fix/web-chat-interruption-recovery-20261102`. Do not edit the root checkout's reduced platform tree.
- The deployed Web bundle and platform source are byte-identical to this worktree for `apps/desktop/src`; publish from this worktree only.
- Run every test, typecheck, lint and build through package scripts and `scripts/dev/safe-desktop-task.mjs`; never invoke Vitest, Vite, Cargo or a parallel heavy job directly on this host.
- No new user-facing strings, no i18n changes, no desktop-only behavior, no platform/schema/image/assistant changes.
- Preserve optimistic sends, loaded-history no-refetch, failed-history retry, failed-send error lines, and session deletion.
- A failed publication must leave the deployed Web bundle untouched.
- Write failing tests first, observe RED, then implement the smallest fix. Commit after each task.
- The plan's status text is not evidence; the test output and release manifest are.

## Review Focus

- A catalogue refresh returns a list without the just-created id: the session must remain in `sessions` and must not be classified as missing.
- A live-only thread with assistant blocks and no user block: opening it must fetch history and render the user message first.
- An optimistic send with a user echo and no confirmed history: opening it must not replace the echo with pre-prompt empty history.
- A failed send with a user echo and an error line: reopening must keep the error line.
- A thread with `historyLoaded: true` and no user block (assistant-only history): reopening must not refetch.

---

### Task 1: Retain a locally created session across catalogue refreshes

**Files:**
- Modify: `apps/desktop/src/lib/runtime.ts` (`RuntimeState`, module constants, initial state, `performTurn`, `refreshSessions`, `clearPlatformPresentation`, `selectGatewayRuntime`, `deleteSession`)
- Test: `apps/desktop/src/lib/runtime.store.test.ts`

**Interfaces:**
- Produces: `locallyCreatedSessions: Record<string, SessionMeta>` on `RuntimeState`.
- Consumes: the existing optimistic insert in `performTurn`, the existing `refreshSessions` list replacement, and `SessionMeta` from `@ai4s/sdk`.

- [ ] **Step 1: Write the failing retention tests**

Add to `apps/desktop/src/lib/runtime.store.test.ts` next to the existing `"binds a Web draft to its created session even when its first prompt fails"` test:

```ts
it("keeps a just-created Web session when the catalogue has not indexed it yet", async () => {
  mocks.isGatewayWeb = true;
  mocks.isTauri = false;
  const source = makeLeaf(null);
  useLayoutStore.setState({
    groups: [{ id: "retain-group", name: "", tree: source, focusedLeafId: source.id, zoomedLeafId: null }],
    activeGroupId: "retain-group",
    tree: source,
    focusedLeafId: source.id,
    zoomedLeafId: null,
  });
  useRuntimeStore.setState({
    gatewayRuntime: "opencode",
    gatewayCatalogState: "ready",
    defaultModel: "fixture/model",
    providers: [{ id: "fixture", name: "Fixture", models: [{ id: "model", name: "Model" }] }],
    sessionListComplete: true,
    sessions: [],
    locallyCreatedSessions: {},
  });
  mocks.sessionList = []; // the catalogue has not indexed the new conversation yet

  await useRuntimeStore.getState().sendPrompt("hello", undefined, `draft:${source.id}`);

  const state = useRuntimeStore.getState();
  expect(state.sessions.some((session) => session.id === "ses_new")).toBe(true);
  expect(state.locallyCreatedSessions.ses_new).toBeTruthy();
});

it("replaces a pending session with the catalogue entry without duplicating it", async () => {
  useRuntimeStore.setState({
    sessions: [{ id: "ses_new", title: "New session", directory: "/ws/base" }],
    locallyCreatedSessions: { ses_new: { id: "ses_new", title: "New session", directory: "/ws/base" } },
  });
  mocks.sessionList = [{ id: "ses_new", title: "Python demo", directory: "/ws/base" }];

  await useRuntimeStore.getState().refreshSessions();

  const state = useRuntimeStore.getState();
  expect(state.sessions.filter((session) => session.id === "ses_new")).toHaveLength(1);
  expect(state.sessions[0].title).toBe("Python demo");
  expect(state.locallyCreatedSessions.ses_new).toBeUndefined();
});

it("forgets a pending session when the session is deleted", async () => {
  useRuntimeStore.setState({
    sessions: [{ id: "ses_new", title: "New session" }],
    locallyCreatedSessions: { ses_new: { id: "ses_new", title: "New session" } },
  });

  await useRuntimeStore.getState().deleteSession("ses_new");

  expect(useRuntimeStore.getState().locallyCreatedSessions.ses_new).toBeUndefined();
});
```

Also add `locallyCreatedSessions: {}` to the `useRuntimeStore.setState({ ... })` reset block in the file's `beforeEach` (near `threads: {}` and `currentId: null`).

- [ ] **Step 2: Run the new tests and verify they fail**

Run:

```bash
cd /opt/open-science-desktop/.worktrees/web-chat-interruption-recovery-20261102
node scripts/dev/safe-desktop-task.mjs test src/lib/runtime.store.test.ts -t "keeps a just-created Web session"
```

Expected: FAIL because `locallyCreatedSessions` does not exist and the catalogue refresh drops `ses_new`.

- [ ] **Step 3: Add the store field and the bounded constant**

In `apps/desktop/src/lib/runtime.ts`, add near the other module constants (after `let openSessionSeq = 0;`):

```ts
/** Hard bound on the sessions remembered while the catalogue catches up. */
const MAX_LOCALLY_CREATED_SESSIONS = 100;
```

Add to `RuntimeState` next to `sessions` and `sessionListComplete`:

```ts
/** Sessions this client created that the workspace catalogue has not returned
 *  yet. The catalogue indexes a conversation only after a history read; until
 *  then the optimistic row must survive refreshSessions, or missingSessionId
 *  will treat the new conversation as unavailable. */
locallyCreatedSessions: Record<string, SessionMeta>;
```

Add to the initial store state next to `sessions: []`:

```ts
  sessions: [],
  locallyCreatedSessions: {},
```

- [ ] **Step 4: Record the optimistic session in both maps**

Replace the return block in `performTurn` (the `return { currentId: id, ... }` around lines 2116-2128) with:

```ts
        let sessions = s.sessions;
        let locallyCreatedSessions = s.locallyCreatedSessions;
        if (isGatewayWeb && !s.sessions.some((session) => session.id === id)) {
          const created: SessionMeta = {
            id: id!,
            title: "New session",
            titlePresentation: {
              status: "pending" as const,
              fallback: titleExcerpt([{ type: "text", text: echo }]),
              pendingUntil: Date.now() + TITLE_WAIT_MS,
            },
            directory: s.workspace ?? undefined,
            created: Date.now(),
            updated: Date.now(),
          };
          sessions = [created, ...s.sessions];
          locallyCreatedSessions = Object.fromEntries(
            [...Object.entries(s.locallyCreatedSessions), [id!, created]]
              .slice(-MAX_LOCALLY_CREATED_SESSIONS),
          );
        }
        return {
          currentId: id,
          sessions,
          locallyCreatedSessions,
          threads,
          panes,
          sessionAgents,
          sendingSessions,
          sessionModels,
          sessionVariants,
          draftWorkspaces,
        };
```

- [ ] **Step 5: Merge pending sessions in refreshSessions and remove confirmed ones**

In `refreshSessions`, inside the `set((s) => { ... })` that receives the fetched list, add before the `sessionParents` / `sessionModels` work:

```ts
        // The catalogue is an asynchronous read model. A conversation this
        // client just created is not in it until its first history read is
        // indexed; keep the optimistic row until the catalogue returns it.
        const freshIds = new Set(sessions.map((session) => session.id));
        const pending = Object.entries(s.locallyCreatedSessions)
          .filter(([id]) => !freshIds.has(id))
          .map(([, session]) => session)
          .sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
        const locallyCreatedSessions = Object.fromEntries(
          Object.entries(s.locallyCreatedSessions).filter(([id]) => !freshIds.has(id)),
        );
```

Change the returned object to:

```ts
        return {
          sessions: [...pending, ...sessions],
          sessionParents,
          sessionModels,
          sessionListReady: true,
          sessionListComplete: s.sessionListComplete,
          locallyCreatedSessions,
        };
```

- [ ] **Step 6: Clear the map with the other session state**

In `clearPlatformPresentation`, add `locallyCreatedSessions: {}` to the large `set({ ... })` reset object.

In `selectGatewayRuntime`'s reset object (the one containing `sessions: []`, `sessionListReady: false`, ...), add:

```ts
        locallyCreatedSessions: {},
```

In `deleteSession`, add to the `set((s) => ({ ... }))` result:

```ts
        locallyCreatedSessions: Object.fromEntries(
          Object.entries(s.locallyCreatedSessions).filter(([id]) => id !== id),
        ),
```

The filter uses the outer `deleteSession` argument named `id`; shadowing is avoided by naming the entry key:

```ts
        locallyCreatedSessions: Object.fromEntries(
          Object.entries(s.locallyCreatedSessions).filter(([sessionId]) => sessionId !== id),
        ),
```

- [ ] **Step 7: Run the focused tests and verify they pass**

Run:

```bash
cd /opt/open-science-desktop/.worktrees/web-chat-interruption-recovery-20261102
node scripts/dev/safe-desktop-task.mjs test src/lib/runtime.store.test.ts -t "just-created Web session"
node scripts/dev/safe-desktop-task.mjs test src/lib/runtime.store.test.ts -t "pending session with the catalogue entry"
node scripts/dev/safe-desktop-task.mjs test src/lib/runtime.store.test.ts -t "forgets a pending session"
```

Expected: PASS for all three.

- [ ] **Step 8: Commit**

```bash
cd /opt/open-science-desktop/.worktrees/web-chat-interruption-recovery-20261102
git add apps/desktop/src/lib/runtime.ts apps/desktop/src/lib/runtime.store.test.ts
git commit -m "fix(web): retain newly created sessions while the catalogue catches up"
```

---

### Task 2: Fetch history for a live-only thread that lacks the user message

**Files:**
- Modify: `apps/desktop/src/lib/runtime.ts` (`Thread`, `emptyThread` helper area, `openSession`, `loadHistory`, `reconcileRunning`, `revertToMessage`)
- Test: `apps/desktop/src/lib/runtime.store.test.ts`

**Interfaces:**
- Produces: `Thread.historyLoaded?: boolean`; `needsHistory(thread, sendInFlight): boolean`.
- Consumes: `Thread`, `openSession`, `loadHistory`, `reconcileRunning`, `revertToMessage`.

- [ ] **Step 1: Write the failing hydration tests**

Add to `apps/desktop/src/lib/runtime.store.test.ts` after the existing `openSession refetches a session whose history failed to load when reopened` test:

```ts
it("openSession loads history for a live-only thread that has no user message", async () => {
  mocks.messages = [
    { role: "user", parts: [{ type: "text", text: "first question" }] },
    { role: "assistant", parts: [{ type: "text", text: "first answer" }] },
  ];
  useRuntimeStore.setState({
    sessions: [{ id: "ses_live", title: "Live", directory: "/ws/base" }],
    currentId: null,
    threads: {
      ses_live: {
        blocks: [{ kind: "agent", markdown: "first answer" }],
        index: {},
        loaded: true,
      },
    },
  });

  await useRuntimeStore.getState().openSession("ses_live");

  expect(mocks.getMessages).toHaveBeenCalledWith("ses_live");
  const thread = useRuntimeStore.getState().threads.ses_live;
  expect(thread.historyLoaded).toBe(true);
  expect(thread.blocks[0]).toMatchObject({ kind: "user", text: "first question" });
});

it("openSession keeps an optimistic send transcript that has no confirmed history", async () => {
  useRuntimeStore.setState({
    sessions: [{ id: "ses_new", title: "New session", directory: "/ws/base" }],
    currentId: null,
    threads: {
      ses_new: {
        blocks: [
          { kind: "user", text: "hello" },
          { kind: "status-line", text: "Failed to send", tone: "error" },
        ],
        index: {},
        loaded: true,
      },
    },
  });

  await useRuntimeStore.getState().openSession("ses_new");

  expect(mocks.getMessages).not.toHaveBeenCalled();
  const thread = useRuntimeStore.getState().threads.ses_new;
  expect(thread.blocks[0]).toMatchObject({ kind: "user", text: "hello" });
  expect(thread.blocks[1]).toMatchObject({ kind: "status-line", text: "Failed to send" });
});

it("openSession does not replace a send in flight with pre-prompt history", async () => {
  useRuntimeStore.setState({
    sessions: [{ id: "ses_new", title: "New session", directory: "/ws/base" }],
    currentId: null,
    sendingSessions: { ses_new: true },
    threads: { ses_new: { blocks: [], index: {}, loaded: true } },
  });

  await useRuntimeStore.getState().openSession("ses_new");

  expect(mocks.getMessages).not.toHaveBeenCalled();
  expect(useRuntimeStore.getState().threads.ses_new.blocks).toEqual([]);
});

it("openSession does not refetch a confirmed assistant-only history", async () => {
  useRuntimeStore.setState({
    sessions: [{ id: "ses_history", title: "History", directory: "/ws/base" }],
    currentId: null,
    threads: {
      ses_history: {
        blocks: [{ kind: "agent", markdown: "only answer" }],
        index: {},
        loaded: true,
        historyLoaded: true,
      },
    },
  });

  await useRuntimeStore.getState().openSession("ses_history");

  expect(mocks.getMessages).not.toHaveBeenCalled();
});

it("loadHistory hydrates a live-only background pane", async () => {
  mocks.messages = [{ role: "user", parts: [{ type: "text", text: "background question" }] }];
  useRuntimeStore.setState({
    currentId: "ses_other",
    threads: {
      ses_bg: { blocks: [{ kind: "agent", markdown: "live answer" }], index: {}, loaded: true },
    },
  });

  await useRuntimeStore.getState().loadHistory("ses_bg");

  expect(mocks.getMessages).toHaveBeenCalledWith("ses_bg");
  expect(useRuntimeStore.getState().threads.ses_bg.blocks[0]).toMatchObject({
    kind: "user",
    text: "background question",
  });
});
```

- [ ] **Step 2: Run the new tests and verify they fail**

Run:

```bash
cd /opt/open-science-desktop/.worktrees/web-chat-interruption-recovery-20261102
node scripts/dev/safe-desktop-task.mjs test src/lib/runtime.store.test.ts -t "live-only thread"
```

Expected: FAIL because `openSession` returns early on the seeded `loaded: true` thread and never calls `getMessages`.

- [ ] **Step 3: Add the thread flag and the shared predicate**

In `apps/desktop/src/lib/runtime.ts`, add to `Thread` after `loaded`:

```ts
  /** True only after a server history read succeeded. Live SSE folds and the
   *  optimistic send echo set `loaded` so the pane can paint, but neither
   *  contains earlier user messages. */
  historyLoaded?: boolean;
```

After `const emptyThread = ...`, add:

```ts
/** Whether opening this thread must fetch the server history.
 *
 *  A live SSE fold or a new send's optimistic echo sets `loaded`, but only a
 *  successful history read sets `historyLoaded`. A live-only thread with no
 *  user block is the reload-during-a-running-turn case: its first user message
 *  exists only in the server history. An optimistic send (a user block) and a
 *  send in flight are authoritative until the prompt is accepted; replacing
 *  them with the empty pre-prompt history would destroy the message and any
 *  failure line. */
function needsHistory(thread: Thread | undefined, sendInFlight: boolean): boolean {
  if (!thread?.loaded || thread.historyError) return true;
  if (thread.historyLoaded || sendInFlight) return false;
  return !thread.blocks.some((block) => block.kind === "user");
}
```

- [ ] **Step 4: Use the predicate in openSession and loadHistory**

In `openSession`, replace the line:

```ts
    if (get().threads[id]?.loaded && !get().threads[id]?.historyError) return;
```

with:

```ts
    if (!needsHistory(get().threads[id], !!get().sendingSessions[id])) return;
```

Update the comment above it to explain the live-only case instead of the old "loaded closes the door" text.

In `loadHistory`, replace:

```ts
    if (cur?.loaded && !cur?.historyError) return;
```

with:

```ts
    if (!needsHistory(cur, !!get().sendingSessions[id])) return;
```

Update the comment above it.

After the fetch in `loadHistory`, replace the post-fetch skip:

```ts
      const latest = get().threads[id];
      if (latest?.loaded && !latest?.historyError) return;
```

with:

```ts
      const latest = get().threads[id];
      if (latest?.historyLoaded && !latest?.historyError) return;
```

Update the comment to say a live fold sets `loaded` but never `historyLoaded`, so it must not swallow the reload.

- [ ] **Step 5: Mark every successful history-producing path**

Add `historyLoaded: true` to the thread object in each of these four sites:

- `openSession` success: `[id]: { ...historyToThread(messages, s.commands, serverIdle, interruptions), loaded: true, historyLoaded: true }`
- `loadHistory` success: `threads: { ...s.threads, [id]: { ...historyToThread(messages, s.commands, serverIdle, interruptions), loaded: true, historyLoaded: true } }`
- `reconcileRunning` success: `[sid]: { ...historyToThread(messages, s.commands, serverIdle, interruptions), loaded: true, historyLoaded: true }`
- `revertToMessage`: `set(s=>({threads:{...s.threads,[sid]:{...historyToThread(visible,s.commands,true),loaded:true,historyLoaded:true}}}));`

Do not add the flag to the optimistic echo, the SSE fold, the error-line append, the interruption line, or the auto-review append.

- [ ] **Step 6: Run the hydration tests and the existing history tests**

Run:

```bash
cd /opt/open-science-desktop/.worktrees/web-chat-interruption-recovery-20261102
node scripts/dev/safe-desktop-task.mjs test src/lib/runtime.store.test.ts -t "live-only thread"
node scripts/dev/safe-desktop-task.mjs test src/lib/runtime.store.test.ts -t "openSession"
node scripts/dev/safe-desktop-task.mjs test src/lib/runtime.store.test.ts -t "loadHistory"
```

Expected: the new tests pass, and the existing openSession/loadHistory tests pass. If an existing test seeds a loaded assistant-only thread and expects no fetch, set `historyLoaded: true` on that fixture to express a confirmed history; do not weaken the gate.

- [ ] **Step 7: Commit**

```bash
cd /opt/open-science-desktop/.worktrees/web-chat-interruption-recovery-20261102
git add apps/desktop/src/lib/runtime.ts apps/desktop/src/lib/runtime.store.test.ts
git commit -m "fix(web): hydrate live-only conversations from server history"
```

---

### Task 3: Full verification and code review

**Files:**
- Read: the complete diff from `d85...` to HEAD in the worktree.

- [ ] **Step 1: Run typecheck and lint**

```bash
cd /opt/open-science-desktop/.worktrees/web-chat-interruption-recovery-20261102
node scripts/dev/safe-desktop-task.mjs typecheck
node scripts/dev/safe-desktop-task.mjs lint
```

Expected: both exit 0. Lint may retain the pre-existing `ProjectEnvironmentPanel.tsx` warning; there must be no new errors.

- [ ] **Step 2: Run the full frontend suite**

```bash
cd /opt/open-science-desktop/.worktrees/web-chat-interruption-recovery-20261102
node scripts/dev/safe-desktop-task.mjs test
```

Expected: all tests pass; record the pass/skip counts. If the host memory guard stops the task, inspect the log and rerun the focused selection; do not remove the guard.

- [ ] **Step 3: Review the complete diff**

Use the `code-review` skill on the diff. Verify:
- no new `historyLoaded` assignment on live-only paths;
- no duplicate session rows after merge;
- the pending map is cleared on delete/runtime switch/account reset;
- no unrelated change to the live-source baseline (the pre-existing uncommitted notification/SessionView changes are not ours);
- no i18n strings were added.

Address confirmed findings with a new failing test first, then re-run the focused tests.

- [ ] **Step 4: Commit any review fixes**

```bash
cd /opt/open-science-desktop/.worktrees/web-chat-interruption-recovery-20261102
git add apps/desktop/src/lib/runtime.ts apps/desktop/src/lib/runtime.store.test.ts
git commit -m "fix(web): address review findings for session hydration"
```

---

### Task 4: Publish the Web release and verify it

**Files:**
- Modify: `PROGRESS.md` in the worktree (one new line at the top).

- [ ] **Step 1: Inspect the release selection**

```bash
cd /opt/open-science-desktop/.worktrees/web-chat-interruption-recovery-20261102
pnpm web:release inspect --source /opt/open-science-desktop/.worktrees/web-chat-interruption-recovery-20261102
```

Confirm the selection includes the frontend/typecheck/lint/Web build stages and that the image is reused. Because `runtime.ts` is in the assistant-sensitive path, the tool may select the selected-assistant live gate; do not bypass it.

- [ ] **Step 2: Publish**

```bash
cd /opt/open-science-desktop/.worktrees/web-chat-interruption-recovery-20261102
pnpm web:release run --source /opt/open-science-desktop/.worktrees/web-chat-interruption-recovery-20261102
```

Expected: preparation passes, deployment reports `published`, the platform restarts and health returns 200, and the served bundle fingerprint matches the release manifest. If preparation fails, stop; production must remain on the previous bundle. If the assistant live gate fails, report the failure and do not claim publication.

- [ ] **Step 3: Verify health and the served bundle**

```bash
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4790/health
```

Read the new release manifest and confirm `status: published`, then compare the served `index.html` asset hash with the release's `web` manifest. Confirm `PLATFORM_WEB_ROOT` now points at the new release's `web` directory.

- [ ] **Step 4: Record the milestone**

Add one line at the top of the worktree `PROGRESS.md`:

```text
2026-11-03 HH:MM Published Web release <id>: a newly created conversation now survives the asynchronous catalogue refresh, and a live-only thread opened after a reload fetches server history so the first user message is shown; <test counts> passed, health 200.
```

Use the actual time, release id and counts from the commands above.

- [ ] **Step 5: Commit the release record**

```bash
cd /opt/open-science-desktop/.worktrees/web-chat-interruption-recovery-20261102
git add PROGRESS.md
git commit -m "docs: record new-session hydration release"
```

---

## Review amendments (implemented)

The code review found five reachable edge cases. These amendments were implemented and tested
before publication:

- **Pending sessions are an id set, not a snapshot.** `locallyCreatedSessions` is
  `Record<string, true>`; `mergeLocallyCreatedSessions` merges the current row from `sessions` for
  every pending id the new list lacks. It is used by `refreshSessions`, the managed bootstrap's first
  page, and the catalogue continuation pages. A pending id is removed on local delete, archive, a
  remote `session.deleted`, runtime/account reset, or when the catalogue returns it. The `present
  new-session` artifact path registers its dedicated session.
- **A send racing the hydration fetch is preserved.** `openSession` and `loadHistory` re-check
  `sendingSessions` and a newly appeared user block after the fetch; they do not overwrite the
  optimistic send with pre-prompt history.
- **History keeps the live-fold index.** `historyToThread` indexes text/reasoning by native part id,
  tool/presentation by call id, artifacts by path and review fences by part id. `HistoryPart` gains
  the native `id`. A later SSE event updates the persisted block instead of appending a duplicate.
- **Local SDK subpaths resolve to this checkout.** `apps/desktop/tsconfig.json` adds
  `"@ai4s/sdk/*": ["../../packages/sdk/src/*"]`; the worktree's shared `node_modules` symlink
  otherwise resolves `@ai4s/sdk/acp` to another checkout with older SDK types and typecheck fails.
- **Additional tests:** archived pending sessions are not resurrected; remotely deleted pending
  sessions are removed; a send that starts during history loading is not overwritten; a history
  text/tool block is updated (not duplicated) by a later live event.

Known non-blocking follow-up: `loadHistory`'s silent failure can retry on focus changes for a
desktop tiled background pane; the Web client's `webOrMobile` path does not run that background
load, so this is outside the current Web deliverable.
