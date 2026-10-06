# Web Tool Reliability Design

Date: 2026-10-07
Status: The user approved the proposed direction and requested this spec first. This document is for review; it does not authorize implementation or publication.
Scope: Public multi-user gateway Web with the managed OpenCode runtime, including phone-width viewports.

## 1. Problem and intended outcome

Some research conversations contain failed tool calls even though the assistant can answer and other tools work. The most actionable defects are a missing connection between tool authorization and public network access, and loss of specific research-delivery errors across backend and plugin boundaries.

The intended behavior is:

- A network call allowed by the existing session policy or an authenticated user decision receives the scoped network capability needed to execute.
- A failed call explains its actual known cause and the next useful action. Permission denial, incorrect input, upstream refusal, cancellation, and unknown interruption remain distinguishable.
- Recovery is bounded and respects the existing authorized objective. A retry cannot expand permission or duplicate a state-changing operation.
- Results survive refresh with accurate status. A stopped or interrupted write is never silently repeated.

This work reuses the existing gateway, EgressBroker, collaboration bridge, SDK, and tool rows. It does not introduce a general tool-management framework, new assistant runtime, or unrelated architecture refactor. Desktop UX and desktop live acceptance are outside scope; shared code must retain compatibility.

## 2. Evidence and uncertainty

Read-only inspection on October 7, 2026 examined live conversation records, the installed tenant image, and the effective platform source at `.deploy/web-releases/2026-10-06T10-00-57-668Z-78253dd5/source`.

| Finding | Evidence | Interpretation |
| --- | --- | --- |
| Network tools receive HTTP 403 | October 5–6 tool records include `websearch` against `search.parallel.ai` and `webfetch` against scientific and search websites | A shared network failure needs investigation before attributing each refusal to the remote website |
| Runtime proxy has no capability | `runtime/sandbox/runner.mjs` calls `buildJobEnvironment` without broker credentials; `cli-jobs.mjs` then assigns an unauthenticated proxy on port 4794 | Tool approval alone does not give that transport access |
| Grant issuance is not connected | Production creates `EgressBroker`; its `grant` method requires destinations and an expiry, but no non-test production caller of `egress.grant` was found | Supplying a static startup token would not complete the per-operation authorization flow |
| Proxy rejects missing authorization | A bounded unauthenticated request to the live proxy returns `egress_admission_denied` | The proxy rejection path is reproducible; this is not proof of the exact response body for every historical HTTPS call |
| Collaboration error is masked twice | ModelBroker only preserves recognized `model_*` errors; the collaboration plugin converts every non-success response to `Research checkpoint service unavailable` | A valid business rejection can appear as a service outage |
| Delivery paths are suspicious | One failed call supplied `workspace/demo_analysis/...`; those paths currently do not exist under the workspace root, while `demo_analysis/...` does | Missing inputs are a diagnostic lead, not a verified historical root cause; do not rewrite old records as proven missing-input failures |
| Other failures have distinct causes | Records include an outside-workspace glob, ambiguous/no-op edits, a nonexistent `recovery` tool, and `Tool execution aborted` | These should not all be treated as infrastructure failures |
| Historical skill failure is not consistently current | Skill calls failed with `ripgrep execution failed` on October 3–4, but later skill calls completed on October 6–7 | Repair only a reproducible current skill defect; retain deterministic regression coverage |
| Delivery can succeed | A later `research_delivery` call completed | Do not label the whole delivery service unavailable |

The main checkout has substantial unrelated modifications and lacks some deployed sandbox modules. Before implementation, re-identify the actual running source, installed image digest, OpenCode binary/version, frontend assets, and relevant pending changes. The paths above are evidence references, not permission to modify an obsolete release in place.

The full authorized network flow, remote search-provider availability, and historical cancellation causes remain unverified. No live Claude test is permitted under the current project instructions. An existing source pin defaults to OpenCode 1.18.32; implementation must verify the installed binary and its approval/transport behavior rather than infer it from the fetch script.

