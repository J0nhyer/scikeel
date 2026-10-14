# Web Project and Workspace File Management Design

**Date:** 2026-10-13
**Status:** User requested continued execution after the spec/plan on 2026-10-13. Checkpoint A implementation is in progress in an isolated workspace; nothing has been deployed. Synthetic tests may exercise recoverable deletion; no real user data may be deleted.
**Scope:** Public multi-user gateway Web, including 1280, 390 and 320 pixel viewports. Preserve desktop compilation and existing runtime adapters.
**Policy:** Continued execution uses the previously recommended recoverable project/file deletion boundary. Permanent purge remains excluded.

## 1. Goal and Delivery Boundaries

Complete ordinary project and workspace management without breaking existing conversations or permitting cross-account file access. Deliver three independently testable checkpoints in order:

1. **A: Project management:** rename, pin, open files, trash and restore projects, with session lifecycle enforcement.
2. **B: File management:** create, upload, rename, move, trash and restore files/directories, with durable recovery.
3. **C: Text editing:** bounded UTF-8 editing, conditional saves, conflict resolution and provenance.

The first release supports recoverable deletion only. No permanent purge, automatic retention expiry, remote sync, terminal, host filesystem browser, arbitrary folder import, bulk operations, archive extraction, binary editor or runnable Web notebooks. Permanent purge needs a separate approved design for complete runtime history and attachment cleanup; the current recent-session list cannot prove such an inventory complete. Trash remains charged to the account's existing storage quota. This is an explicit data-safety boundary, not a hidden implementation omission. Before accepting trash, check the quota cost of receipt metadata; reject cleanly if even its bounded metadata cannot be persisted. Never lose a file to a move whose receipt could not be reserved.

## 2. Verified Current State

Inspection baseline: published Web release `2026-10-12T12-09-53-262Z-99537e6d`; platform service source `2026-10-11T19-55-20-683Z-4dcfb43d`. These source snapshots differ from the dirty primary checkout.

| Evidence | Finding |
| --- | --- |
| `apps/desktop/src/app/routes/ProjectsPage.tsx` and `components/sidebar/Sidebar.tsx` | Web hides rename/remove/pin along with genuinely native-only folder actions. |
| `apps/desktop/src/lib/tauri.ts` | Web rename, pin and remove adapters already exist. |
| `crates/osd-core/src/gateway.rs` | Project PATCH/DELETE/pin and file list/read/ticket routes exist. |
| `crates/osd-core/src/project.rs` | Managed Web removal unlinks project metadata only; workspace files remain. |
| `services/platform/src/runtime-route-policy.mjs` | Managed gateway routes are explicitly classified and validated. |
| `apps/desktop/src/app/routes/FilesPage.tsx` and `components/files/FileContextMenu.tsx` | Browsing, preview, refresh, scoped downloads and relative-path copying exist; file mutation controls do not. |
| `apps/desktop/src/lib/artifactFile.ts` and `components/inspector/FilePreviewInspector.tsx` | Text saves and editing are desktop-only. |
| `crates/osd-cli/src/managed.rs` and `crates/osd-core/src/file_policy.rs` | Managed read/chunk/write/mkdir/unlink primitives exist; no public file manager or no-replace move/revision-checked save contract exists. |

These are code findings, not new live mutation tests. The previous real OpenCode project test passed; real Codex was blocked by deployed runtime availability. Do not enable Codex or probe Claude as part of this feature.

## 3. Product Behavior

### 3.1 Projects

One shared action menu serves the project page and sidebar: New Conversation, Open Files, Rename, Pin/Unpin and Move to Trash. Every Web menu has an always reachable ellipsis button; desktop right-click is optional, not the sole entry. Native Reveal/Open Folder stays hidden.

Rename changes only metadata display name, never project ID, directory or existing session IDs. Trim whitespace; accept 1-240 UTF-8 bytes with no control characters. Duplicate display names are permitted because identity is the ID; file names follow different collision rules. Dialog retains the proposed name on failure and closes only after success. Busy state prevents duplicate submission. Project listing exposes an opaque metadata revision for the trash confirmation precondition; a changed record requires reconfirmation rather than deleting a stale selection.

Open Files resolves the selected project by ID, not the currently active runtime directory. Empty projects can open files without first creating a conversation. The existing global Files route stays an account-level explorer; project/session panes carry an explicit immutable scope.

