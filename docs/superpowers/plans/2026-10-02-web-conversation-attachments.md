# Web Conversation Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add persistent, conversation-owned Web chat attachments with upload, message cards, previews/downloads, and evidenced file delivery to OpenCode, Claude Code, and Codex.

**Architecture:** A platform attachment service streams originals into private storage and persists draft, conversation, message, and turn associations. The browser uploads files and bounded image derivatives, then passes attachment IDs through the SDK; the platform validates ownership and supplies adapter-specific inputs. Sent cards use durable platform metadata rather than filenames inferred from prompt text.

**Tech Stack:** React, TypeScript, Zustand, the existing SDK, Node HTTP and filesystem streams, node:test, Vitest/Testing Library, and the installed Playwright acceptance harness. No new storage server or image-processing native dependency is required.

**Approved specification:** `docs/superpowers/specs/2026-10-02-web-conversation-attachments-design.md`, committed as `b883dee`; user approved the explanation and proceeding on 2026-10-02.

---

## Execution constraints and decisions

- Work on the current integrated working tree. It contains substantial existing uncommitted Web work; preserve it. Before execution read `using-git-worktrees`, detect the repository environment, and choose an isolation method that retains this working-tree baseline. Do not make a clean worktree from HEAD and accidentally omit the existing dependencies.
- Do not commit entire premodified files without reviewing their earlier diff. Use explicit paths for new files and stage only owned hunks in premodified files. Never reset, stash, or rewrite another task's work.
- The user authorized Superpowers workflow, not parallel implementation. Use inline execution by default; use subagents only if the user selects that option.
- All authored project content is English, including comments, tests, plan updates, and newly added translation values. Use localized existing interface labels where appropriate; new labels use English values across locale files until a separate localization request.
- Web tests, typecheck, lint and build must use the guarded package scripts. For Node platform tests add a guarded package script in Task 1. Heavy checks run sequentially.
- This plan provides attachment API ownership and conversation-local delivery. The existing shared-process filesystem weaknesses reported in `PROGRESS.md` remain a separate security issue. Do not describe opaque IDs or directories as an operating-system sandbox, and do not publish claims of complete host filesystem isolation.
- Original files: at most 25 MiB each. A message has at most 10 files and 100 MiB of original bytes. Upload concurrency is two per composer; server active uploads are at most two per user and four platform-wide.
- Temporary originals may be uploaded before full batch selection is known;
  enforce the aggregate message budget again when claiming/sending, not only
  at upload time. Excess concurrent uploads return 429 and can be retried.
- The current Rust worker gateway rejects request bodies above 8 MiB (`crates/osd-core/src/gateway.rs`). Original uploads bypass that parser through platform routes. Image derivatives are at most 512 KiB each; the final OpenCode JSON must remain below 7.5 MiB. Do not increase or remove the worker guard.
- The browser prepares a still-image derivative only when required for supported image delivery. Preserve originals; show a delivery-size notice when resized or when an animated image is delivered as a still frame. A derivative failure prevents image analysis, not downloading the original.
- Draft uploads expire after 24 hours of inactivity. Sent originals have no automatic TTL. A message accepted by the adapter keeps originals even if generation fails.
- Deletion may interrupt the owning session only after the existing delete flow authorizes it; revoke attachment access before asynchronous byte cleanup. No unrelated project files are deleted.

## File map

| File | Responsibility |
|---|---|
| `services/platform/src/attachments.mjs` | Private original storage, metadata transactions, draft/session claims, limits, tickets, cleanup, cloning |
| `services/platform/src/attachment-routes.mjs` | Authenticated upload, list, preview/download, remove and claim routes |
| `services/platform/src/attachment-turns.mjs` | Durable send IDs, attachment inventory, model inputs, message association and request replay |
| `services/platform/src/attachment-input.mjs` | Claude stream input and Codex image argument construction |
| `services/platform/src/platform-server.mjs` | Small router/lifecycle integration and session event integration |
| `services/platform/src/cli-runtime.mjs` | Consume prepared attachment inputs without discarding file parts |
| `services/platform/src/main.mjs` | Private attachment storage location, lifecycle initialization |
| `scripts/dev/safe-desktop-task.mjs` | Bounded platform test mode using the existing host guard |
| `services/platform/package.json` | Guarded test command retaining node:test argument forwarding |
| `packages/shared/src/index.ts` | Optional message attachment metadata |
| `packages/sdk/src/types.ts`, `runtime.ts`, `OpenCodeClient.ts` | Optional Web attachment prompt context and history metadata |
| `apps/desktop/src/lib/conversationAttachments.ts` | Typed API, upload cancellation/progress, image derivatives |
| `apps/desktop/src/components/thread/useComposerAttachments.ts` | Pane-scoped pending state, queue, retries, disposal |
| `apps/desktop/src/components/thread/ConversationAttachmentCard.tsx` | Pending and historical cards, accessible preview/download |
| `apps/desktop/src/components/thread/Composer.tsx` | File input, paste/drop, send gate and awaited acceptance |
| `apps/desktop/src/lib/composerStash.ts` | Preserve attachment draft handles across pane remounts |
| `apps/desktop/src/lib/runtime.ts` | SDK context, optimistic/historical association, edit/revert continuity |
| `apps/desktop/src/components/session/SessionView.tsx` | Bind pane/session context and return send acceptance |
| `apps/desktop/src/components/thread/atoms.tsx`, `BlockList.tsx` | Render persisted attachment cards on user messages |
| `apps/desktop/src/lib/artifactFile.ts`, `promptAttachments.ts` | Explicit Web-owned preview/read behavior without changing desktop file parts |
| `apps/desktop/src/i18n/locales/{de,en,es,fr,ja,ko,zh-Hans}/session.json` | Matching new attachment keys with English values |
| `services/platform/test/attachments.test.mjs` | Store/limits/restart/cleanup tests |
| `services/platform/test/attachment-routes.test.mjs` | Auth, stream, tickets and abort tests |
| `services/platform/test/attachment-turns.test.mjs` | Durable association/retry/lifecycle tests |
| `services/platform/test/attachment-input.test.mjs` | Native input shape and byte evidence |
| `services/platform/test/platform-server.test.mjs`, `cli-runtime.test.mjs` | Integrated runtime and route regression |
| `services/platform/fixtures/attachment-cli.mjs` | Controlled CLI that validates image input and reads uploaded documents |
| `apps/desktop/src/lib/conversationAttachments.test.ts` | Browser API and image budget behavior |
| `apps/desktop/src/components/thread/ComposerAttach.web.test.tsx` | File/paste/drop/send/retry/navigation tests |
| `apps/desktop/src/components/thread/ConversationAttachmentCard.test.tsx` | Historical cards and touch/keyboard actions |
| `apps/desktop/src/test/webAttachments.acceptance.test.mjs` | HTTP browser flow at 1280px and 390px |
| `PROGRESS.md` | Verified milestone only, newest first |

