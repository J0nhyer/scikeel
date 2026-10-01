# Web Conversation Attachments Design

**Status:** Product design approved on 2026-10-02; written specification awaiting user review.

## Goal and scope

Make attachments work like ordinary chat: upload files beside a question, see
those files on the sent message, return to the conversation later, and continue
working with the same originals without uploading again.

This feature targets the authenticated multi-user gateway Web client, including
phone-width browsers. Shared code must preserve desktop builds and existing
desktop attachment behavior. OpenCode, Claude Code, and Codex must use the same
attachment ownership and history rules; actual model input support is handled by
each adapter rather than assumed from successful upload.

The user approved these boundaries:

- Sent attachments remain available in their conversation until explicit deletion.
- Attachments belong to the current conversation, not a shared project library.
- Provide file selection, multiple files, drag and drop, and pasted screenshots.
- Show upload state and removable attachments before sending, and persistent
  attachment cards with preview/download actions after sending.
- Make upload errors and model-reading failures visible.
- Initial limits: 10 files per message, 25 MiB per file, and 100 MiB per message.
- Removing an unsent attachment cleans its temporary upload; deleting a
  conversation cleans its owned attachments.

## Existing implementation evidence

- `apps/desktop/src/components/thread/Composer.tsx` gates attachment selection,
  pasted files, and native drag/drop on `isTauri`.
- `apps/desktop/src/lib/tauri.ts` implements desktop-only workspace copies and
  deletion of composer-owned copies.
- `apps/desktop/src/lib/promptAttachments.ts` builds real image prompt parts from
  workspace files; currently it accepts PNG/JPEG/GIF/WebP up to 12 MiB.
- `apps/desktop/src/lib/artifactFile.ts` supports some authenticated Web file
  operations, but `readArtifact` currently returns null outside Tauri.
- `packages/sdk/src/OpenCodeClient.ts` sends image bytes as file parts. Its
  existing data-URL requirement must be preserved when this adapter is used.
- `services/platform/src/platform-server.mjs` authenticates platform requests and
  routes them to a worker belonging to the signed-in user.
- `services/platform/src/cli-runtime.mjs` currently extracts only text parts from
  incoming prompts. A successful file upload alone cannot make these CLI
  adapters see an image.
- `apps/desktop/src/lib/composerStash.ts` parks unsent drafts in memory. It is not
  durable attachment history.
- Sessions may share a project directory. Saving all uploads in that directory
  would not satisfy the approved conversation ownership rule.

These are observations of the current working tree, not claims about completed
Web attachment support. Existing uncommitted work must be preserved.

## Industry references and decision

Official ChatGPT and Claude documentation describes adding files from the
composer, dragging files/images into a conversation, and pasting images. Claude
explicitly separates individual chat uploads from project-wide files. Gemini
supports multiple files in one prompt and documents upload/analysis errors.

Retention differs between products: ChatGPT Library can retain a file separately
from its conversation. This feature deliberately follows the user's approved
conversation-local ownership rule instead of adopting an account-wide Library.
Product upload limits also differ and do not determine SciKeel's deployment
capacity; the approved initial limits above are SciKeel configuration.

Alternatives considered:

1. Save files and insert names into prompt text. Smallest change, but it does not
   provide dependable historical cards or prove image delivery.
2. Save originals and durable message/attachment associations. Selected because
   it supports normal chat behavior and adapter-independent ownership.
3. Add an ingestion pipeline and document knowledge base. Useful for a separate
   retrieval feature; not necessary for this attachment workflow.

References reviewed on 2026-10-02:

- [ChatGPT image inputs](https://help.openai.com/en/articles/8400551-chatgpt-image-inputs-faq)
- [ChatGPT file uploads](https://help.openai.com/en/articles/8555545-file-uploads-faq)
- [ChatGPT chat and file retention](https://help.openai.com/en/articles/8983778-chat-and-file-retention-in-chatgpt)
- [Upload files to Claude](https://support.claude.com/en/articles/8241126-upload-files-to-claude)
- [Upload and analyze files in Gemini](https://support.google.com/gemini/answer/14903178?hl=en)

## User experience

### Add files

Use the existing composer attachment position and visual language. A labeled,
keyboard-accessible attachment button opens a browser file input with multiple
selection. Phone browsers use their system picker. Dragging files over the
composer highlights its target; dropping uploads them and prevents browser
navigation. Pasted clipboard file items, including screenshots, become
attachments. Ordinary text paste retains its normal behavior.

The file picker and uploads must work over the existing non-secure HTTP deployment.
Do not depend on secure-context-only clipboard or UUID APIs for basic selection,
upload, or identifier creation. Native desktop drops remain unchanged.

### Pending attachments

Images show a thumbnail; other files show a file card. Both show original name,
size, and state: uploading, ready, or failed. Long names wrap or truncate without
pushing composer controls outside a 390px viewport. Controls work by touch and
keyboard, not only hover.

Users can remove attachments and retry individual failed uploads without losing
text or successful files. Pending or failed attachments prevent submission until
they finish, are retried successfully, or are explicitly removed. Enter and the
send button enforce the same rule. Attachment-only messages are allowed.

Each upload remains bound to the pane/draft/conversation that started it. A late
upload response must never add a chip to a different conversation after navigation.
Cancel pending work when appropriate, and clean any orphan created by an upload
that finishes after its owner has been discarded.

### Sent messages and history

Show attachments on their corresponding user message in selection order. Images
remain recognizable as thumbnails; other files retain their names and types.
Click/tap opens a supported preview or a file details view with download. Preview
failure never removes access to the original download.

Cards, original bytes, and ownership survive refresh and server restart. Later
turns in the same conversation can refer to previous attachments. The UI must
not require re-upload merely because the current composer contains no chips.

Failures before prompt acceptance retain the draft and attachment references.
An accepted turn with a model/runtime error retains its historical attachments
for retry. Editing/reverting messages must not delete originals still referenced
by another message or by restorable history.

## Architecture and ownership

### Attachment service

Add a focused platform attachment service behind authenticated routes. It owns
original bytes, durable metadata, upload validation, draft claims, preview/read
access, and cleanup. Keep these responsibilities out of the already large
platform request router and CLI runtime implementation.

Use opaque server-issued attachment IDs. A versioned record contains the owner
user, draft or session owner, message association, original filename, verified
size, detected MIME/type, content hash, private storage location, creation time,
and lifecycle state. Storage paths and provider credentials are not public
attachment metadata. Message associations preserve ordering.

The client sends attachment IDs rather than arbitrary host paths. Every upload,
claim, list, read, preview, download, and removal checks the authenticated user
and the owning draft/session. A user cannot claim an attachment from another
user or conversation by guessing its ID. Validate session ownership against the
runtime that actually owns it.

### Storage and isolation

Store originals in private platform storage partitioned by user and conversation
or unsent draft. Retain the original display name separately from an opaque
physical filename, so repeated names cannot overwrite files. Do not use client
filenames as storage paths. Reject malformed names and path traversal; never
follow symlinks out of the permitted storage boundary.

Do not copy originals into a shared project root or expose sibling conversation
uploads through generic file routes. Runtime-visible attachment references and
materialized working copies must be scoped to the owning conversation. Existing
project files keep their established project behavior. Conversation attachments
must not be automatically enumerated or injected into another conversation.

This is an attachment ownership and access boundary, not a new general-purpose
sandbox for all same-user agent commands. Any stronger process sandbox is outside
this feature; do not claim it has been implemented by introducing directories.

### New conversations and binding

Uploading into a new composer creates a private draft attachment owner without
creating a visible empty chat. Once a conversation is created, claim its ready
uploads for that conversation before accepting the corresponding prompt.

Claims are repeatable for the same owner and fail for conflicting owners. Persist
attachments and their association before reporting prompt acceptance. Retries
must not produce duplicate attachment records or associate files with the wrong
message. Recover cleanly if session creation succeeds but sending fails.

### Browser and SDK boundaries

The browser attachment helper handles file input, streaming upload requests,
progress/errors, and typed metadata. It never invokes a desktop bridge. Model
requests continue through `packages/sdk`; the UI does not call OpenCode directly.

Extend shared message/file metadata only where durable attachment rendering
requires it. Keep new fields optional so existing messages and desktop flows
remain valid. Scope preview/read helpers explicitly to the owning session rather
than relying on whichever global workspace was most recently active.

## Runtime delivery

Preserve original files for the entire conversation. Each new turn includes a
server-validated inventory of that conversation's retained attachments and
access to the corresponding originals; it does not inline every previous file
into every model request.

For newly submitted images, send actual image inputs when the chosen adapter and
model support them. OpenCode retains its existing real file-part transport.
Claude Code and Codex require explicit adapter integration; the current text-only
prompt compatibility handler is insufficient. A supported native image argument,
multimodal input, or evidenced image-reading tool path is acceptable. Plain
filename text is not evidence that the model saw pixels.

Documents and data files are made available through the conversation's scoped
file-reading tools. Support ordinary research inputs such as PDF, TXT/Markdown,
DOCX, CSV, XLSX, JSON, and code files according to available readers. Other file
types can be retained/downloaded, with explicit unsupported-analysis feedback
when the user asks to interpret them. Do not automatically execute uploaded code
or extract archives merely because they were uploaded.

The 25 MiB storage limit and model-specific input limits are separate. If an
image must be resized for delivery, preserve its original, disclose the delivery
transformation where relevant, and verify the adapter accepted the derived input.
If it cannot be delivered/read, show an actionable failure; never silently omit
it and answer as if its contents were seen. Files or extracted content exceeding
a model's context budget must receive a visible limitation or tool-based reading,
not unreported truncation.

## Lifecycle and failure handling

- Stream upload bodies to private temporary files; enforce the byte limit while
  reading as well as before upload when the browser knows the size. Do not base64
  encode an entire multi-file batch into a platform JSON body.
- Enforce file count and aggregate size on the server at message association,
  including retry requests. Client checks provide early feedback only.
- Publish a ready record only after all bytes are written. Disconnects, disk
  errors, oversized bodies, and invalid uploads leave no ready partial file.
- Removing an unsent attachment cancels its upload and deletes its owned temporary
  bytes. Abandoned unsent uploads expire after 24 hours; cleanup resumes after
  restart. Sent attachments do not expire with that temporary-upload policy.
- Failed uploads have per-file errors and retry controls; partial batch success
  remains usable. Failed prompt acceptance does not orphan successful uploads.
- Preview and download access is authenticated or uses short-lived file-specific
  tickets. Never put the account bearer token in a preview/download URL. Render
  active content with the existing sandbox boundary and safe download headers.
- Deleting a conversation revokes attachment access immediately and cleans only
  its originals, metadata, temporary derivatives, and owned working copies.
  Failed cleanup is retryable after restart. Never delete unrelated project files.
- Conversation moves retain attachment IDs and associations. Forking a
  conversation copies the referenced attachment ownership into the new session;
  either conversation remains usable if the other is deleted. Project-wide
  sharing controls are outside scope.
- Keep secrets and uploaded content out of routine request/error logs. Preserve
  best-effort local workspace snapshots for materialized working-copy changes,
  without adding remotes or pushing. Private upload storage is not a Git repo.

## Verification and release criteria

### Focused behavioral checks

- File selection, multiple files, screenshot paste, drop prevention, thumbnail/card
  rendering, attachment-only send, removal, progress, and individual retry.
- Send/Enter blocked by pending or failed uploads; failed acceptance retains text
  and files; switching panes mid-upload cannot misroute a completed upload.
- Server enforcement of 10 files, 25 MiB per file, and 100 MiB combined, with
  cleanup after aborted and oversized requests.
- Same-name originals remain byte-identical and separate. Path traversal,
  symlink escape, cross-user access, and cross-conversation claims are rejected.
- Draft claims and request retries preserve ownership and avoid duplicate cards.
- Sent history survives refresh and service restart. Later turns can read an
  earlier file. Edit/revert/fork/move behavior preserves referenced originals.
- Temporary expiry and conversation deletion leave unrelated project data intact.
- Preview/download authorization, active-content sandboxing, and byte-identical
  download verification for images, PDF, and CSV.
- Runtime delivery tests demonstrate actual image inputs and document reading for
  OpenCode, Claude Code, and Codex adapters, including unsupported-input errors.

### Browser acceptance

Use desktop and 390px phone viewports on the deployed Web client, including its
plain HTTP origin. Upload an image, a PDF, and a CSV; inspect cards; send a
question; refresh; reopen; download byte-identical originals; and ask a follow-up
using the earlier attachment. Verify another conversation does not inherit the
file and another user cannot access it. Confirm a visual model responds to image
contents rather than just its name, and a supported reader consumes actual PDF
and CSV content.

### Host and deployment safeguards

Run Web tests, typecheck, lint, and build through the repository package scripts
and their resource guards. Run heavy checks sequentially. A failed bounded build
must preserve the deployed bundle. Any required platform reload must account for
active conversations and workers; do not silently interrupt active agent turns.

Do not claim implementation or deployment complete until behavioral checks,
resource-bounded checks, and the applicable browser acceptance pass. Record real
milestones in `PROGRESS.md` with the latest result first.

## Outside this feature

An account-wide file library, project-wide attachment sharing, cloud drive
connectors, a vector knowledge base, automatic audio/video transcription, archive
ingestion, and desktop attachment redesign are not required for this release.