Move to Trash shows the project name and explains that files and conversations are retained but normal access is disabled until restored. Confirmation does not silently stop running tasks. Reject with `409 workspace_busy` when relevant account work is active or waiting for approval. Unknown runtime status fails closed with `503 runtime_state_unknown`.

Project trash is a **logical tombstone**. Keep its metadata and folder at the original path; preserve all runtime histories and attachment copies. Hide the project and its conversations from normal lists. Direct session links show a recoverable unavailable state instead of starting a new conversation. Trash lists provide Restore. Restoration keeps the original ID/path/session IDs. It does not resume a stopped turn automatically.

A deleted project is not a filesystem confidentiality boundary: historical exported data, already downloaded bytes and same-account native filesystem access are not erased. The public application APIs and UI enforce lifecycle access. No claim of secure erasure or runtime-history encryption is made.

### 3.2 Files and Directories

The toolbar offers New File, New Folder, Upload and Refresh. Each row offers appropriate Preview, Download, Copy Relative Path, Rename, Move and Move to Trash actions. The move dialog selects a destination directory within the current scope; it does not accept an arbitrary host path. A Trash view exposes retained project and file entries, their original locations, deletion time and Restore.

Normal operations cannot mutate account/project/session roots or structural containers `projects` and `sessions`, registered project/session root directories, `.git`, `.openscience`, `.scikeel`, or the private staging/trash area. This protection also covers moving/deleting an ancestor of a registered root. Ordinary descendants remain editable. Global account browsing must resolve these boundaries from server metadata, not from the visible filename alone.

Reserved-component checks cover the complete account-relative target, including trusted project/session prefixes, and match case-insensitively. Browsing a reserved folder does not grant create/rename/move/trash capabilities. Platform workspace gateway JSON is streamed with a 16 MiB response cap, strict UTF-8 decoding and a 10,000-project inventory cap; oversized or invalid replies fail closed before granting authority. Legacy write admission remains held until its HTTP response finishes, not merely until forwarding begins. Authorized session Stop bypasses file-recovery admission while retaining normal account/session/origin checks; it cannot start new work.

Names are single path components: no slash/backslash, NUL, control characters, `.` or `..`; enforce 1-240 UTF-8 bytes and platform-reserved-name restrictions. Paths are scope-relative and normalized by existing policy helpers. Never overwrite a colliding file on create, rename, move, upload or restore. Return `409 name_conflict`; users choose a different name. A directory cannot move into itself or a descendant. No symlinks, special files, cross-account moves or cross-filesystem copy-and-delete fallback.

File trash moves the exact regular file/directory into an account-owned reserved payload location by no-replace descriptor-relative rename, and records its original scope/path. Restore moves it back without overwrite. If the original parent no longer exists, return `409 parent_missing`; allow an explicitly chosen existing directory within the same original scope. If the owning project is trashed, require restoring the project first. Do not nest new trash operations inside an already trashed directory.

File Trash offers both restoration to the original path and an explicit alternate-folder/name dialog. Its folder list uses the original scope, bounded pagination and server create capabilities. A collision retains the inputs; an unknown result freezes the original destination and operation ID until explicitly retried or resolved. A confirmed restoration followed by a list-refresh error remains confirmed and must not freeze the dialog as an unknown write.

After success, refresh affected directories and invalidate previews for moved/trashed paths. Dirty editor drafts are never silently discarded: cancel or explicitly discard before a move/trash; saving does not mean permission to delete. Project trash closes only that project's panes after acknowledgement; unrelated drafts and panes survive. Persisted pane/history restoration must also consult lifecycle state.

### 3.3 Uploads

Reuse authenticated request and existing native chunk primitives, not the conversation attachment store. Workspace uploads and conversation attachments remain separate ownership flows.

Initial limits: 25 MiB per file, 256 KiB per binary request chunk, one in-flight chunk per upload and two active uploads per account. These feature limits cannot exceed deployed transport/quota limits. Upload authorization checks account and scope at initialization, every chunk and commit. Reserve/check quota before allocation; release reservation on cancellation/failure; retained trash still uses quota.

