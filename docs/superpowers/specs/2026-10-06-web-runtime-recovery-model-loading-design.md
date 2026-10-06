# Web Runtime Recovery and Model Loading Design

Date: 2026-10-06
Status: Approved by the user on 2026-10-06; implementation and the planned Web publication are authorized.
Scope: Public multi-user gateway Web, including phone-width viewports.

## 1. Problem and intended outcome

The user reports that refreshing the project requires reconnecting OpenCode and that model lists take a long time to load. A browser refresh necessarily creates a new browser event-stream connection. The intended behavior is automatic restoration of the existing server-side assistant, workspace, conversations, and valid model selection, without requiring a Connect click during a successful recovery.

Model selection and conversation history must become usable as soon as their own necessary reads finish. Optional public availability checks, agent lists, and skill scans must not delay them. A real connection, authorization, or required-catalog failure must remain visible and must not be disguised by a remembered ready flag.

The user explicitly requested **spec first, then plan, then implementation only after approval**. This document and its plan are review artifacts, not implementation evidence.

## 2. Evidence and remaining uncertainty

Read-only inspection on October 6, 2026 identified the following:

| Boundary | Verified code behavior | Implication |
| --- | --- | --- |
| Shell -> store | `AppShell.tsx` invokes `bootstrap()`, which invokes Web `connectRetry()` | Refresh already requests automatic connection; missing auto-connect is not the demonstrated explanation |
| Browser -> gateway context | `runtime.ts` starts `/api/me`, `/api/runtime`, and `/v1/whoami`, then waits before constructing the SDK client | Necessary context contributes to restoration latency; those requests are already concurrent |
| Metadata errors | The account/runtime `Promise.all` maps either rejection to `null`; its enclosing catch treats failure as an older gateway lacking metadata | A platform metadata failure can erase a successful runtime response and leave `gatewayRuntime` unknown while the event stream becomes ready |
| Retry behavior | Web defaults to four attempts; whoami permits 60 seconds and each metadata read 15 seconds; no overall Web recovery deadline is present | Retries can exceed the 90-second login preparation deadline; an SSE-ready but invalid-context state can bypass meaningful recovery |
| Model publication | `loadCatalog()` publishes agents, default, commands, and providers only after their shared `Promise.all` | A slow agent read delays otherwise-ready models and commands |
| Provider enrichment | `listProvidersWithAvailability()` waits for both native providers and `zenServedModels()` | A public Zen check delays all provider lists, including lists without Zen |
| Availability cache | Zen cache is module memory, with a ten-minute TTL | Refresh discards it; the check is repeated by a new page |
| Native catalog transport | SDK `listProviders`, `getDefaultModel`, `listCommands`, `listAgents`, and `listSkills` use direct fetch reads rather than the bounded request helper | An independent catalog branch can still hang unless Web requests and body decoding are explicitly bounded |
| Availability transport | Web `gatewayGet()` has no client cancellation deadline; the Rust upstream model probe has a five-second timeout | The browser has no explicit overall bound, even though the upstream request is bounded |
| History publication | Both `openSession()` and `loadHistory()` await `catalogInFlight` when command templates are empty | Even completed message reads can wait for model enrichment and skill scanning |
| Login preparation | Successful handoff requires ready connection, sessions, a `ready` catalog, and a default; `limited` is not accepted | A usable limited catalog can unnecessarily remain on the preparation screen |

The inspected production service runs from `.deploy/web-releases/2026-10-05T22-03-56-047Z-ec65dd2e/source`. The relevant wait/error patterns also exist there. Several main-checkout files differ from that source and the main checkout contains extensive unrelated uncommitted changes. Execution must re-inspect the effective service source and Web assets rather than assume this recorded path remains current.

These are verified dependencies and failure paths, **not a captured trace of the user's failed refresh**. The precise request responsible for the reported manual reconnect, actual endpoint durations, and any large-list rendering cost remain unverified. The first implementation task must capture a safe baseline and produce deterministic reproductions before fixing a specific failure. Do not claim that OpenCode restarts on every refresh or that model enumeration itself is slow without evidence.

## 3. Approaches and decision

1. **Lengthen timeouts or persist a connected flag.** Small change, but keeps unrelated waits coupled and can display a usable state without a usable stream. Reject.
2. **Separate required reads from optional enrichment and fix recovery ownership.** Keep the existing SDK and gateway APIs; publish each catalog branch independently, validate required platform context, and bound automatic recovery. Recommended.
3. **Persist the entire account model catalog or create a new server bootstrap API.** Could reduce some cold reads, but introduces stale authorization/account-isolation problems or a wider backend/image change. Defer unless measured required-context latency demonstrates a separate backend bottleneck.

Use approach 2. Persist only the public, credential-free Zen ID advisory described below. Do not add an account catalog cache, a new gateway protocol, provider probes, or a runtime restart mechanism.

## 4. Requirements

### R1. Automatic recovery with truthful state