## 3. Options and decision

1. **Startup proxy configuration only.** Small change, but a process-wide token cannot represent destination-scoped tool approval, cancellation, or concurrent conversation ownership. It also leaves research errors masked. Reject as the complete solution.
2. **Complete scoped network authorization, typed errors, and bounded recovery.** Reuse the existing components, preserve current policy, and address demonstrated failures. Selected.
3. **Introduce a unified tool registry and execution service.** Larger migration without evidence that it is necessary. Defer.

Deliver in two verifiable slices under this spec: first network authorization plus collaboration error preservation, then presentation and bounded recovery. The first slice must already expose usable error messages and pass live network acceptance; it cannot rely on a future UI slice to explain new failures. A broken currently advertised capability must have an honest unavailable state.

## 4. Boundaries and responsibilities

| Component | Responsibility |
| --- | --- |
| SDK and existing Web permission UI | Carry existing approval decisions through the SDK and gateway; render sanitized outcomes without deciding server authorization |
| Trusted gateway | Derive account/worker identity, resolve session ownership and current execution/policy, validate user decisions, and authorize each network operation |
| Managed OpenCode network adapter | Execute `webfetch`/`websearch` with their current model-facing names and useful output contract; honor the existing permission interaction and cancellation signal |
| EgressBroker | Issue and check bounded destination capabilities, enforce public-address rules, maintain TLS transport, and revoke operation capabilities |
| Collaboration handler and plugin | Preserve safe business error codes and validate delivery paths while maintaining current collaboration and report schemas |
| SDK normalization and tool rows | Distinguish semantic failure, warning, explicit cancellation, and unknown interruption; preserve original execution evidence |

The frontend continues to call OpenCode only through `packages/sdk`. Runtime networking changes belong to the managed runner/adapter and trusted gateway, not browser-side requests to third-party search services.

## 5. Network authorization and execution

### 5.1 One authorized operation

The selected sequence is:

1. OpenCode creates a tool call with a validated session, call identifier, and bounded arguments. The network adapter validates the URL or query before requesting execution.
2. Apply the existing session policy for that tool. If manual approval is required, await the existing authenticated Web permission decision. If the current gateway-owned mode already permits the call, use that permission without another prompt. A research-plan approval does not implicitly grant every network permission.
3. The trusted gateway verifies account, active worker generation, session/workspace ownership, current execution, tool type, destination, and authorization. Approval-once applies to this call. Approval-always retains its existing declared scope and does not become unrestricted public egress.
4. Issue a short-lived EgressBroker grant for the approved destination origins. The grant is associated with the account, instance, generation, conversation/execution, and call in gateway-owned operation state. Derive identity from existing authenticated context; reject identity or permission claims supplied by tool arguments.
5. The adapter passes that grant to this operation's network transport. It does not mutate a shared `HTTP_PROXY` environment or install a permanent token for the whole OpenCode process. Two sessions must not overwrite or borrow each other's operation configuration.
6. Execute, decode a bounded response, and retain only safe result/error metadata. Revoke the operation's grant on success, failure, cancellation, or timeout. Worker shutdown continues to revoke all its grants.

Grant creation must occur after effective authorization. A `tool.execute.before` hook, prompt text, or plugin's assertion that a call was allowed is not sufficient proof. The implementation must use the pinned runtime's post-permission execution boundary and gateway-owned authorization state. If the stock tool cannot inject operation-specific transport after approval, supply a narrowly scoped managed adapter at that boundary, with a pinned runtime patch only where needed. Do not ship a hook that obtains a grant before permission, or a global-environment workaround. The plan must name and demonstrate this insertion point before feature implementation.

Gateway operation state is narrowly scoped bookkeeping for this bridge, not a new workflow scheduler. A capability visible inside its tenant remains a scoped bearer capability as in the existing isolation design; it must confer no upstream credential, administrative privilege, or access to other tenants. Separate calls receive separate capabilities. Session/call ownership is checked at issuance and retained for revocation; the HTTP proxy itself authenticates possession of the scoped token and tenant/generation, not an independently provable OpenCode session identity. Do not claim that a bearer token is inaccessible to arbitrary code running in its own tenant.