Uploads stage under a server-reserved location, never the final filename. A receipt records upload ID, destination, declared size, confirmed offset and server-computed chunk hashes. Duplicate identical chunks at the last confirmed offset return the previous acknowledgement; mismatched/reordered chunks return `409 offset_conflict`. Finalization validates size and recorded chunk hashes, computes the full SHA-256 and atomically publishes without replacement under the mutation gate. An optional declared full-file SHA-256 must match if supplied; it is not required for browsers without secure-context crypto APIs. Progress, cancel and retry are visible. Refresh can recover an owned receipt; do not resume using a new account's credentials. Only orphan upload staging may expire, after 24 hours; never expire committed files or trash.

### 3.4 Text Editing

Reuse the current code editor and previews. Enable Edit only for existing regular UTF-8 text files up to 2 MiB. Do not offer Save for binaries, unsupported encodings, read-only scopes or reserved paths. Use explicit Save for the initial Web release rather than extending desktop autosave.

Reads return content plus an opaque revision bound to identity and content. Save supplies that revision and an operation ID. The native commit checks revision before atomic replacement; stale revision returns `409 revision_conflict` and preserves the draft. Offer Reload Disk Version with discard confirmation, or Save As to a new non-conflicting path. No Force Overwrite action. Display/surface save errors while preserving text. Navigation, logout and scope changes use dirty-draft confirmation, coordinated with the existing account lifecycle code.

Record successful manual writes, creates, uploads, renames, moves, trash and restores in the existing provenance flow using relative paths, operation ID and hashes, not full file content or credentials. Local git snapshots stay best-effort and local; never set a remote or push. A committed write followed by failed provenance is reported as saved with history-recording failure; retry the history action, not the write.

## 4. Architecture and Contracts

### 4.1 Ownership and Admission

Use a small platform `WorkspaceManagement` coordinator built from existing `tenantPolicy`, `workspaceFiles`, owned-session resolution and runtime/task status services. It owns lifecycle, durable receipts and bounded per-account mutation admission; it does not manipulate tenant files through Node host filesystem APIs. Platform private metadata uses its existing private data directory and atomic persistence.

Define `WorkspaceScope` as `{kind:'account'}`, `{kind:'project',projectId}` or `{kind:'session',sessionId}`. Server resolves IDs to trusted paths on every request. Account ownership survives worker restarts; each execution resolves and validates the current instance/generation. Never use a browser-supplied absolute directory as authority.

One per-account admission mechanism coordinates file mutations, project trash and every runtime/task start path: OpenCode, native Codex when enabled, collaboration, research, pending approvals and environment jobs. Conservative initial behavior rejects filesystem mutation if **any account execution** is active; rename/pin of a project display field may proceed. Hold admission through status revalidation and native commit. Unknown status rejects mutation. A process-local queue alone is not protection against already-running native writers.

All old public access paths must consult lifecycle too: `/v1/projects`, `/v1/fs/*`, OpenCode recent/full session queries, message reads, prompts/forks/moves, permissions, research/collaboration starts and scoped events. Project ownership includes nested session directories, not just equal paths. Server filtering must not leak archived session titles. A direct request to a trashed target returns `409 project_trashed` for an owned target; foreign/unknown IDs return `404`. Previously issued preview tickets must not remain an alternate public route into trashed projects. Account-local runtime database access is outside this UI lifecycle guarantee.

Keep existing `/v1/fs/ticket` and `/v1/fs/read?ticket=` URLs, but wrap managed worker tickets with a platform-owned opaque capability bound to user, resolved scope/path and current worker generation. Redeem requires the matching current authenticated account and a fresh lifecycle check, then streams the associated worker response. Use a 180-second maximum lifetime and a bounded map (256 capabilities/account); invalidate on account logout/generation change. Never forward unknown/pre-upgrade raw worker tickets. Refresh active previews to obtain a new capability. No public URL contains a gateway bearer token.

### 4.2 Public Management API

New endpoints live under authenticated platform `/api` routes; preserve existing desktop APIs. JSON mutations require same-origin checks, writable identity and strict field allowlists. Binary upload chunks use their own bounded body reader.