For a valid platform login and a healthy existing worker, opening or refreshing a conversation automatically restores the correct assistant, workspace scope, event stream, and session list. No manual Connect click is part of the successful path. Browser refresh never sends stop/restart/abort requests merely to recover the browser connection.

There is one active Web recovery owner for a connection context. Calls from bootstrap, retry controls, browser recovery events, and session opening share the same recovery when they target that context. An assistant/workspace change supersedes the previous context; it must cancel obsolete pending requests and prevent their stream callbacks, failures, or catalogs from mutating the new state. A late old failure must not tear down a new ready stream.

Keep the existing SDK SSE reconnection and status-blip grace. Do not introduce a second reconnect timer for a stream the SDK is already recovering. Desktop retry behavior is unchanged.

### R2. Required platform context is validated before connection

On multi-user platform Web, the current `/api/runtime` response must identify a supported assistant and compatible runtime kind. It must not silently fall back to OpenCode or an unknown assistant after network failure, timeout, non-success status, or malformed data. Treat recoverable failures as failed attempts eligible for automatic retry.

Read `/api/me` independently: its failure must not discard a valid assistant response. Until account role is verified, hide privileged account controls. Do not use account metadata failure as evidence that the runtime is unavailable.

Require successful workspace scope and permission mode from `/v1/whoami` before connecting on platform Web. Preserve the saved conversation's permitted directory scope and read-only mode. Never turn a failed read-only/context lookup into unrestricted mode. Standalone gateway compatibility retains its explicit legacy metadata fallback; isolate that fallback with `isPlatformWeb` rather than applying it to every Web gateway.

### R3. Bounded recovery and independent catalog retry

Keep four Web connection attempts, existing 250-ms early backoff, five-second SDK stream-open deadline, 15-second metadata request ceilings, and a 60-second cold workspace ceiling. Add **one 90-second total recovery budget**, starting when Web restoration starts, with every attempt's request ceiling clamped to the remaining budget. Never extend the host/runtime limits to make a test pass.

Web catalog reads have a 15-second request ceiling, including body decoding, clamped to their remaining startup budget. Add optional SDK read cancellation/deadline arguments; existing no-argument desktop/runtime callers retain their behavior. Connection-context/session-list failures retry through the recovery owner. Catalog failures retry their own reads, without closing a healthy event stream, using at most four attempts and 250/500/1000-ms delays within the same startup budget. Retain a successful command branch when another catalog branch fails.

After the recovery budget is exhausted, show the failed stage and a working retry control. A genuine browser `online` event or return to a visible tab may start a new recovery only when the store is failed/offline and there is no active recovery; coalesce event bursts and allow at most one event-triggered attempt window per five seconds. A healthy foreground tab does not re-fetch on each visibility event. Do not retry a platform login-expiry redirect.

### R4. Models, commands, agents, and skills publish independently

Split `loadCatalog()` into independent branches within the existing runtime store:

- Models depend on the current assistant's required metadata, successful native provider read, and default-model read/reconciliation.
- Commands depend only on the current runtime's command read.
- Agents and skills keep their existing background behavior, including bounded empty-skill retries.

For OpenCode, publish the native provider catalog and usable default as soon as that branch succeeds. `/agent`, `/skill`, `/command`, and `/v1/zen-models` cannot hold model publication. For Codex, use the selected account's existing managed catalog; OpenCode provider reads must not replace it.

Maintain `catalogInFlight` for callers explicitly asking for the complete catalog, but add a command-only in-flight promise for history reconstruction. Both foreground and background history loaders wait only for that promise, and only when they lack templates. Preserve slash-command expansion reconstruction. Command failure resolves to the existing safe fallback rather than making all history wait forever.

Required-catalog failure marks that catalog unavailable and disables sends/model changes. Existing visible choices may be retained as disabled presentation, but must never be treated as newly verified. Keep existing tests that discard stale refresh responses and block sends after a failed authoritative refresh.

### R5. Zen availability is optional, bounded enrichment

For Web, native providers are the source of model identities. Zen availability may only annotate those identities and may never add models. Return providers immediately with a fresh public advisory if one exists; otherwise return providers with availability unknown and request the advisory in the background. Do not wait for that request in model/history/login readiness.

Do not request Zen availability when the catalog lacks provider ID `opencode`. When it is present, share one in-flight lookup per page and bound the browser request to three seconds. Failure, empty answers, or answers overlapping none of the native Zen IDs mean unknown, preserving the existing fail-open behavior. Desktop uses its existing awaited lookup semantics and transport.

Store successful public IDs in `sessionStorage` under `scikeel.zen.models.v1` with schema version 1 and `fetchedAt`; TTL is ten minutes. Accept only an array of 1..4096 strings, each 1..160 characters without control characters, a finite non-future timestamp, and a valid unexpired version. Storage corruption/unavailability is a cache miss. Failure is cached only in page memory for 30 seconds. This cache contains no providers/configuration, model credentials, user identity, conversations, selection, permissions, or connection state. Advisory IDs are applied only to IDs in the current native catalog, so another account cannot gain model choices through the cache.

