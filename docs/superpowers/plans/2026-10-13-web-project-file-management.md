# Web Project and Workspace File Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans after user approval. Execute task-by-task with review checkpoints. Steps use checkbox syntax. Do not dispatch subagents unless the user separately authorizes delegation.

**Goal:** Deliver recoverable Web project and file management plus conflict-safe text saves without losing conversations, crossing account boundaries or overwriting AI changes.

**Architecture:** Add a platform-owned lifecycle/mutation coordinator over existing tenant authority and sandbox file RPC. Retain project directories for logical trash; journal file payload moves and upload commits. Reuse current React previews/editors and one explicit ID-based scope across the global, project and session explorers.

**Tech Stack:** React, TypeScript, Zustand, Radix, lucide, existing SDK, Node platform services, Rust descriptor-relative managed file policy, Vitest, Playwright and guarded package scripts.

**Spec:** `docs/superpowers/specs/2026-10-13-web-project-file-management-design.md`.
**Status:** Continued execution is authorized. Work remains isolated in `.worktrees/web-project-file-management-20261013` / `feat/web-project-file-management-20261013`, aligned with published recovery commit `5619e568` / release `1ebde999`; production source, bundle and image remain unchanged. Resumable uploads now pass 536 platform tests (8 conditional skips), 2,097 frontend tests (34 conditional skips), guarded lint/typecheck/build and actual platform-route browser scenarios at 1280/390/320 with deterministic file RPC. Browser cases include lost chunk replies, refresh/reselection, byte-for-byte final payload verification, cancellation and unchanged project/file behavior. Screenshots and overflow assertions were captured; image inspection is unavailable in this tool environment. Prior native checks passed 246 Core and 19 CLI tests. Checkpoint B remains incomplete: bounded file/trash pagination, general uncertain-operation recovery, complete historical root inventory and provenance are pending; text editing and new CI-attested image/release/live gates also remain pending.

---

## Execution Rules and Checkpoints

- Checkpoint A consists of Tasks 1-6: project management and lifecycle enforcement.
- Checkpoint B adds Tasks 7-10: native primitives, journaled files, uploads and file UI.
- Checkpoint C adds Tasks 11-12: conditional text editing and final integration.
- Each checkpoint must be independently usable, tested and reviewed before publishing. Do not label B/C delivered with only A implemented.
- Primary checkout is dirty and contains account recovery and other unrelated work. Before product edits, use an approved isolated workspace based on the effective published sources; do not wholesale merge main or another feature branch. Continued execution is authorized; do not delete real user data or publish an incomplete checkpoint.
- At execution time re-read `AGENTS.md`, active release and platform WorkingDirectory. The inspected release IDs below are evidence, not immutable assumptions.
- Run all frontend/platform/native tests and builds through guarded package scripts. Run heavy jobs serially. A production worker holding the task lock may require authorized maintenance; do not bypass the lock.
- Exclude live Claude. Do not activate Codex to satisfy this feature's tests. Deterministic Codex compatibility tests are mandatory while live service is unavailable.
- No permanent purge or automatic trash expiry. Synthetic acceptance data may be trashed/restored but no user data may be removed by implementation tools.

## File Ownership Map

Paths below refer to the effective published source baseline. Some platform/native files are absent from the dirty primary checkout; establish the baseline rather than inventing replacement copies.