| Method and path | Contract |
| --- | --- |
| `GET /api/workspace/projects` | Active project records; reconciled lifecycle; existing creation stays `/v1/projects`. |
| `PATCH /api/workspace/projects/:id` | `{operationId,name?,pinned?}` with at least one field; ID/path immutable. |
| `POST /api/workspace/projects/:id/trash` | `{operationId,expectedRevision}`; return retained trash entry. |
| `GET /api/workspace/trash` | Owned project/file entries, bounded cursor pagination. |
| `POST /api/workspace/trash/:id/restore` | `{operationId,destinationPath?}`; alternate destination allowed only for files. |
| `GET /api/workspace/entries` | Encoded scope and path; bounded listing, server-resolved capabilities. |
| `GET /api/workspace/text` | Encoded scope and path; `{text,revision}` for editable text. |
| `POST /api/workspace/operations` | One typed file mutation with scope, operation ID and expected revision where applicable. |
| `GET /api/workspace/operations` | Owned pending receipts and saved-with-history-warning records, at most 100 per page; safe original-ID retries only, without payload text or private paths. |
| `GET /api/workspace/operations/:id` | Owned durable receipt: pending/committed/failed; reconcile uncertain results before retry. |
| `POST /api/workspace/operations/:id/resume` | `{operationId}` matching the path; explicitly resume an owned prepared text save after verifying the retained payload identity, revision and content hash. |
| `POST /api/workspace/operations/:id/history` | `{operationId}` matching the path; retry only the history record of an already committed file operation, never the payload mutation. |
| `POST /api/workspace/uploads` | `{scope,path,size,sha256?,operationId}`; upload receipt, optional declared full-file hash. |
| `GET /api/workspace/uploads` | At most two active owned receipts, including their original begin operation IDs, for refresh recovery without file bytes in browser storage. |
| `GET /api/workspace/uploads/:id` | Owned confirmed offset and state. |
| `PUT /api/workspace/uploads/:id/chunks?offset=N` | Bounded raw binary chunk. |
| `POST /api/workspace/uploads/:id/commit` | `{operationId}`; idle gate and no-replace commit. |
| `DELETE /api/workspace/uploads/:id` | Cancel owned uncommitted staging; committed uploads cannot be removed here. |

File operations are `createFile(path,text)`, `createDirectory(path)`, `move(path,destinationPath,expectedRevision)`, `trash(path,expectedRevision)` and `saveText(path,text,expectedRevision)`. Rename is same-parent move, not a second server implementation. Responses carry committed identity/revision and affected paths. Body limits, UTF-8 byte limits and capability checks are enforced server-side.

### 4.3 Durable State and Native File Policy

Private versioned account records contain project tombstones, file trash metadata, uploads and operation receipts. Each receipt includes user ID, operation ID, normalized request hash, trusted target and recovery phase. Reusing an operation ID with different input is `409 operation_conflict`. Ownership is account-persistent; generation is re-resolved, never persisted as permanent user identity.

Use `prepared -> payload_committed -> committed` for payload mutations. Persist/fsync the intended source/destination and entry identity before native action; record result afterwards. Recovery checks source/destination identities and content hashes: publish the existing result once, preserve pending on unknown state, and never guess by replaying the mutation. Same-account requests reconcile relevant pending receipts before reading changed paths. Reconcile before accepting new mutations after restart. Lost-response clients query the receipt instead of generating a fresh operation ID. These guarantees are initially limited to the existing single-platform-process deployment; distributed/multi-process mutation requires shared admission before scaling.

Extend `crates/osd-core/src/file_policy.rs` and `crates/osd-cli/src/managed.rs` with bounded stat/revision, a consistent text-and-revision snapshot read, no-replace move and create, and conditional text replacement. A text read uses the same opened descriptor for bytes and revision; reject/retry if identity/timestamps change during the read. Use the existing descriptor-relative policy and Linux no-follow/openat constraints. Final-name checks and rename must operate on trusted directory descriptors. No check-then-`std::fs::rename`, string-prefix sandbox, shell `mv/rm`, or general recursive deletion endpoint. Internal staging cleanup may remove only service-owned regular staging files whose receipt proves ownership.

Conditional text saves stage bounded UTF-8 bytes privately and persist the staged identity before dispatching `replaceTextFromStaging(operation,root,path,destinationPath,expectedRevision,expectedSourceRevision)`. The native primitive verifies both the current destination's text revision and the source's metadata revision on pinned descriptors before atomic replacement. Keeping the staged identity through replacement lets a lost response be reconciled without trusting equal text at a different inode. A failed receipt read is not proof that a write failed: keep the original operation ID and draft until an owned terminal receipt or an explicit original-ID retry resolves it. The platform journal never stores full text. Busy execution also fences provenance appends; recording failure remains a committed-file warning.