The internal adapter-to-gateway contract is a fixed `/network` route on the existing trusted broker bridge, authenticated through the existing scoped runtime context and routed separately from model inference. It accepts only version-1 `authorize`, `complete`, and `cancel` operations with bounded fields:

- `authorize` supplies `sessionId`, `callId`, tool name, execution identifier, canonical destination origins, and the existing permission request identifier when manual approval applies. The gateway validates these against its own session, policy, and approval records. It returns operation identifier, scoped grant, and expiry; it cannot accept arbitrary proxy/upstream addresses or caller-provided account identity.
- `complete` and `cancel` identify an owned operation and revoke its grant. Cleanup is idempotent. Expiry/lifecycle cleanup still operates if the adapter disappears without sending cleanup.
- Store only the minimum trusted operation/approval bookkeeping needed for ownership, replay rejection, cancellation, and safe terminal-history enrichment. Do not persist bearer tokens in user provenance or exported history. An internal response containing a grant is consumed by transport code, never returned as tool output.

Use one issued operation per tool call, and reject approval-once replay. A cross-origin redirect can request an explicitly scoped authorization continuation for that operation only after the new destination has passed policy/approval checks; it does not reset its time, byte, or retry budget. Both root and descendant sessions retain existing ownership validation, with cancellation matched to their actual call and owning execution.

### 5.2 Destinations, budgets, and cancellation

- Retain the existing HTTP(S) public-address restrictions and allowed ports. Reject private, loopback, metadata, link-local, rebound, and unsupported addresses; keep tenant direct egress blocked.
- A fetch grant covers only explicitly authorized origins. Resolve and validate every connection. Same-origin redirects remain subject to address checks; cross-origin redirects require a new policy evaluation and scoped grant. Follow at most five redirects inside the original time/byte budget. No destination expansion is inferred from an untrusted redirect.
- Search uses the configured search backend's exact origins. User queries and returned links cannot select the backend. Fetching a result link is a separate authorized operation. Preserve existing search output semantics, including real source references.
- Set an overall execution budget of at most 120 seconds per logical network call, starting after effective authorization and including grant acquisition, redirects, retries, body decoding, and retry delay. Waiting for a manual user decision follows existing approval lifecycle limits and creates no egress grant. Shorter existing user/runtime limits win. A grant cannot outlive that budget or its execution lease. Existing byte, connection, and request-body limits remain; do not raise host resource limits to make acceptance pass.
- HTTP and HTTPS traffic must demonstrably use the broker with operation credentials, including CONNECT behavior where applicable. Environment-variable presence is not acceptance evidence.
- Preserve TLS for public HTTPS destinations. Proxy credentials must not become origin headers. Shared provider credentials remain outside tenant mounts and model-visible output; never reuse the model-provider capability as a public-egress grant.
- Revocation is granular: cancelling one call revokes its grant and active connections, without cancelling another owned conversation. Account/instance shutdown still revokes all relevant grants. Mode changes, execution pause, or loss of an execution lease invalidate incompatible active operations through the existing lifecycle.
- Cancellation interrupts grant acquisition, waits, transport, response reading, and retries. Refresh alone does not replay a call, grant approval, or mark it cancelled. Existing page-bound execution rules remain authoritative.

### 5.3 Availability and failures

Distinguish a platform admission/grant denial from a remote website's HTTP refusal. The adapter must preserve a sanitized failure source and status instead of presenting both as an unexplained 403.

A search backend may be independently unavailable or require configuration. Verify it separately after broker access works. If unavailable, advertise that state with its reason and keep working fetch capabilities available. Do not silently replace it with another service or scrape several search websites after a policy/configuration failure. Expected disabled/unconfigured state is honest; an advertised search capability failing live acceptance remains a release failure.