| Files | Responsibility |
| --- | --- |
| `services/platform/src/workspace-management.mjs` (new) | Trusted scope resolution, capability checks and typed operation orchestration. |
| `services/platform/src/workspace-state.mjs` (new) | Versioned private records, receipts, tombstones, restart reconciliation. |
| `services/platform/src/workspace-admission.mjs` (new) | Account mutation/start gate and fail-closed execution checks. |
| `services/platform/src/workspace-routes.mjs` (new) | Strict authenticated JSON/binary management routes. |
| `services/platform/src/workspace-uploads.mjs` (new) | Chunk receipts, staging, quota reservation, cancel and finalization. |
| `services/platform/src/workspace-tickets.mjs` and `services/platform/test/workspace-tickets.test.mjs` (new) | Owned, generation-bound preview capabilities and legacy ticket rejection. |
| `services/platform/src/{platform-server,main,runtime-route-policy,sandbox-control-plane}.mjs` | Inject coordinator, protect existing routes, provide native RPC/status collaborators. |
| `services/platform/test/workspace-{management,state,admission,routes,uploads}.test.mjs` (new) | Synthetic account, lifecycle, crash and request-boundary tests. |
| `services/platform/test/{platform-server,cli-runtime,runtime-route-policy}.test.mjs` | Existing-route coverage and deterministic runtime compatibility. |
| `crates/osd-core/src/file_policy.rs`, `crates/osd-cli/src/managed.rs` | Bounded native stat/create/move/conditional-save operations and tests. |
| `apps/desktop/src/lib/workspaceManagement.ts` (new) | Typed scope/client, stable operation IDs and receipt lookup. |
| `apps/desktop/src/lib/workspaceManagement.test.ts` (new) | Wire format, ambiguity, permissions and context changes. |
| `apps/desktop/src/components/projects/ProjectActions.tsx` and `.test.tsx` (new) | Shared reachable action menu, rename/trash dialogs, success-only close. |
| `apps/desktop/src/components/files/{WorkspaceFileActions,WorkspaceTrashView,WorkspaceUploadQueue}.tsx` and corresponding tests (new) | File actions, restoration and independent workspace uploads. |
| `apps/desktop/src/components/files/useWorkspaceTextDraft.ts` and `.test.tsx` (new) | Scoped draft identity, revisions, conflict and dirty-navigation decisions. |
| `apps/desktop/src/app/routes/{ProjectsPage,FilesPage,LiveSessionPage}.tsx` | Project menus, explicit explorer scope, trashed deep-link state. |
| `apps/desktop/src/components/sidebar/Sidebar.tsx`, `components/session/SessionView.tsx`, `lib/runtime.ts` | Shared project actions, pane cleanup and lifecycle-aware discovery. |
| `apps/desktop/src/components/{files/FileContextMenu,inspector/FilePreviewInspector}.tsx`, `lib/artifactFile.ts` | Reuse previews/downloads; integrate file menus and conditional Web editing. |
| `apps/desktop/src/i18n/locales/{en,de,es,fr,ja,ko,zh-Hans}/{nav,pages,inspector,common}.json` | Menu/dialog/error/state translations following existing namespaces. |
| `apps/desktop/src/test/webProjectFiles.acceptance.test.mjs` (new) | Non-skipped checkpoint browser gates and explicit live acceptance mode. |
| `scripts/dev/{web-release,web-release.test,safe-desktop-task}.mjs`, `package.json` | Required browser gate, bounded live/native verification and release evidence. |

Do not split large unrelated modules. Limit integration edits to dependency injection and operation admission/access hooks; keep new business behavior in the focused files above.

## Task 1: Establish Scope Contracts and Permanent Reproductions

**Files:** `workspaceManagement.ts`, its test; existing project/Files tests and platform boundary tests.

- [ ] Inspect `git status --short`, `systemctl show osd-platform.service -p WorkingDirectory -p ExecStart`, and `pnpm web:release inspect --source "$PWD"`. Record effective Web/platform/image fingerprints and pending account-recovery contract. Expected: production identity known without changing it.
- [ ] Add failing tests asserting a reachable Rename/Trash menu in Web, correct project A files while B is focused, and explicit scope surviving refresh. Run `pnpm test src/app/routes/ProjectsPage.web.test.tsx src/app/routes/FilesPage.test.tsx`. Expected: missing action/scope failures, not environment/import failures.
- [ ] Add these client contracts; keep `SessionMeta`/runtime types unchanged:

```ts
export type WorkspaceScope =
  | { kind: "account" }
  | { kind: "project"; projectId: string }
  | { kind: "session"; sessionId: string };

export type FileOperation =
  | { kind: "createFile"; path: string; text: string }
  | { kind: "createDirectory"; path: string }
  | { kind: "move"; path: string; destinationPath: string; expectedRevision: string }
  | { kind: "trash"; path: string; expectedRevision: string }
  | { kind: "saveText"; path: string; text: string; expectedRevision: string };

export interface OperationReceipt {
  operationId: string;
  state: "pending" | "committed" | "failed";
  result?: { path?: string; revision?: string; trashId?: string };
  error?: { code: string; message: string };
}

export interface ManagedEntry {
  path: string;
  name: string;
  isDir: boolean;
  size: number;
  modified: number;
  revision?: string;
  capabilities: Array<"preview" | "download" | "rename" | "move" | "trash" | "edit">;
}
```

- [ ] Add client request tests for strict scope encoding, same-origin credentials, JSON body and stable operation ID. Do not implement UI behavior until its dependent server contract exists. Run `pnpm test src/lib/workspaceManagement.test.ts`; expected contract tests pass, UI reproductions stay tracked for Task 5.
- [ ] Commit only this task's files with `test(web): define project and file management contracts`. Track unresolved reproductions explicitly, not as skipped acceptance tests.

## Task 2: Durable Lifecycle State and Idempotency

**Files:** `workspace-state.mjs`, `workspace-state.test.mjs`.

- [ ] Write state tests for missing record -> active, same request replay -> one receipt, different body with same ID -> conflict, generation restart -> same account state, metadata quota exhaustion before any native move, and injected crash after each persisted phase.

```js
test("a reused operation ID cannot authorize different input", async () => {
  const state = await makeStateFixture();
  await state.prepare("user-a", "op-a", { kind: "trash", projectId: "project-a" });
  await assert.rejects(
    state.prepare("user-a", "op-a", { kind: "trash", projectId: "project-b" }),
    error => error.code === "operation_conflict"
  );
});
```

`makeStateFixture()` is a local test helper opening a unique temporary private data directory and an injected deterministic clock/fsync-fault hook; it creates no worker or real user project.
- [ ] Run `pnpm platform:test test/workspace-state.test.mjs`; expected missing state implementation failure.
- [ ] Implement exported `WorkspaceState({dataDir,clock,io})` with `open(userId)`, `prepare(userId,operationId,input)`, `advance(userId,operationId,phase,result)`, `receipt(userId,operationId)` and `reconcile(userId,inspectPayload)`. Canonicalize typed input before hashing; unknown fields are rejected upstream. Persist schema version 1 and phases `prepared`, `payload_committed`, `committed`/`failed` by temp-file/fsync/rename/parent-fsync. Map the first two phases to public receipt state `pending`. Private files are not tenant-controlled. Failed fsync never returns committed.
- [ ] Implement logical project tombstones keyed by stable user/project ID, storing verified original path, revision and deletion timestamp; never remove project metadata or runtime histories. Reserve bounded receipt metadata quota before admitting a payload move. Receipt lookup must reconcile pending payload identity before returning success. Bound the queue and page reads (100 entries/page); do not evict a pending receipt or retained trash record for capacity.
- [ ] Run the state suite; expected every fault point preserves evidence and yields one recoverable outcome. Commit `feat(platform): journal recoverable workspace operations`.

## Task 3: Trusted Scope and Runtime Mutation Admission

**Files:** `workspace-admission.mjs`, `workspace-management.mjs`, tests; `platform-server.mjs` start hooks.