## Contract fixed before implementation

Public metadata never contains private storage paths or bearer tokens:

```ts
export interface ConversationAttachment {
  id: string;
  name: string;
  size: number;
  mime: string;
  sha256: string;
  createdAt: number;
  sessionId?: string;
  messageID?: string;
  imageDelivery?: "original" | "resized" | "still" | "unavailable";
}
export interface AttachmentPromptContext {
  turnId: string;
  messageID?: string;
  draftId?: string;
  attachmentIds: string[];
}
export interface AttachmentOwner {
  draftId?: string;
  sessionId?: string;
}
```

`UserMessageBlock.attachments` and `HistoryMessage.attachments` are optional arrays.
Add optional `AttachmentPromptContext` as argument seven of `sendPrompt`; existing
six-argument calls and the desktop implementation retain their current behavior.
The platform removes its custom attachment field before calling native OpenCode.
The frontend store adds context as optional argument six:
`sendPrompt(text, sessionId, draftKey, attachments, researchBrief, attachmentContext)`.
Composer uses `onSend(text, desktopNames?, attachmentContext?)`; SessionView forwards
the context without displacing the existing research brief parameter.

Routes, after existing platform authentication:

| Request | Response and behavior |
|---|---|
| `POST /api/attachments/drafts` | 201 `{draftId}` from server UUID, tied to signed-in user |
| `POST /api/attachments/upload?draftId=...&name=...` | Stream one original; 201 public metadata |
| `POST /api/attachments/upload?sessionId=...&name=...` | Validate session owner and stream one pending original |
| `PUT /api/attachments/:id/image?draftId=...` or `?sessionId=...` | Stream at most 512 KiB PNG/JPEG/WebP derivative; 200 metadata |
| `DELETE /api/attachments/:id?draftId=...` or `?sessionId=...` | 204 for unsent owned upload only; 409 for sent upload |
| `GET /api/attachments?sessionId=...` | 200 `{attachments, turns}` for this session; private paths excluded |
| `POST /api/attachments/:id/ticket` | Owner body; 200 `{ticket}` restricted to original or preview, valid 60 seconds |
| `GET /api/attachments/read?ticket=...` | Stream original/preview; safe MIME, CSP and download headers |
| `POST /api/attachments/claim` | `{draftId,sessionId,attachmentIds}`; idempotent same-owner claim |

Routes use JSON errors `{error,code}` with 400 invalid parameters, 401 no login,
404 inaccessible resource, 409 ownership/state conflict, 413 file/message budget,
415 invalid derivative/type, 429 concurrency, and 503 recoverable storage failure.
A read ticket still requires the matching logged-in account; it is not a public
share link. Ticket use rechecks conversation deletion and owner identity.

Private metadata schema version 1 keeps `users/<userId>/drafts/<draftId>` and
`users/<userId>/sessions/<sessionId>` under the platform attachment root. Each
original is `<attachmentId>/original`; `displayName` remains metadata. Working
copies and derivatives have their own files; the original is never edited by an
agent. Record state: `pending`, `claimed`, `sent`, or `deleted`.

Each session has `turns.json` with durable `{turnId,messageID,attachmentIds,status}`
entries. Turn states are `prepared`, `accepted`, `rejected`; retain preparation
on transport uncertainty and reconcile with actual history before replaying.

## Task 1: Establish contracts and bounded platform tests

**Files:** shared/SDK types and runtime signature listed above; guard script;
platform package script; new `services/platform/test/attachments.test.mjs`.

- [ ] **Step 1: Record a baseline and write the first failing limits test.** Capture `git status --short` and the existing diffs for touched files in `.deploy/verification/attachments-baseline.patch`. Do not include credential files. Start the store test with:

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { ATTACHMENT_LIMITS, validateMessageBudget } from "../src/attachments.mjs";

test("message budgets count original bytes and repeated names separately", () => {
  assert.equal(ATTACHMENT_LIMITS.fileBytes, 25 * 1024 ** 2);
  assert.throws(() => validateMessageBudget(Array.from({ length: 11 }, () => ({ size: 1 }))), { status: 413 });
  assert.throws(() => validateMessageBudget(Array.from({ length: 5 }, () => ({ size: 25 * 1024 ** 2 }))), { status: 413 });
  assert.doesNotThrow(() => validateMessageBudget([{ size: 1 }, { size: 1 }]));
});
```

- [ ] **Step 2: Add a guard mode before running platform tests.** Extend accepted modes with `platform-test`, preserving the existing flock, cgroup limits and pressure monitor. Its executable branch is:

```js
} else if (mode === "platform-test") {
  const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...args], {
    cwd: join(root, "services/platform"), stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.signal || result.status !== 0) throw new Error("Platform tests failed");