Missing-grant platform errors should prompt an actionable administrative diagnostic, not another identical approval dialog. An expired or revoked grant cannot be renewed by a retry that bypasses the current policy check.

## 6. Safe errors across backend, plugin, SDK, and UI

Introduce one additive, versioned outcome detail for this feature; retain existing artifact/report/provenance schemas and raw runtime status. A known error detail carries:

- `version: 1`, a closed `code`, `category`, and `source` vocabulary;
- HTTP status when known, a safe message and next action;
- retry disposition: `never`, `transient_read`, or `repair_input`;
- a correlation identifier linked to the tool call; bounded safe details such as an approved origin or workspace-relative input path.

The internal error response is `{error: {version, code, category, source, status?, message, nextAction, retry, correlationId, details?}}`. Bound the serialized envelope to 8 KiB, keep `details` to allowlisted fields, and use workspace-relative paths and canonical origins rather than full credential-bearing URLs. The plugin/SDK must preserve structured fields through a verified error/event path; rendering must not depend only on searching the English message. Gateway-generated outcome details are authoritative only when fetched through an owned authenticated context, never because arbitrary tool text resembles this JSON.

Categories are `permission`, `configuration`, `input`, `upstream`, `transient`, `cancelled`, `interrupted`, and `internal`. Sources identify the producing boundary: gateway, egress, collaboration, runtime, or upstream. Unknown errors remain unknown; do not derive authoritative categories from arbitrary model/tool output.

| Code | Meaning | Default handling |
| --- | --- | --- |
| `tool_permission_denied` | Effective policy or user denied execution | Explain; no request or automatic retry |
| `network_admission_denied` | Platform capability absent or rejected | Configuration diagnostic; no repeated prompts |
| `network_destination_denied` | Destination is outside allowed scope | Explain blocked destination; no retry |
| `network_grant_expired` / `network_grant_revoked` | Operation capability is no longer valid | Stop; do not renew without current authorization |
| `network_busy` / `network_timeout` | Temporary transport limit or timeout | Bounded read-only retry when eligible |
| `network_upstream_refused` | Remote service rejected the request | Show known status/origin; no blind 401/403 retry |
| `search_unavailable` | Configured search backend is unavailable | Explain availability; do not fabricate results |
| `delivery_missing_input` | An original input does not exist | Show relative path and request a corrected input |
| `delivery_mode_mismatch` / `delivery_execution_paused` | Delivery action conflicts with mode or execution | Explain state; no blind retry |
| `edit_ambiguous_match` / `edit_no_change` | Replacement is ambiguous or identical | Targeted repair or truthful no-change outcome |
| `tool_unavailable` | Model selected an unregistered tool | Explain and expose the existing available-tool list |
| `execution_cancelled` | Authenticated user Stop was recorded for this call/execution | Display cancelled; no replay |
| `execution_interrupted` | Call ended without confirmed user cancellation or completion | Display interrupted; effect may be unknown |
| `tool_internal_error` | Unexpected failure without a safe recognized business cause | Safe explanation and correlation; no automatic replay |

Collaboration errors must be made typed at their source and serialized through an explicit safe allowlist for the collaboration route. Preserve appropriate 4xx business rejections and 5xx service failures. Do not broadly relax ModelBroker's error sanitization or forward arbitrary exception text. The collaboration plugin reads the bounded error envelope and propagates its code/message; actual connection/decoding failures use a service/transport error. A missing input must survive both layers as `delivery_missing_input`.

For legacy runtimes without structured details, preserve the existing readable error and mark the cause unknown unless a narrow, verified compatibility mapping applies. Missing new fields must not prevent loading old histories or shared desktop code.

Diagnostics contain tool/call correlation, safe code, source, stage, status, attempts, and elapsed duration. Exclude grant tokens, authorization headers, full proxy URLs with credentials, provider keys, prompts, query text, response bodies, and unnecessary host paths. Do not create a new telemetry service. Apply the existing retention/storage bounds to diagnostic records.