- [ ] Write two-account scope tests plus a barrier test: a prompt enters while trash awaits status; exactly one operation gains admission, and the loser gets busy without modifying data. Include native Codex fixture, OpenCode child sessions, research/collaboration, pending approvals and environment jobs; unknown status -> 503.
- [ ] Run `pnpm platform:test test/workspace-admission.test.mjs test/workspace-management.test.mjs`; expected missing collaborator/gate failure.
- [ ] Implement `WorkspaceAdmission({resolveExecution})` with `mutate(userId,run)` and `start(userId,run)`. Use the same per-account serialized admission for both, revalidate runtime execution before commit and retain start ownership until acceptance/status tracking takes over. Restart checks live statuses before permitting mutation; do not equate empty local maps with idle.
- [ ] Implement `WorkspaceManagement({state,tenantPolicy,files,resolveContext,resolveProject,resolveSession,admission,recordProvenance})`. Expose `resolveScope(context,scope)`, `assertAccessible(context,target)`, `listProjects(context)`, `entries(context,scope,path)`, `patchProject(context,id,input)`, `trashProject(context,id,input)` and `restore(context,id,input)`. Project listings include an opaque revision computed from trusted existing metadata for trash preconditions. At A, entries use existing native list/read APIs and advertise preview/download only; B adds mutation revisions/capabilities. Resolve context anew for each action; reject foreign IDs before path use. Project ancestor checks must use canonical path-component boundaries.
- [ ] Reject structural/root/reserved targets, not just current project root. Gate all mutation/start integrations identified in the spec, including job monitors that start follow-up work. Project name/pin metadata patches are safe while a turn runs; project trash and filesystem commits are not.
- [ ] Run new suites plus `pnpm platform:test test/cli-runtime.test.mjs test/platform-server.test.mjs`; expected existing valid runtime workflows still pass. Commit `feat(platform): fence workspace changes against execution`.

## Task 4: Authenticated Routes and Legacy Access Enforcement

**Files:** `workspace-routes.mjs`, `workspace-tickets.mjs`, their tests, `main.mjs`, `platform-server.mjs`, `runtime-route-policy.mjs` and tests.

- [ ] Write HTTP tests for the spec's project/list/trash/restore/receipt endpoints, malformed fields, read-only connections, foreign Origin, foreign IDs, nested session paths, and archived project access through **every** old list/message/prompt/file/ticket route. Test old project DELETE cannot bypass recoverable lifecycle. Test private lifecycle fields/secrets never appear in event payloads.
- [ ] Run `pnpm platform:test test/workspace-routes.test.mjs test/runtime-route-policy.test.mjs`; expected missing route/access hook failures.
- [ ] Implement `createWorkspaceRoutes({management,uploads,authenticate,readJson,sendJson})`. `handle(request,response)` returns a handled boolean; the existing authenticated platform dispatcher invokes it before generic `/api` rejection. Obtain read-only access from the current server authorization contract; do not infer it from a browser checkbox. Strictly classify JSON fields and bound input bytes.
- [ ] Wire `WorkspaceManagement` in `main.mjs` using existing `workspaceFiles`/tenant collaborators. Filter both new and legacy project/session listing responses. Call lifecycle authorization before owned session reads, prompts/forks/moves, questions/permissions, task starts and file access; filter scoped events without clearing unrelated sessions. Reject managed legacy project DELETE with a management-required error rather than invoking marker removal.
- [ ] Implement `WorkspaceTickets({clock,resolveContext,assertAccessible,issueWorkerTicket,streamWorkerFile})` with `issue(userId,scope,path)` and `redeem(userId,ticket,response)`. Wrap each worker ticket in a cryptographically random platform capability with a 180-second lifetime and 256/account map bound. Record resolved path/generation at issuance; verify current account, generation and lifecycle at redemption. Reject raw worker tickets, remove capabilities on logout/generation change and keep bearer tokens out of URLs. Existing `/v1/fs/ticket` and read routes use this adapter. Test an issued ticket before/after trash and renewal after restore; active downloads/preview must keep working.
- [ ] Run `pnpm platform:test`; expected full platform suite passes, including deterministic Codex and active-project previews. Commit `feat(platform): enforce project lifecycle on public access`.

## Task 5: Shared Project Actions and Explicit Project Files

**Files:** `ProjectActions.tsx`/test, `workspaceManagement.ts`/test, ProjectsPage, Sidebar, FilesPage, runtime store, LiveSessionPage; locale JSON.