```

Set platform `test` to `node ../../scripts/dev/safe-desktop-task.mjs platform-test`.
Run `pnpm --filter @ai4s/platform test test/attachments.test.mjs`; expect failure
because the store module does not exist, inside the verified cgroup.

- [ ] **Step 3: Define the public types and minimal limits implementation.** Add the contract above, optional block/history fields and optional SDK context argument without changing request bodies yet. Implement:

```js
export const ATTACHMENT_LIMITS = Object.freeze({
  files: 10, fileBytes: 25 * 1024 ** 2, messageBytes: 100 * 1024 ** 2,
  imageBytes: 512 * 1024, draftMs: 24 * 60 * 60 * 1000,
});
export function validateMessageBudget(files) {
  if (!Array.isArray(files) || files.length > ATTACHMENT_LIMITS.files ||
      files.some((file) => !Number.isSafeInteger(file.size) || file.size < 0 || file.size > ATTACHMENT_LIMITS.fileBytes) ||
      files.reduce((sum, file) => sum + file.size, 0) > ATTACHMENT_LIMITS.messageBytes) {
    throw Object.assign(new Error("Attachment limits exceeded"), { status: 413, code: "attachment_limit" });
  }
}
```

- [ ] **Step 4: Verify and commit owned hunks.** Run the limits test and `pnpm typecheck` sequentially. Both must pass, with existing six-argument runtime calls unchanged. Commit `feat(web): define conversation attachment contracts and bounded tests`.

## Task 2: Store original bytes and durable metadata

**Files:** `attachments.mjs`, `attachments.test.mjs`.

Define `AttachmentStore({rootDir, now = Date.now})` with methods `init`,
`createDraft(userId)`, `upload(userId,owner,name,readable)`,
`putImage(userId,owner,id,readable)`, `claim(userId,draftId,sessionId,ids)`,
`get(userId,owner,id)`, `list(userId,sessionId)`, `removePending`, `expire`,
`deleteSession`, `cloneSession`, `materialize`, `withSessionLock`, and `close`.
Router-proven ownership is required for session methods; store methods also check
record user/session identity. `materialize` returns server-only working paths and
must never return paths through a public API.

- [ ] **Step 1: Add failing storage tests with temporary roots.** Use `mkdtemp`, `afterEach` cleanup, and real streams. Test same-name files, exact hashes, claim conflicts, restart, original immutability, zero-byte files, `.pdf` names with invalid content, traversal, symlink parent, interrupted stream, and expired draft removal. Core sequence:

```js
const draft = await store.createDraft("user_a");
const a = await store.upload("user_a", { draftId: draft.id }, "data.csv", Readable.from([Buffer.from("x\n1\n")]));
const b = await store.upload("user_a", { draftId: draft.id }, "data.csv", Readable.from([Buffer.from("x\n2\n")]));
assert.notEqual(a.id, b.id);
assert.notEqual(a.sha256, b.sha256);
await store.claim("user_a", draft.id, "session_a", [a.id, b.id]);
await assert.rejects(store.claim("user_a", draft.id, "session_b", [a.id]), { status: 409 });
await assert.rejects(store.get("user_b", { sessionId: "session_a" }, a.id), { status: 404 });
```

Run `pnpm --filter @ai4s/platform test test/attachments.test.mjs`; expect missing
`AttachmentStore` and method failures.

- [ ] **Step 2: Implement private paths and atomic records.** IDs come from server `randomUUID`; accept only conservative ID syntax. Check canonical root and every existing parent with `realpath`/`lstat`; reject symlinks. Use mode 0700 directories and 0600 files, exclusive creation, per-session/draft promise locks, and temp-then-rename metadata. Do not interpolate names into paths. Name validation is:

```js
export function attachmentName(value) {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > 240 ||
      /[\\/\x00-\x1f\x7f]/.test(value) || value === "." || value === "..") {
    throw Object.assign(new Error("Invalid attachment name"), { status: 400, code: "invalid_name" });
  }
  return value;
}
```

- [ ] **Step 3: Implement bounded streaming and type detection.** `upload` writes a random temporary file with a Transform counting actual bytes and updating SHA-256; abort past 25 MiB regardless of Content-Length. Inspect at most the first 8 KiB for PNG/JPEG/GIF/WebP/PDF signatures; use text validation for UTF-8 research inputs; otherwise store `application/octet-stream`. MIME provided by the client is a hint, not a type proof. Successful upload atomically publishes metadata; any pipeline failure removes temporary bytes. Use:

```js
let size = 0;
const hash = createHash("sha256");
const measure = new Transform({ transform(chunk, encoding, callback) {
  size += chunk.length;
  if (size > ATTACHMENT_LIMITS.fileBytes) {
    callback(Object.assign(new Error("File exceeds 25 MiB"), { status: 413, code: "file_too_large" }));
    return;
  }
  hash.update(chunk);
  callback(null, chunk);
} });
await pipeline(readable, measure, createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
```

- [ ] **Step 4: Implement claims, derivatives and cleanup.** Claims validate all records/budgets before changing any; persist a recoverable transaction before moving metadata. `putImage` uses the smaller limit and accepts only verified PNG/JPEG/WebP, storing derivative separately. `removePending` rejects sent records. `expire` removes pending uploads inactive for 24 hours, including interrupted upload markers. `deleteSession` persists a tombstone before cleanup; reads fail immediately; cleanup retries on init. `cloneSession` copies referenced originals and associations to fresh IDs and rewrites turn associations. `materialize` copies originals into a conversation-only private working folder, naming each `<id>-<safe display name>` and never overwriting the original. Keep materialized working paths out of generic project listings.

- [ ] **Step 5: Verify and commit.** Run the store suite. Assert an original remains byte-identical after editing a working copy. Restart the store and repeat reads/cleanup to demonstrate disk persistence. Commit `feat(web): persist private conversation attachments`.

## Task 3: Authenticated routes, streaming and preview access

**Files:** `attachment-routes.mjs`, `platform-server.mjs`, `main.mjs`,
`attachment-routes.test.mjs`, `platform-server.test.mjs`.

`handleAttachmentRequest(request,response,{user,store,resolveSessionOwner})`
returns `true` only for a handled attachment route. It must run after login checks
and before the worker proxy. Reuse/rename `#researchOwner` as the owner resolver
rather than introducing a second weaker session validation path. Add a periodic
expiry sweep with `unref`, single-flight guard, and shutdown cleanup.

- [ ] **Step 1: Write failing real HTTP tests.** Reuse `AuthStore`, fake worker and `makeClient` fixture patterns. Log in two users; upload binary/CSV files as user A; confirm anonymous 401, B 404, wrong-session 404, malformed owner 400, stale ticket 404, and correct owner byte-identical download. Send an oversized declared length and a chunked oversized stream; neither leaves a ready record. Abort a real upload midway and verify cleanup. Run the focused Node suites; expect attachment route 404.

- [ ] **Step 2: Implement route dispatch and concurrency limits.** Store upload counts in the router, increment before reading and decrement in `finally`. Require exactly one owner, prove sessions with the existing runtime owner resolver, compare optional request Origin with request host on cookie-authenticated mutations, and reject mismatches. Do not read binary bodies with the 1 MiB JSON parser. The dispatch pattern is:

```js
if (path === "/api/attachments/upload" && request.method === "POST") {
  const owner = ownerFromQuery(url.searchParams);
  await authorizeOwner(user.id, owner, store, resolveSessionOwner);
  await withUploadSlot(user.id, async () => {
    const file = await store.upload(user.id, owner, attachmentName(url.searchParams.get("name")), request);
    sendJson(response, 201, file);
  });
  return true;
}
```

Define `ownerFromQuery`, `authorizeOwner`, `withUploadSlot` and `sendJson` in the
route module. On a declared oversized body return 413 before creating the file;
on stream oversize stop the upload and return 413 when the socket permits.

- [ ] **Step 3: Implement tickets, downloads and safe previews.** Use random, 60-second, in-memory tickets bound to user, owner, attachment ID and preview/original choice. Recheck metadata on every request. Stream with `createReadStream`; send `nosniff`, `no-store`, and `Content-Disposition: attachment` for original downloads. HTML/SVG/other active content is never served unsandboxed inline. Use CSP sandbox or text-only preview; unsupported types still download. Never return private paths or bearer tokens.

- [ ] **Step 4: Wire lifecycle and verify.** Construct the store under `resolve(workerManager.rootDir,"../attachments")`, initialize it before listening, clear timers and close it during shutdown. Test draft expiry and tombstoned tickets after restart. Run routes/platform suites sequentially; commit `feat(web): expose authenticated attachment upload and download routes`.

## Task 4: Transactional send IDs and persistent message associations

**Files:** `attachment-turns.mjs`, platform router, SDK contract/client,
`attachment-turns.test.mjs`, `platform-server.test.mjs`, SDK node tests.

`AttachmentTurns({store,resolveSessionOwner,readHistory})` provides `prepare`,
`accept`, `reject`, `reconcile`, `history`, `clone`, and `delete`. Keep immutable
original ownership distinct from current history visibility.

- [ ] **Step 1: Add failing tests for retries and histories.** Prepare a turn, claim its draft files, reject the first upstream call, replay the same request, then accept. Assert one message association, same attachment IDs, and no loss of originals. Reusing a turn ID with different text or IDs returns 409. An unknown upstream outcome triggers history reconciliation before another POST. Accepted replay returns success without a second model invocation. Test conflicting conversation ownership and aggregate limits.

```js
const input = { turnId: "turn_a", messageID: "msg_a", attachmentIds: [file.id], draftId: draft.id };
const first = await turns.prepare(user, session, input, prompt);
await turns.accept(user.id, session.id, first.turnId);
const replay = await turns.prepare(user, session, input, prompt);
assert.equal(replay.replayAccepted, true);
assert.deepEqual((await turns.history(user.id, session.id))[0].attachmentIds, [file.id]);
```

Run the Node tests and SDK focused test; expect missing turn service and absent
request context.

- [ ] **Step 2: Add optional SDK context without disturbing desktop.** SDK serializes `attachmentTurn` only when provided, and stores optional attachment metadata from history responses. Generate user message IDs once in the platform using the pinned OpenCode ascending identifier format: `msg_`, 12 hex characters encoding the monotonic millisecond counter, and 14 random base62 characters. Persist that ID before upstream submission; return it in attachment metadata. The pinned prompt schema includes optional `messageID` and saves it as the user message ID; verify the bundled binary through the contract test. The Web client uses stable turn IDs; `messageID` is optional in its context and generated by the platform when absent. Reject conflicting caller-supplied message IDs. Browser secure APIs are not needed for native message IDs.

```ts
body: JSON.stringify({
  parts: [{ type: "text", text }, ...(files ?? []).map((f) => ({
    type: "file", mime: f.mime, filename: f.filename, url: f.url,
  }))],
  ...(attachmentContext ? { attachmentTurn: attachmentContext } : {}),
  ...(agent ? { agent } : {}),
  ...(m ? { model: m } : {}),
  system: ARTIFACT_PRESENTATION_SYSTEM,
  ...(variant ? { variant } : {}),
}),
```

Keep AcpRuntime structurally compatible and ignore the optional Web-only context
there. Add a pinned-sidecar contract test using an isolated worker, since a fake worker
cannot prove native message-ID acceptance. Add a synthetic text marker
`SciKeel attachment turn: <turnId>` to attachment-bearing native messages for fork
lineage only; strip it from visible history and do not treat arbitrary user text
as an association. If the bundled binary fails its pinned-source contract, stop
that adapter integration and report the concrete mismatch before changing the
protocol; never correlate messages using prompt text or list position.

- [ ] **Step 3: Implement durable prepare/accept/reconcile.** Under a session lock validate owner, count/sizes, uploaded derivative readiness and immutable request digest. Claim files; store prepared state before contacting the adapter. Inject actual attachment inventory into runtime-only text/system context while preserving display text. Accept only after the adapter accepts its user message; reject definite HTTP/model preflight failures. Reconcile uncertain outcomes by native message ID before retry; restart scans pending turns. Native history is decorated with public attachment metadata when serving history, including non-image files and attachment-only messages.

- [ ] **Step 4: Integrate research prompts and verify.** Parse attachment-bearing small JSON once, then compose attachment preparation with `researchTasks.prepare` without discarding either system context. Only sessions without retained attachments and without a research task retain
the existing fast path. A text-only follow-up in an attachment conversation still
receives its owned active-history inventory; it must not depend on new chips. Run focused store/turn/platform/SDK tests, confirm retries do not execute twice, and commit `feat(web): bind attachments to durable conversation turns`.

## Task 5: Deliver actual image and document content to all adapters

**Files:** `attachment-input.mjs`, `attachment-turns.mjs`, `cli-runtime.mjs`,
`attachment-input.test.mjs`, `cli-runtime.test.mjs`,
`services/platform/fixtures/attachment-cli.mjs`.

The server prepares `{displayText, runtimeText, messageID, imagePaths,
imageParts, attachments}` from owned records. `imagePaths` and working document
paths are private server-side values; the browser cannot select arbitrary paths.
`runtimeText` includes this conversation's active-history files and its scoped reader
instructions. `displayText` remains exactly the user's input.

- [ ] **Step 1: Write input-contract tests and a validating CLI fixture.** Assert Codex fresh and resumed commands both receive repeated `--image` arguments in positions accepted by their installed CLI. Assert Claude receives a newline-delimited user envelope on stdin with text and base64 image content. The fixture reads referenced image bytes and document paths and emits a controlled result containing their hashes; rejecting missing bytes makes filename-only delivery fail.

```js
import { claudeUserInput, codexImageArgs } from "../src/attachment-input.mjs";
assert.deepEqual(codexImageArgs(["/private/a.png", "/private/b.png"]),
  ["--image", "/private/a.png", "--image", "/private/b.png"]);
const envelope = JSON.parse(claudeUserInput("Describe the figure", [
  { mime: "image/png", data: "aGVsbG8=" },
]));
assert.equal(envelope.message.content[1].source.data, "aGVsbG8=");
assert.equal(envelope.message.content[1].source.media_type, "image/png");
```

Run `pnpm --filter @ai4s/platform test test/attachment-input.test.mjs test/cli-runtime.test.mjs`;
expect missing helpers or absent image delivery.

- [ ] **Step 2: Implement native input helpers.** Define:

```js
export const codexImageArgs = (paths) => paths.flatMap((path) => ["--image", path]);
export function claudeUserInput(text, images) {
  return JSON.stringify({ type: "user", message: { role: "user", content: [
    { type: "text", text },
    ...images.map(({ mime, data }) => ({ type: "image", source: {
      type: "base64", media_type: mime, data,
    } })),
  ] } }) + "\n";
}
```

Codex adds image arguments before the prompt: at the exec option level on a fresh
turn, at the resume option level for resumed turns. Preserve model/effort and
native session selection. For Claude image turns replace positional `-p text`
with `-p --input-format stream-json`, use piped stdin, write the envelope, then
end stdin. Keep text-only calls and fixtures compatible. Check installed CLI help
and exercise both native session modes before relying on the argument order.

- [ ] **Step 3: Add scoped file inventories and working copies.** `store.materialize`
creates copies for only the owning conversation. Pass those document paths in
runtime context and allow only that additional attachment folder in the adapter
file access configuration; preserve the existing project working directory.
Codex may use `--add-dir` for the owning working folder; Claude uses an additional
`--add-dir`; OpenCode follows its existing external-file approval/tool contract.
Do not widen file permissions for sibling attachment folders. Implement a reader
result check for unsupported types; do not infer success from upload or the
model's prose. Inventory entries include original name, detected type, size,
and runtime reference; user-facing history excludes internal paths.

For structured research inputs use installed readers or model tools. A real CSV
check must calculate a value from rows; a PDF check must retrieve text existing
in that PDF. DOCX/XLSX readers must either return evidenced content or a visible
unsupported-reader error. Arbitrary files remain downloadable without claiming
they were parsed. Automatic code execution and archive extraction are disabled
for ingestion; normal explicitly requested agent work keeps existing approvals.

- [ ] **Step 4: Construct bounded OpenCode image parts.** Read only stored
512 KiB-or-smaller delivery images and use `data:<mime>;base64,...` file parts.
Never send `file://` to the pinned sidecar. Validate final serialized body before
proxying:

```js
const serialized = JSON.stringify(nativePrompt);
if (Buffer.byteLength(serialized) > 7.5 * 1024 ** 2) {
  throw Object.assign(new Error("This image request is too large; use fewer images"), {
    status: 413, code: "model_input_too_large",
  });
}
```

Image derivative absence/type failure rejects analysis with a retryable error,
retaining the original and draft. Model capability evidence comes from provider
catalog modalities when supplied or a real adapter error; unknown capabilities
must not be presented as verified vision support.

- [ ] **Step 5: Persist native user history and verify.** CLI user messages retain
`messageID` and safe attachment metadata while using runtimeText for actual input.
Test both first and follow-up image turns, CSV/PDF reads, missing files, rejected
image types, model errors, and cancellation. Run focused platform tests and SDK
file-part tests sequentially. Commit `feat(web): deliver conversation attachments to managed assistants`.

## Task 6: Browser upload API and bounded image preparation

**Files:** `conversationAttachments.ts`, `conversationAttachments.test.ts`.

Export `createAttachmentDraft`, `uploadConversationAttachment`,
`prepareImageDelivery`, `uploadImageDelivery`, `removePendingAttachment`,
`claimAttachments`, `listConversationAttachments`, and `attachmentPreviewUrl`.
Every helper uses same-origin platform cookies plus the existing auth guard.
Do not call the desktop bridge or put bearer tokens in URLs.

- [ ] **Step 1: Write failing browser API tests.** Mock XHR to assert raw File/Blob
body, URL-encoded Unicode filename, no base64 JSON upload, progress callbacks,
abort behavior, non-JSON error fallback, and no stale callback after abort. Mock
canvas/bitmap outputs for derivative size/notice and failure. Tests cover 25 MiB
client rejection, unchanged originals, 512 KiB delivery cap and unavailable
image decoding. Run `pnpm --filter @ai4s/desktop test src/lib/conversationAttachments.test.ts`;
expect missing module.

- [ ] **Step 2: Implement cancellable single-file XHR upload.** File upload accepts
`{owner,file,signal,onProgress}`; opens the upload endpoint with `withCredentials`,
sends the original File, checks response status and parses metadata. Register
abort and upload progress handlers; remove all listeners on resolve/reject.
Network/429 errors preserve the File for retry. No client identifier needs
`crypto.randomUUID`; draft, attachment and turn IDs are created server-side or
use an existing non-secure-context-safe random helper for client request keys.

- [ ] **Step 3: Implement image derivative preparation.** Supported image types
are verified PNG/JPEG/GIF/WebP. Keep files at or below 512 KiB unchanged when
compatible. Otherwise decode using `createImageBitmap`, scale longest edge to at
most 2560 pixels, and encode WebP with progressively smaller dimensions/quality
until at most 512 KiB. Cap attempts at eight; if the browser lacks WebP export,
use JPEG on a white background and explicitly record that transformation.
Always release bitmap/object URLs. The size loop is:

```ts
for (let attempt = 0; attempt < 8; attempt++) {
  const scale = Math.min(1, 2560 / Math.max(bitmap.width, bitmap.height)) * 0.8 ** attempt;
  canvas.width = Math.max(1, Math.floor(bitmap.width * scale));
  canvas.height = Math.max(1, Math.floor(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Image preparation is unavailable in this browser");
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
    (value) => value ? resolve(value) : reject(new Error("Image encoding failed")),
    "image/webp", Math.max(0.45, 0.85 - attempt * 0.06),
  ));
  if (blob.size <= 512 * 1024) return { blob, imageDelivery: "resized" as const };
}
throw new Error("Image is too complex to prepare; use a smaller image");
```

Check actual `blob.type` for fallback, mark animated inputs as `still`, and show
an English delivery notice. Store derivative with the same attachment owner.
Do not alter the original File, hash, name or original upload size.

- [ ] **Step 4: Add ticket/read and removal helpers.** Request an owner-bound
ticket before preview/download. Download the original with its display name;
preview the derivative only if available. Refresh tickets on each open/action.
Errors propagate to cards. Run the helper tests and commit
`feat(web): add browser attachment uploads and image preparation`.

## Task 7: Composer queue, file selection, paste and drop

**Files:** `useComposerAttachments.ts`, `Composer.tsx`, `composerStash.ts`,
`SessionView.tsx`, `ComposerAttach.web.test.tsx`, existing composer tests.

Hook API:

```ts
interface PendingAttachment {
  localId: string;
  file: File;
  state: "uploading" | "ready" | "failed";
  progress: number;
  attachment?: ConversationAttachment;
  error?: string;
}
interface ComposerAttachments {
  items: PendingAttachment[];
  busy: boolean;
  blocked: boolean;
  add(files: File[]): void;
  retry(localId: string): void;
  remove(localId: string): void;
  prepareSend(text: string): Promise<AttachmentPromptContext>;
  acceptSend(): void;
}
```

The hook is keyed by pane/draft/session, not the globally active workspace.
`prepareSend(text)` retains the same turn ID on an unchanged retry and creates a
new one after text/selection changes; generate request keys with
`crypto.getRandomValues`, which works on ordinary HTTP, rather than randomUUID.
The platform validates ownership independently; IDs are never authority.
It owns two concurrent uploads and AbortControllers; retries reuse ready originals
when only image derivative preparation failed. Store ready draft handles in the
existing stash; retain File/queue state in an in-memory pane registry so remounts
can retry. Durable sent state always comes from server metadata. Browser refresh
need not restore unsent file selections; their originals remain subject to TTL.

- [ ] **Step 1: Add failing component behavior tests.** Mock browser mode and
attachment helpers. Render with a real onSend promise. Select PNG/PDF/CSV, paste
an image File item, and drop DataTransfer files. Assert no browser navigation,
card state, queue limit, attachment-only send, Enter gating, failed upload retry,
ready-file preservation, and correct pane after switching during upload.

```tsx
const sent = vi.fn().mockRejectedValueOnce(new Error("Session is busy"));
render(<Composer onSend={sent} currentSessionId="session_a" />);
fireEvent.change(screen.getByLabelText("Attach files"), {
  target: { files: [new File(["x\n1\n"], "data.csv", { type: "text/csv" })] },
});
await screen.findByText("data.csv");
fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
expect(sent).not.toHaveBeenCalled();
```

The first Enter occurs with the mocked upload still pending. Then finish upload,
send, reject acceptance, and assert text/files remain. Run the Web composer test;
expect absent file input and no Web upload behavior.

- [ ] **Step 2: Implement pane-owned queue and retry state.** Validate selected
file count and combined original sizes before starting. Queue work at concurrency
two, report progress and errors, await original plus image delivery, and mark
ready only after all needed uploads succeed. Capture pane owner and generation
in each operation; a late response updates only that owner. Explicit removal
aborts and deletes its pending original; pane hide/remount parks rather than
deletes. Explicit discarded drafts abort and remove files, with server TTL as
recovery. Auth failure aborts the queue without exposing original bytes.

- [ ] **Step 3: Wire browser file input and events.** Add hidden
`<input type="file" multiple>` with accessible label and no blanket accept filter.
The paperclip opens it in Web mode and retains native picker in desktop. Reset
input value after each selection to allow same-name reselection. Handle DOM
`dragover`/`drop` on the composer only for Files and prevent default navigation.
Read clipboard File items from the existing `onPaste`, preserving ordinary text.
Desktop/native handlers remain under their current `isTauri` branch.

- [ ] **Step 4: Await send acceptance before clearing.** Extend onSend to return
`Promise<void>` or `Promise<boolean>` while remaining compatible with existing
void callbacks. For the live Web pane use explicit boolean acceptance; SessionView
returns true only when runtime send returns an accepted session. Prevent duplicate
submission while the acceptance promise is outstanding. Capture the exact submitted text and selected-item generation so typing or
adding files while acceptance is pending cannot be cleared by the old response.
The core is:

```ts
if (disabled || submitting || webAttachments.blocked) return;
const submittedValue = value;
setSubmitting(true);
try {
  const context = await webAttachments.prepareSend(text);
  const accepted = await onSend?.(text, undefined, context);
  if (accepted === false) return;
  setValue((current) => current === submittedValue ? "" : current);
  webAttachments.acceptSend();
} catch (error) {
  toast.error(error instanceof Error ? error.message : String(error));
} finally {
  setSubmitting(false);
}
```

Preserve desktop name-array sends and shell/command behavior. New optional context
argument is Web-specific. For text-only Web sends reuse existing sending behavior
while fixing acceptance loss where this shared path applies. Never clear files
because session creation succeeded when its actual prompt failed.

- [ ] **Step 5: Verify and commit.** Run Web and desktop composer suites,
references/stash tests, and `pnpm typecheck` sequentially. Ensure normal text paste
and native attachment tests still pass. Commit `feat(web): attach files from the conversation composer`.

## Task 8: Historical cards and explicit owner-scoped preview

**Files:** `ConversationAttachmentCard.tsx`, card tests, `atoms.tsx`,
`BlockList.tsx`, `runtime.ts`, `artifactFile.ts`, `promptAttachments.ts`,
SDK history types/client, all existing session locale files.

Cards accept `{attachment,owner,pendingState?,onRemove?,onRetry?}` and support
images, text preview, existing PDF/office preview components where available,
and original download. Reuse existing inspector/renderers without passing private
storage paths. Previews receive a ticket-backed original URL and safe owner
metadata; preview errors leave the download action available.

- [ ] **Step 1: Write failing history/card tests.** Test image thumbnail, file
name/size, uploading progress, retry/remove buttons, keyboard/touch open, expired
ticket refresh, download failure, opaque-file download, long-name wrapping and
removed-conversation errors. Add a history transformation test with empty user
text and attachments; it must still yield one user block. Simulate refreshed SDK
history and confirm file metadata remains associated with the correct message.

```ts
expect(historyToThread([{ id: "msg_one", role: "user", parts: [],
  attachments: [{ id: "att_one", name: "data.csv", size: 4, mime: "text/csv",
    sha256: "fixture-hash", createdAt: 1, sessionId: "session_a" }],
}]).blocks).toMatchObject([{ kind: "user", text: "", messageID: "msg_one",
  attachments: [{ id: "att_one", name: "data.csv" }],
}]);
```

Import the existing `historyToThread` export from `runtime.ts` in the store
test and inspect its returned `.blocks`; do not introduce another transformer. Run focused UI/history suites; expect attachment metadata dropped.

- [ ] **Step 2: Implement cards and message rendering.** Use `max-w-full`,
`min-w-0`, wrapping names and visible touch controls; create object URLs only for
pending browser files and revoke them on disposal. UserMessage renders attachment
cards before/after its text consistently; pass session owner through BlockList
instead of reading active global workspace. Historical list uses IDs as keys,
not display names. Message copy copies user text, not private attachment inventory.

- [ ] **Step 3: Merge optimistic and confirmed history.** Add context metadata to
the optimistic Web user echo, reconcile by message/turn identity, and populate
blocks from server-decorated history after reconnect. Loading failures show an
explicit retry state rather than silently removing cards. Newly sent attachment
messages refresh their metadata on acceptance/event reconciliation. Follow-up
turns consume the server inventory without copying attachment chips back into
the composer.

- [ ] **Step 4: Keep desktop image behavior and explicit Web reads.** The Web
path uses conversation attachment helpers and server-owned inputs; it must not
call `imageAttachmentParts` with global workspace filenames. Leave desktop
multimodal resolution intact. Any generic `readArtifact` Web extension must take
an explicit directory or session and retain existing error behavior; do not use
it as a substitute for owner-checked attachment routes. Add new matching keys
under `composer.attachments` in the existing locale files with English values,
including `uploading`, `retry`, `remove`, `preview`, `download`, `limits`,
`imageResized`, `imageStill`, and `unavailable`.

- [ ] **Step 5: Verify and commit.** Run cards, history, preview, i18n parity and
composer suites, then typecheck and lint through guarded scripts. Commit
`feat(web): show persistent attachments in conversation history`.

## Task 9: Delete, fork, move, edit and restore without losing originals

**Files:** store/turn service and tests, platform session lifecycle integration,
`runtime.ts`, `runtime.store.test.ts`, `cli-runtime.test.mjs`.

- [ ] **Step 1: Write failing lifecycle tests.** Fork a conversation with two
same-name attachments; delete its source; verify the fork still reads/downloads
both originals. Revert a message and restore history; original hashes remain.
Move a session to another project directory; cards still use their stored IDs.
Reject upstream deletion; the conversation and its files remain recoverable.
Simulate successful native deletion followed by disk cleanup failure; ticket
reads fail and restart finishes cleanup. Run focused store/turn/runtime suites.

```js
const cloned = await store.cloneSession("user_a", "session_a", "session_b");
assert.equal(cloned.attachments.length, 2);
await store.deleteSession("user_a", "session_a");
for (const file of cloned.attachments) {
  const retained = await store.get("user_a", { sessionId: "session_b" }, file.id);
  assert.equal(retained.sha256, file.sha256);
}
```

- [ ] **Step 2: Integrate native session lifecycle transactions.** Intercept the
existing authenticated DELETE/fork/move operations rather than adding parallel
UI actions. Lock attachment writes; revoke reads during confirmed deletion,
perform native deletion, then clean bytes; if native deletion definitely fails,
restore the pre-delete state without cleaning originals. Keep uncertain results
in a recoverable ledger and inspect native session existence before deciding.
Fork only attachments referenced by copied history, respecting the existing
exclusive `messageID` fork boundary; clone bytes to fresh attachment IDs and
rewrite associations. Each attachment-bearing upstream message contains a
synthetic structured turn marker; a fork copies that marker, allowing association
with the new native message ID without matching user text or array positions.
Validate this behavior against the pinned sidecar. Managed CLI forks similarly
clone metadata and rewrite copied history associations.

- [ ] **Step 3: Preserve attachments during edit/revert.** `editMessage` captures
that message's attachment IDs before reverting and resends them with a fresh
turn ID. Revert hides dropped message cards but retains originals required for
unrevert/history restoration. Do not delete files on a history visibility change.
Move changes only runtime materialization location if necessary; IDs, original
storage and message associations remain stable. Best-effort workspace snapshots
apply only to copies inside a workspace; private originals never receive remotes
or push operations.

- [ ] **Step 4: Verify and commit.** Run attachment lifecycle tests and the
existing edit/revert/fork/move suites, plus CLI history tests. Assert failed
upstream delete does not clear the frontend's conversation as successful. Fix
that error path where needed without changing unrelated session behavior.
Commit `feat(web): preserve attachment ownership across conversation lifecycle`.

## Task 10: Bounded verification and browser acceptance

**Files:** new Web acceptance test, input fixture, focused existing acceptance
harness, package scripts if a named acceptance alias is useful, `PROGRESS.md`.

- [ ] **Step 1: Add an opt-in isolated HTTP browser suite.** Use the existing
installed Playwright/Chromium paths from environment. Build a temporary
AuthStore, WorkerManager and PlatformServer, with a fixture CLI and the newly
built bundle. For each width 1280/390 and locale English/Chinese, upload image,
PDF and CSV; send an attachment-only and a mixed prompt; reload; reopen; inspect
historical cards; download originals and compare SHA-256; ask a follow-up without
uploading; verify another conversation has no inherited attachment. Repeat with
non-secure HTTP host alias and assert no page overflow or console errors.

```js
await page.locator('input[type="file"]').setInputFiles([
  { name: "figure.png", mimeType: "image/png", buffer: figureBytes },
  { name: "paper.pdf", mimeType: "application/pdf", buffer: pdfBytes },
  { name: "data.csv", mimeType: "text/csv", buffer: Buffer.from("value\n2\n4\n") },
]);
await page.getByRole("button", { name: "Send", exact: true }).click();
await page.reload();
await expect(page.getByText("paper.pdf", { exact: true })).toBeVisible();
expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
```

Define `figureBytes` using a real PNG fixture containing a blue triangle and
the phrase `KEEL 47`. Define `pdfBytes` using a valid small PDF fixture whose text
includes `Attachment evidence: keel paper 47`; verify both with the existing
image/PDF readers. Neither input may contain credentials; names use neutral
`figure.png` and `paper.pdf`, so their contents cannot be inferred from names.
Use a fixture image whose visible content cannot be deduced from its filename.
Add browser checks for paste, DOM drop, delayed upload, per-file retry, send error
preservation, oversized/count budget and cancellation/navigation. Test user B
through real authenticated API access. Do not expose acceptance passwords in
command output, artifacts or Git.

- [ ] **Step 2: Run focused and full guarded suites sequentially.**

```bash
pnpm --filter @ai4s/platform test
pnpm --filter @ai4s/desktop test src/lib/conversationAttachments.test.ts src/components/thread/ComposerAttach.web.test.tsx src/components/thread/ComposerAttach.test.tsx src/components/thread/ConversationAttachmentCard.test.tsx src/lib/runtime.store.test.ts src/lib/promptAttachments.test.ts src/lib/artifactFile.web.test.ts src/i18n/parity.test.ts
pnpm test
pnpm typecheck
pnpm lint
```

Expected: platform tests and frontend tests pass, with only existing opt-in skips;
new ownership/byte-reading cases must execute and pass. Typecheck/lint exit zero.
Do not run repeated full suites after success without a new relevant change.

- [ ] **Step 3: Build through the guarded package script.** Run `pnpm build`.
Expected: bounded build succeeds and publishes its verified staging bundle; if it
fails the prior deployed bundle remains present. Never invoke Vite directly or
increase resource limits. Run the isolated browser suite against that bundle:

```bash
OSD_ATTACHMENTS_ACCEPTANCE=1 pnpm --filter @ai4s/desktop test src/test/webAttachments.acceptance.test.mjs
```

Expected: 1280px/390px, ordinary HTTP origin, upload/history/download/follow-up
checks pass and all temporary users/workers/storage are removed by teardown.

- [ ] **Step 4: Verify real runtime content consumption.** For every configured
assistant use a temporary acceptance conversation and real model. Supply an
image with a distinctive shape/color/embedded phrase under an unrelated filename,
a PDF with a unique sentence, and a CSV with values 2 and 4. Require evidenced
image interpretation, the PDF sentence, and computed mean 3. Reopen and ask a
follow-up on the same CSV without uploading it. Verify originals' hashes and
record runtime/tool evidence rather than accepting a filename echo. Clean only
acceptance conversations and attachments through the normal deletion API. An
unconfigured/unsupported assistant is recorded as an explicit limitation; never
count its skipped live test as a pass. Deterministic adapter tests still cover
all three transport paths.

- [ ] **Step 5: Deploy platform changes without interrupting active work.** Check
active managed turns and worker session status before a required platform reload.
The current main shutdown closes CLI processes/workers, so do not restart while
active turns exist. Validate backend plus the bundle on the isolated instance
first. If live turns prevent a safe reload, retain the tested artifact and report
deployment pending rather than silently killing turns. Otherwise reload using
the existing service procedure, verify health/login, and execute production Web
attachment checks at both widths without changing account model configuration.

- [ ] **Step 6: Record evidence and complete.** Keep test outputs and screenshots
under `.deploy/verification`, excluded from Git; append one real milestone at the
top of PROGRESS. Commit only owned changes with `feat(web): verify persistent chat attachments`.
Report implementation, test counts, deployed status and any unavailable live
runtime checks separately. No completion claim is based solely on unit tests.

## Exact focused verification commands

Run one row at a time after the corresponding implementation step. All commands
use the package scripts; none invokes Vitest or Node platform tests unguarded.

| Task | Command |
|---|---|
| 1, 2 | `pnpm --filter @ai4s/platform test test/attachments.test.mjs` |
| 3 | `pnpm --filter @ai4s/platform test test/attachment-routes.test.mjs test/platform-server.test.mjs` |
| 4 | `pnpm --filter @ai4s/platform test test/attachment-turns.test.mjs test/platform-server.test.mjs` then `pnpm --filter @ai4s/desktop test src/test/opencode-client.node.test.ts` |
| 5 | `pnpm --filter @ai4s/platform test test/attachment-input.test.mjs test/cli-runtime.test.mjs` |
| 6 | `pnpm --filter @ai4s/desktop test src/lib/conversationAttachments.test.ts` |
| 7 | `pnpm --filter @ai4s/desktop test src/components/thread/ComposerAttach.web.test.tsx src/components/thread/ComposerAttach.test.tsx src/components/thread/Composer.test.tsx src/components/thread/ComposerReferences.test.tsx` |
| 8 | `pnpm --filter @ai4s/desktop test src/components/thread/ConversationAttachmentCard.test.tsx src/lib/runtime.store.test.ts src/lib/artifactFile.web.test.ts src/lib/promptAttachments.test.ts src/i18n/parity.test.ts` |
| 9 | `pnpm --filter @ai4s/platform test test/attachments.test.mjs test/attachment-turns.test.mjs test/cli-runtime.test.mjs` then `pnpm --filter @ai4s/desktop test src/lib/runtime.store.test.ts src/lib/runtime.test.ts` |
| 10 | Full sequence and opt-in browser command specified in Task 10 |

Each test addition must fail on the specific absent behavior before its patch,
then pass after the patch; a configuration/import failure is useful only for the
first new-module seam. Fix incidental failures before interpreting behavior.

## Coverage and self-review

| Approved requirement | Tasks |
|---|---|
| Multiple selection, paste, drop and mobile picker | 6, 7, 10 |
| Progress, failed upload retry, removal and send blocking | 3, 6, 7 |
| Preserve text/files when acceptance fails | 4, 7 |
| Persistent cards, preview and original download | 2, 3, 4, 8, 10 |
| Same-dialog follow-up after refresh/restart | 2, 4, 5, 8, 10 |
| User/session ownership, no implicit project sharing | 2, 3, 4, 5, 10 |
| Duplicate names, path traversal, symlinks and byte hashes | 2, 3, 10 |
| 10 files, 25 MiB each, 100 MiB message | 1, 2, 4, 6, 7, 10 |
| Actual pixels/content and visible unsupported analysis | 5, 6, 10 |
| Immutable original plus bounded image delivery | 2, 5, 6 |
| Draft claim, idempotent send, uncertain transport | 2, 4, 7 |
| Draft TTL, deletion cleanup and restart recovery | 2, 3, 9 |
| Edit/revert/fork/move continuity | 4, 8, 9 |
| Plain HTTP, narrow viewport, no bearer-token URLs | 3, 6, 7, 8, 10 |
| Shared desktop behavior preserved | 1, 5, 7, 8, 10 |
| Host guard and deployment safety | 1, 10 |

Review the plan against the approved specification before committing it. Check
optional types and send signatures match across tasks, method names agree,
resource guards are used for every test command, and no API returns host paths.
Do not introduce a knowledge base, global library or general process-sandbox
project as part of this plan.

## Primary transport references

- Pinned source: `scripts/dev/fetch-opencode.sh` defaults to OpenCode `1.18.32`.
- Pinned OpenCode prompt input and message-ID persistence:
  `https://raw.githubusercontent.com/anomalyco/opencode/v1.18.32/packages/opencode/src/session/prompt.ts`.
- Pinned ascending identifier generator:
  `https://raw.githubusercontent.com/anomalyco/opencode/v1.18.32/packages/opencode/src/id/id.ts`.
- Installed `codex exec --help` and `codex exec resume --help` confirm native
  image options for fresh and resumed prompts; recheck at execution because CLI
  installations can change.
- Claude CLI and programmatic input reference:
  `https://code.claude.com/docs/en/cli-reference` and
  `https://code.claude.com/docs/en/headless`.

## Execution handoff

The default execution is inline in this session using `superpowers:executing-plans`.
If the user selects subagent execution, use `superpowers:subagent-driven-development`
with disjoint write scopes and review each returned change. Both paths follow the
same tests, memory guard, lifecycle requirements and final browser acceptance.