## 7. Delivery input validation

Before capturing a delivery scope, validate every original input and promised output with the existing workspace resolver and ownership checks. All paths must be workspace-relative and stay inside the current workspace after secure resolution. Validate all inputs before committing the scope; a failed preflight leaves it unchanged.

If the workspace root is `/.../workspace`, the file `/.../workspace/demo_analysis/report.md` is ordinarily specified as `demo_analysis/report.md`. Do not prepend `workspace/` by default. Do not automatically strip a literal `workspace/` component: a real nested directory with that name may exist. Return the exact safe relative path that failed, and a base-directory explanation; only suggest an alternative when its existence is verified.

Original input arrays may be empty only when the task actually has no original file inputs. Never drop missing files or convert an error into an empty array to pass verification. A corrected initial prepare is allowed while no scope is captured. Once captured, keep existing scope-change and original-version protections. This feature does not authorize changing user inputs, restarting research, or expanding promised deliverables.

Keep the existing version-1 report schema, original-input hashes/version checks, repair budget, and distinction between agent self-checks and independent scientific validation. A prepared delivery is not a completed or scientifically verified delivery.

## 8. Recovery and truthful presentation

### 8.1 Bounded recovery

- Automatic transport recovery is limited to explicitly read-only fetches and searches. A fixed search backend's POST may count as read-only only when its adapter declares that operation safe. Arbitrary POST, shell commands, writes, edits, installs, and delivery state changes are never replayed automatically.
- Permit at most two additional transport attempts per logical call. Retry only transient connection failures, eligible 429/502/503/504 responses, and eligible timeouts while budget and authorization remain. Respect Retry-After up to ten seconds and the remaining deadline. Otherwise use one- and two-second delays. No parallel retries or reset of the overall budget.
- One layer, the managed network adapter, owns transport retry. Duplicate issuance or retransmission of the same call cannot reset its attempt budget; a new model-created call is a separately visible tool call, not a hidden retry. A plugin or UI cannot multiply that retry budget. Record attempt counts, and return exhaustion to the assistant as a stop condition for the same unchanged operation; repeated model calls cannot be represented as hidden retries.
- Input repair is explicit model work with a new tool call, not replay: read the affected file, identify a unique edit context, then attempt one corrected edit. Existing collaboration repair limits remain authoritative. A second failure with the same cause must be explained rather than repeated unchanged. A no-op succeeds only as a verified statement that the requested change is already present; never claim a file was edited.
- Permission denial, 401/403 refusal, missing input, invalid tool name, cancellation, and revoked capabilities do not trigger automatic retries. New permission, new destination, or changed research scope follows its existing user decision requirements.

### 8.2 Web display and persistence

Use the existing tool row and detail area. Show a short localized reason plus a useful next action; technical details remain expandable. Display names and model-facing tool names remain compatible. Avoid a new modal for each failure or controls that only repeat a denied request.

Preserve the existing `ToolCallStatus` vocabulary: failures remain `failed`; cancellation, unknown interruption, and a verified no-change result use `warning` with additive outcome details and an explicit label. Known semantic failure from the built-in `invalid` tool displays as failed even if OpenCode's transport status is completed. Success requires actual successful execution, not merely a completed wrapper.

Record explicit Stop as trusted execution/call metadata before forwarding cancellation, and reconcile the actual terminal result. A late success remains success if the operation completed; an affected aborted call can use cancelled only when the matching authenticated Stop is established. `Tool execution aborted` alone proves neither user cancellation nor that a write made no change. Preserve unknown/partial-effect information and never automatically replay it.

Safe terminal outcomes and verified cancellation reasons must be recoverable through existing history paths so a refresh presents the same known result. New optional fields are backward compatible; the original tool record is not rewritten. A browser disconnect alone produces no success, failure, or cancellation claim.