- [ ] Extend Task 1 reproductions for rename failure/input retention, duplicate clicks, read-only state, cancel, busy trash, success-only close and restored session reopening. Test account/logout switch during responses and preservation of unrelated panes/drafts.
- [ ] Run `pnpm test src/components/projects/ProjectActions.test.tsx src/app/routes/ProjectsPage.web.test.tsx src/app/routes/FilesPage.test.tsx`; expected failed visibility/lifecycle cases.
- [ ] Implement typed `workspaceRequest(path,init)` using existing gateway auth/origin conventions and `mutateWorkspace(scope,operation,operationId)` against the new API. Handle ambiguous transport/5xx outcomes by querying `/api/workspace/operations/:id`; preserve operation ID until resolved. Do not use the generic mutating retry loop.

```ts
export async function mutateWorkspace(
  scope: WorkspaceScope, operation: FileOperation, operationId: string,
): Promise<OperationReceipt> {
  return workspaceRequest("/api/workspace/operations", {
    method: "POST",
    body: JSON.stringify({ scope, operation, operationId }),
  });
}
```

- [ ] Implement one `ProjectActions` menu for Sidebar/ProjectsPage with New Conversation, Open Files, Rename, Pin and Trash. Use existing new-conversation transition. Capture account/project/leaf binding for late-result fencing. Use server acknowledgement before removing panes or lists; retained error text/input stays inside dialog.
- [ ] Give FilesPage an explicit optional `scope` prop defaulting to account. Encode project selection in a validated URL query or pane state; do not change runtime workspace just to browse. Trashed deep links display Restore/Back state and never silently create a session. Keep the existing desktop folder button behavior.
- [ ] Translate every new visible label/error in the seven existing locales. Run focused suites, `pnpm typecheck` and `pnpm lint`; expected passing tests and no native-only controls in Web. Commit `feat(web): complete project management actions`.

## Task 6: Checkpoint A Browser Gate and Release Review

**Files:** `webProjectFiles.acceptance.test.mjs`, web-release scripts/tests, safe task guard as necessary.

- [ ] Add required browser cases at 1280/390/320 for A01-A08, including project A files while B is focused, cancelled trash, active task busy, trash/restore/reload and old direct URL denial. Use synthetic platform fixtures and deterministic runtime replies, not real deletion of user data.
- [ ] Register the acceptance file as a required non-skipped gate. Add a release-script unit test that missing/skipped/failing management browser results block publication. Run `pnpm release:test`; expected release regressions pass.
- [ ] Run `pnpm web:release prepare --source "$PWD" --maintenance`. Expected guarded lint/typecheck/frontend/platform/build/browser stages pass; this prepares a candidate but does not publish it.
- [ ] Include internal symlink alias reads in lifecycle denial checks. If the old worker cannot prove no-follow file access, keep A unpublished until the native primitive image supplies that guarantee. Inspect manifest/images and review A with the user. Confirm no native image input changed if reusing the current image. Do not publish merely because a plan exists. On explicit deployment approval, use `pnpm web:release deploy --release <prepared-id>` with the actual ID from preparation, then verify served assets and live OpenCode rename/trash/restore on a dedicated acceptance project.
- [ ] Commit gate changes as `test(web): gate recoverable project management`; add a truthful PROGRESS milestone recording A's actual verification and any blocker.

## Task 7: Native File Primitives and Conditional Revisions

**Files:** `crates/osd-core/src/file_policy.rs`, `crates/osd-cli/src/managed.rs`, inline Rust tests; native RPC contract tests.