Adding native primitives requires a newly built, CI-attested sandbox image with matching source fingerprints. Checkpoint A may reuse the image if its inputs are unchanged; B/C cannot claim UI-only deployment or reuse the old image after changing native inputs.

## 5. UX and Failure Rules

Use existing Radix menus/dialogs, lucide icons and translations in all seven current locales. Preserve compact operational styling. Mobile menus/actions must be reachable without hover and fit 320 pixels. Rows and icon controls keep stable dimensions.

Read-only connections can browse/preview/download but cannot mutate, restore or upload. Disabled UI is supplemental; every server endpoint denies the same operation. Busy/failure dialogs retain inputs. Cancel changes nothing. On ambiguous network failure show an operation-checking state and retain the original operation ID. Account/context changes ignore late UI results without losing the server receipt. Refresh must not produce duplicate writes or uploads.

Workspace file preview/download links continue through the existing scoped file helpers, not direct OpenCode calls. Runtime calls continue through the SDK. Normal error bodies contain codes and bounded messages, no absolute private paths, provider secrets or content dumps.

## 6. Acceptance Matrix

| ID | Required result | Checkpoint |
| --- | --- | --- |
| A01 | Sidebar/project page menus reachable at 1280/390/320; native-only actions absent. | A |
| A02 | Rename updates both views after reload; ID/path/session history unchanged. | A |
| A03 | Failed rename retains input; read-only denial and same-account retry do not duplicate effects. | A |
| A04 | Open Files targets project A while runtime B is focused; works for empty project. | A |
| A05 | Trash/cancel/busy/unknown-state behavior; project bytes and history unchanged. | A |
| A06 | Trashed project/session absent from normal lists/events; direct and old file/ticket routes blocked. | A |
| A07 | Restore survives worker/platform restart; original session resumes only after explicit user send. | A |
| A08 | Foreign account IDs and paths denied; account-change late responses ignored. | A/B/C |
| B01 | Create file/folder, rename and move with name validation/no overwrite; descendant move rejected. | B |
| B02 | Roots, registered-root ancestors, reserved files, symlinks and cross-scope moves denied. | B |
| B03 | Trash/restore regular file and directory; conflict/missing parent/trashed project retain payload. | B |
| B04 | Crash at every receipt/native boundary and lost response reconcile to one result. | B |
| B05 | Chunked upload/progress/cancel/resume, wrong offset/hash/size, quota and account switching covered. | B |
| B06 | Runtime/task admission race denies unsafe mutation and does not silently abort tasks. | A/B/C |
| C01 | UTF-8 Save/reload persists correct scoped bytes; unsupported/binary/large text stays preview-only. | C |
| C02 | AI changes file before save: revision conflict preserves draft; Reload/Save As never overwrite. | C |
| C03 | Dirty navigation/logout/move/trash cancellation preserves text and unrelated panes. | C |
| C04 | Saved write plus provenance failure does not replay write; best-effort local git stays local. | C |
| R01 | Guarded frontend/platform/core checks and required non-skipped browser gates pass. | A/B/C |
| R02 | Real OpenCode project/file/save/restore/reopen flow passes; Codex uses deterministic scope tests while unavailable. | A/B/C |
| R03 | Candidate image/assets/source match; failure leaves deployed bundle intact; rollback preserves state. | A/B/C |

Test destructive scenarios only on dedicated synthetic fixtures, never real user files. No actual purge during acceptance. Exclude live Claude entirely. A missing required browser gate or native image is a delivery blocker, not a passing skip.

## 7. Approval and Compatibility

The user requested continued execution after reviewing the spec/plan; implement recoverable deletion with permanent purge excluded. Publication still requires its own checkpoint review. Preserve the separately developed account/workspace recovery changes and coordinate dirty-editor guards with their current contract; do not merge either branch wholesale into the primary dirty checkout.

Legacy projects without lifecycle records are active. Existing already-unregistered folders remain ordinary folders; do not invent lost project IDs or infer deletion timestamps. Restore cannot recover metadata that an old removal already destroyed without a verified backup. Storage schema changes are additive/versioned and old code must not silently run without lifecycle guards after trash is used. A rollback must either retain those guards on the prior bundle/backend or place the account in maintenance/read-only mode until a compatible version returns; never expose trashed projects through an incompatible old server.