At a 360 CSS-pixel viewport, the reason and next action must wrap without horizontal overflow; expandable details must stay operable by touch and keyboard. Add strings to existing English/localized catalogs and keep their parity. Product copy must not expose internal tokens, installation paths, or broker implementation details.

## 9. Acceptance evidence

All builds, tests, typechecks, and lint run through the existing guarded package scripts; serialize heavy work on this host. A documentation-only spec needs no application build. During implementation, first add meaningful reproductions at the affected boundaries, then run the required guarded suites and live Web checks. Preserve user files, conversations, credentials, and recoverable state.

| Boundary | Required acceptance |
| --- | --- |
| Permission to transport | Through a real Web conversation and managed OpenCode, an allowed public fetch succeeds using a scoped grant; a denied call produces no outbound request |
| Automatic policy | A mode that already allows that tool succeeds without an extra prompt; manual mode still waits for the actual decision; an untrusted claim cannot obtain authorization |
| Scope and lifecycle | Foreign-session or replayed authorization requests, wrong tenant/generation at transport, expired/revoked capability, private/metadata destination, and an unapproved cross-origin redirect are rejected; cancellation revokes only its operation; worker restart invalidates its old grants |
| Concurrent sessions | Two conversations keep distinct operation capabilities; one Stop or grant failure does not overwrite/cancel the other's state; existing capacity limits give a truthful busy outcome |
| Real search | Configured search returns real source references through the authorized transport, or an intentionally disabled/unconfigured capability is explicitly unavailable; a currently advertised broken capability cannot pass |
| Error propagation | A missing original input and mode/paused-execution rejection retain their distinct safe codes through handler, ModelBroker route, plugin, SDK, UI, and reopened history; genuine outage is separate |
| Input integrity | Bad initial prepare does not capture scope, silently remove missing inputs, modify original files, or relax version checks; legitimate nested `workspace/` paths remain valid |
| Semantic status | Unknown tool is failed; ambiguous edit supports targeted repair; identical edit is not falsely reported as a modification; abort without known Stop is interrupted |
| Retry budget | Eligible transient reads retry at most twice inside 120 seconds; refusal and mutation do not replay; cancellation stops all waits and pending attempts |
| Browser and refresh | On desktop-width and 360-pixel Web viewports, a failure explains reason/action, Stop remains accurate after reload, and reload does not replay an unfinished write |
| Sensitive data | Captured errors, events, logs, provenance, exports, browser console, and test artifacts contain no proxy/grant/provider credentials |
| Regression | Conversation history, workflow delivery/version-1 reports, original-file protection, refresh recovery, model selection, and SDK compatibility pass affected checks |

Use controlled fault injection or a fixture origin for deterministic failures and counted outbound requests; use a real permitted public origin and the real managed runtime for the positive flow. Do not equate a unit test of `EgressBroker.grant` with proof that OpenCode uses it. Real model acceptance uses an available non-Claude model and an actual successful tool invocation; deterministic fixtures remain required even if a live provider is temporarily unavailable. Provider outage leaves live acceptance incomplete, not passed.

Before publishing, retain sanitized evidence of effective source identity, runtime version, image digest, browser assets, checks, and rollback readiness. If adapter/plugin/runner resources change, rebuild and attest the bounded scientific image and deploy it coherently with the platform and Web bundle. Source tests alone do not establish that the installed image contains the fix. Follow the existing resumable publication workflow; failed builds leave the deployed bundle untouched, and rollback preserves tenant data.

## 10. Scope exclusions and completion

No new search provider selection UI, generic tool registry, blanket network allowance, global approval-off mode, desktop feature work, native/SSH/computer-use expansion, scientific-method changes, or shared-schema migration is included. Repair historical skill/ripgrep behavior only if a current bounded reproduction proves a defect necessary for these flows.

The design is ready for an implementation plan when its authorization boundary and contracts are accepted. Feature completion requires the acceptance evidence above on the installed Web stack and an accurate account of any remaining upstream limitation. No code, runtime restart, build, deployment, or live model request is performed as part of writing this spec.