- [ ] Add Rust tests named with `workspace_management` for no-replace create/move, revision mismatch, directory-into-descendant rejection, symlink parent swaps, special files, invalid roots, destination collision and restart-safe staging identity.
- [ ] Run `pnpm sandbox:core:test --package osd-core workspace_management` and `pnpm sandbox:core:test --package osd-cli workspace_management` serially. Expected failing new contract tests without weakening existing policy tests.
- [x] Add exact RPC operations `stat`, `readText`, `createText`, `moveNoReplace` and `saveTextIfRevision`. Strict fields: stat/read=`operation,root,path`; create=`operation,root,path,text`; move=`operation,root,path,destinationPath,expectedRevision`; save=`operation,root,path,text,expectedRevision`. These privileged calls accept `root:'workspace'` only. Platform constructs account-relative paths from trusted scopes.
- [x] Implement stat revisions from descriptor-opened identity/type/size/high-resolution change timestamps. `readText` reads <=2 MiB from one regular-file descriptor and returns `{text,revision}` including SHA-256; compare descriptor identity/timestamps before and after and fail on change. No-follow both directory chains, reject special files, use Linux `renameat2(RENAME_NOREPLACE)` on pinned parent descriptors for moves. Publish new text with exclusive no-replace semantics. Conditional save compares the full returned text revision and atomically replaces only under account admission; do not claim safety against out-of-band privileged administrator writes.
- [x] Preserve current native methods and old RPC schemas. Internal staged payload creation uses exclusively generated reserved names. Run both test suites and `pnpm sandbox:core:check --package osd-core`, `pnpm sandbox:core:check --package osd-cli` serially; expected pass. Commit `feat(core): add protected workspace mutation primitives` (`c1bbe40`; managed internal symlink aliases are intentionally rejected for lifecycle safety).
- [ ] Obtain a production CI-attested image carrying these exact core/CLI bytes before B deployment. No local unguarded Cargo/image build and no fabricated digest. If artifact unavailable, continue deterministic tests but mark publication blocked.

## Task 8: Journaled File Operations and Recovery

**Files:** `workspace-management.mjs`, `workspace-state.mjs`, tests; new file routes.

- [ ] Write B01-B04 tests with fake native RPC and injected crashes immediately before/after fsync, rename, result persistence and response delivery. Include missing restore parent, collision, trashed owning project and root-ancestor protection.

```js
test("a lost trash response resolves without moving twice", async () => {
  const fixture = await makeManagementFixture();
  const request = fixture.trashRequest("reports/result.txt", "op-trash");
  fixture.dropNextResponse();
  await assert.rejects(fixture.submit(request));
  const receipt = await fixture.receipt("op-trash");
  assert.equal(receipt.state, "committed");
  assert.equal(fixture.nativeMoves.length, 1);
  assert.equal(await fixture.payloadText(receipt.result.trashId), "result");
});
```

`makeManagementFixture()` creates two synthetic accounts with in-memory native payload identities, deterministic revisions and a response-drop hook; it never resolves a real production account.
- [ ] Run `pnpm platform:test test/workspace-management.test.mjs test/workspace-state.test.mjs`; expected new operation failures.
- [ ] Extend `entries(context,scope,path)` with Task 7 revisions/capabilities; add `operate(context,{scope,operation,operationId})`, `trash(context,input)` and file restoration to `WorkspaceManagement`. Use Task 7 RPC for new mutations. Rename maps to move with same parent. Journal trusted source, destination, revision/identity before each native change and reconcile by identity after restart. Keep pending on indeterminate native state; block a second operation on affected paths.
- [ ] Store trash payload under reserved account path `.scikeel/workspace-management/trash/<trashId>/payload`; platform owns its receipt and public policy denies direct normal access. Restoration destination may differ only within original scope. No client-supplied trash path or recursive deletion. Add internal regular-staging-file cancellation only with matching receipt.
- [ ] Implement route allowlists and permission/error mapping for file operations. Emit provenance after committed receipt; failure cannot roll back saved data or replay payload. Run `pnpm platform:test`; expected pass. Commit `feat(platform): add recoverable workspace file operations`.

## Task 9: Bounded Workspace Uploads

**Files:** `workspace-uploads.mjs`, tests, routes, client upload methods and tests.