A late advisory is applied only to its still-current client, assistant, connection generation, and model-load generation. It updates availability and view readiness, never writes a new runtime default or persisted session model selection. If a verified retirement makes the selected model unavailable, require an explicit valid selection; never silently switch the user to a paid model. Reject unavailable OpenCode selections both before creating a turn and immediately before dispatch, matching the existing managed-CLI send guard.

### R6. Usable login handoff and honest failure UI

The fresh-login preparation screen may hand off when connection and sessions are ready and the selected assistant has a valid default in a successful `ready` or `limited` catalog. This is not a service-availability guarantee. Optional enrichment, agents, and skills do not gate handoff.

A normal reload keeps the existing no-login-overlay behavior. Connection/workspace/session failures offer connection recovery; required model failures offer catalog retry without disconnecting an established stream. Reuse existing controls and localized text where possible; any added copy must be English in project files and covered by all locale parity checks. No new settings or dashboard is needed.

### R7. Authentication, state, and platform boundaries

Preserve platform cookie authentication and the existing distinction between explicit session-expiry responses and an upstream provider 401. Preserve the current route when returning to login. Do not copy tokens/cookies into caches, traces, progress, or exported artifacts.

Preserve session contents, files, workspace isolation, server-side running turns, approval behavior, valid selected models, and model/account separation. The UI accesses runtime operations only through the SDK/store boundary. No speculative provider calls, real Claude probes, adapter replacement, or desktop UX changes are in scope.

### R8. Evidence, performance, and release

Before implementation, measure navigation-to-context, SSE open, session list, history publication, native models, commands, and optional enrichment using monotonic timestamps. Record paths/status/durations only; never response bodies, request bodies, cookie/header values, or conversation text. Render timing/large-list work is a separate hypothesis to address only if that evidence identifies it.

In deterministic staged-browser tests, required data responds within 100 ms, SSE opens after 700 ms, and optional Zen/agent/skill requests are held for six seconds. Models and history must become usable within three seconds and before those optional responses complete. Tests must also prove relative ordering, so performance success cannot be faked by increasing timeouts. Measure five warm production reloads after deployment and report median/max; do not promise a fixed production latency independent of network or cold-worker startup.

Implement in an isolated checkout based on the effective production-compatible source, retaining unrelated main-checkout edits. Use a linked git worktree sharing the main repository's common git directory and heavy-task locks. Use package scripts and existing cgroup serialization for tests, typecheck, lint, staged Web build, and browser acceptance. A failed preparation leaves the served bundle unchanged. Use the bounded `web:release` workflow for publication and verified rollback. This frontend-only design does not require a new scientific image; a discovered image/backend prerequisite requires a revised scope before implementation.

## 5. Acceptance matrix

| Case | Required result |
| --- | --- |
| Warm conversation refresh, repeated five times | Correct assistant/workspace/model restored automatically; history usable; no Connect click, stop, or runtime restart |
| Slow/hung Zen, agent, or skill reads | Native models, history, and usable login handoff precede optional completion |
| Providers without Zen | No Zen request |
| Valid public advisory across module reload | Reuse within TTL; no redundant remote lookup; only current native IDs annotated |
| Expired/corrupt/future/blocked storage | No crash or waiting; background lookup/fail-open behavior |
| First required context/session read fails, next succeeds | Automatic recovery reaches usable state without manual action |
| Required context returns wrong assistant/kind or fails throughout | No fabricated OpenCode-ready state; bounded, actionable failure |
| `/api/me` fails while runtime/context succeeds | Correct assistant still connects; privileged controls remain hidden |
| Authoritative catalog fails then recovers | Stream stays connected; sends blocked until fresh valid catalog; command/history branch remains usable |
| Concurrent bootstrap/retry and rapid workspace/assistant switch | One winning recovery; obsolete successes/failures/availability cannot overwrite it |
| Selected model is retired or revoked | Explicit model choice required; no silent paid/default switch; send guards hold |
| Read-only scope or explicit login expiry | No writable fallback; expiry returns once to login with current route |
| Ongoing server-side turn across reload | History/stream catch up; Stop remains functional; browser restore does not abort it |
| English/Chinese at 1280, 390, and 320 px | Correct status/retry behavior, usable pickers, no horizontal overflow or page errors |
| Standalone gateway and desktop deterministic suites | Existing compatibility retained; no desktop deliverable added |
| Guarded build/publication failure | Existing live release remains intact or verified rollback restores it |

## 6. Self-review and approval boundary

Self-review checked evidence against both inspected source locations, separated hypotheses from confirmed code behavior, preserved existing authorization/send restrictions, and covered superseded request races, cache expiry, command-only history, limited catalogs, phone widths, live-turn continuity, host limits, and production-compatible release selection.

No production trace, reproduction test, performance improvement, implementation test run, or deployment is claimed by this document. The companion implementation plan is prepared next as requested. **Do not implement either artifact until the user approves.**

Execution update (2026-10-06): The user approved implementation and maintenance pauses. The user subsequently excluded phone-width acceptance; this release will verify desktop Web in English and Chinese.