- [x] Write B05 tests for 25 MiB cap, 256 KiB chunks, two active uploads, quota failures, cancel, duplicate chunk, wrong offset/hash, final collision, response loss, restart and foreign owner/generation changes.
- [x] Run `pnpm platform:test test/workspace-uploads.test.mjs test/workspace-routes.test.mjs`; expected missing upload receipt/state failures.
- [x] Implement `WorkspaceUploads({state,files,management,quota,clock})` with `begin`, `inspect`, `chunk`, `commit`, `cancel`, `expireOrphans`. Use existing quota authority; fail closed if reservation cannot be enforced. Server hashes received chunks and rechecks staged bytes against receipts before computing full SHA-256 at commit. Validate an optional declared full-file hash; browsers need not buffer files or hand-roll crypto. No server full-file buffer or shared conversation attachment ownership.
- [x] Route binary PUT through a bounded raw reader, never the generic JSON reader. Persist confirmed offset/chunk hash before returning acknowledgement; journal final no-replace publication under Task 3 admission. Commit ambiguity resolves through original operation receipt. Expire only 24-hour uncommitted staging proven owned by receipts.
- [x] Implement client upload queue with one active chunk per file, progress/cancel/receipt lookup and no new account reuse. Run platform tests and `pnpm test src/lib/workspaceManagement.test.ts`; expected pass. Commit `feat(web): add scoped resumable workspace uploads`.

## Task 10: File Actions, Trash UI and Checkpoint B

**Files:** file action/trash/upload components and tests, FilesPage, FileContextMenu, FilePreviewInspector, locale JSON; acceptance tests.

- [ ] Write UI tests for create/rename/move/trash/restore dialogs, busy/error retention, no overwrite, missing parent, read-only, payload-preserving cancel, and menu accessibility at phone widths. Test project roots/structural folders never gain generic file trash actions.
- [ ] Run focused `pnpm test src/components/files src/app/routes/FilesPage.test.tsx`; expected missing actions fail.
- [ ] Add toolbar icons and per-row menus with shared action definitions for global/project/session explorers. Use explicit ID scope from Task 5. Show Trash as a view, not a native folder. Use server capabilities for editability and protected targets; client checks are supplemental. On commit invalidate affected list/preview paths, retain unrelated pane state and show unknown receipt state until resolved.
- [ ] Extend required acceptance with B01-B06 at 1280/390/320, including uploading cancel/resume and crash recovery via fixture restarts. Run focused tests, `pnpm typecheck`, `pnpm lint`, and `pnpm platform:test` serially. Expected pass.
- [ ] Commit `feat(web): complete workspace file management`. Prepare checkpoint B with `pnpm web:release prepare --source "$PWD" --maintenance`; require the new attested image and all browser gates, review before deploying. A missing image is explicitly blocked, never bypassed or replaced by a passing UI test.

## Task 11: Scoped Text Drafts and Conflict-Safe Save

**Files:** `useWorkspaceTextDraft.ts`/test, workspace client, `workspace-management.mjs`, `workspace-routes.mjs` and tests, FilePreviewInspector/test, artifactFile/test, FilesPage, dirty navigation integration and locales.

- [ ] Write C01-C04 tests: normal save, external AI edit before save, unchanged file at a different path, generation/account switch, binary/size refusal, Save As collision, cancelled navigation, and write success followed by failed provenance.

```ts
it("keeps the draft after a revision conflict", async () => {
  const editor = makeDraftFixture({ path: "notes.md", text: "old", revision: "r1" });
  editor.type("my draft");
  editor.diskChanges("AI revision", "r2");
  await editor.save();
  expect(editor.state()).toMatchObject({ draft: "my draft", conflict: true, dirty: true });
  expect(editor.diskText()).toBe("AI revision");
});
```

`makeDraftFixture()` exercises the hook through a small rendered harness and injected typed read/save clients. Its conflict response is the real structured `409 revision_conflict` contract, not an untyped thrown string.
- [ ] Run `pnpm test src/components/files/useWorkspaceTextDraft.test.ts src/components/inspector/FilePreviewInspector.web.test.tsx`; expected missing Web editing behavior.
- [ ] Implement `WorkspaceManagement.text(context,scope,path)` using Task 7 `readText` and lifecycle/reserved-file checks; expose the strict `GET /api/workspace/text` route. Test consistent text/revision pairing and byte/encoding rejection in platform tests. Add `readText(scope,path)` and `saveText(scope,path,text,expectedRevision,operationId)` client wrappers; `saveText` calls typed `operate` through Task 5 client. Introduce `useWorkspaceTextDraft({scope,path,accountId,readText,saveText})` returning text, draft, revision, dirty, saving, conflict, error and `edit`, `save`, `reload`, `saveAs`, `confirmDiscard`. Scope/path/account identity owns the draft; generation is revalidated by server.
- [ ] Enable Web Edit only on server-confirmed UTF-8 regular text <=2 MiB. Preserve desktop editing/autosave as a separate branch. Implement explicit Save, conflict Reload with discard confirmation and no-replace Save As; never expose force-overwrite. Coordinate route/logout/pane/move/trash dirty guards with current account recovery contract instead of adding a second competing logout flow.
- [ ] Publish returned revision only after committed receipt; history failure is saved-with-warning, not unsaved. Local git remains best-effort, never a gate pretending to provide distributed transactional safety. Run focused suites, `pnpm typecheck`, `pnpm lint`; expected pass. Commit `feat(web): save workspace text without overwriting changes`.

## Task 12: Checkpoint C, Live Evidence and Compatible Rollback

**Files:** browser acceptance, release scripts/tests, guarded task entry and PROGRESS only.

- [ ] Extend required browser cases C01-C04 across 1280/390/320: edit/save/reload, AI-version conflict, Save As, dirty cancel and ownership switch. Assert no horizontal overflow or unreachable controls; inspect screenshots. Do not substitute fixture responses for real OpenCode transport evidence.
- [ ] Add version-compatibility release test: once lifecycle schema is used, an incompatible previous backend/bundle cannot serve normal account traffic after rollback. Restore compatible guards or enforce maintenance/read-only before serving. Data/receipts/trash survive rollback and no runtime prompt bypass appears.
- [ ] Run `pnpm release:test`, core package tests/checks, frontend/platform suites and guarded typecheck/lint sequentially. Prepare the frozen C release through `pnpm web:release prepare --source "$PWD" --maintenance`; require exact image/source/served-asset identity and all browser gates. Do not copy an arbitrary build into the live webroot.
- [ ] Review checkpoint evidence, then publish only after deployment approval with the actual prepared release ID. Use release tool rollback with the **failed current transaction ID**, not its previous ID, and retain compatible lifecycle protection during recovery.
- [ ] Use a new synthetic acceptance project on real enabled OpenCode for create/rename, streamed reply, scoped file read, file trash/restore, text save, project trash/restore and reopened history at all three widths. Real-session history IDs and directory must match before/after. Keep acceptance evidence/data; no purge. Record unavailable Codex as unavailable with deterministic compatibility evidence, and do not claim real dual-runtime acceptance.
- [ ] Commit `test(web): verify complete project and file workflows`. Add one English newest-first PROGRESS line per actual checkpoint, with exact counts/release/image evidence and remaining blockers. Do not pre-mark this plan complete.

## Spec Coverage and Review

| Requirements | Tasks |
| --- | --- |
| A01-A04 menus, rename, permissions and scope | 1, 4, 5, 6 |
| A05-A07 recoverable lifecycle, legacy routes, restart | 2, 3, 4, 5, 6 |
| A08 ownership and late responses | 1, 3, 4, 5, 9, 11 |
| B01-B04 file safety, trash and recovery | 2, 7, 8, 10 |
| B05 uploads and quota | 9, 10 |
| B06 execution admission race | 3, 4, 8, 9, 11 |
| C01-C04 editing, conflict, drafts and provenance | 8, 11, 12 |
| R01-R03 bounded verification, runtime evidence, image and rollback | 6, 7, 10, 12 |

Self-review checks: every spec acceptance ID is mapped; all mutations resolve trusted scope; project paths stay stable; native image changes are explicit; old routes cannot bypass lifecycle; operation ID and revision wire names match across tasks; unknown execution/recovery state fails closed; no permanent-delete task contradicts the initial safety boundary.

Execution is in progress following the user's continuation request. Do not dispatch agents or deploy solely because this document exists. Preserve the checkpoint review and data-retention boundaries.
