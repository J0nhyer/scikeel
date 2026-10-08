# Web Session Continuity and Interaction Recovery Design

Date: 2026-10-07 (UTC; inspected production records include October 8 in Asia/Shanghai)
Status: Spec and browser-close policy A approved; development subsequently authorized by the user on October 8, 2026 (Asia/Shanghai). Implementation is committed in an isolated worktree. Candidate `2026-10-07T21-32-04-409Z-81c03ee0` is prepared and all required staged checks passed. Production publication and external-provider lifecycle acceptance remain a separate approval/gate.
Scope: Public multi-user gateway Web, including phone-width viewports. Retain shared desktop compatibility; desktop UX and desktop live acceptance are outside scope.

## 1. Problem and intended outcome

The user starts a conversation either from one of the five welcome starters or from their own text. After refresh or navigation, execution can appear interrupted. Submitting an answer to a question produces a reported HTTP 400 with a missing-question message. Reverting a message in the same affected conversation produces `Failed to revert the message: 404 session not found`.

Refresh and switching conversations must not cancel an accepted turn, invalidate a live question, or send an operation to another conversation. A conversation that remains in durable storage must become usable again after verified context recovery. A genuinely expired question must not remain an active, misleading answer control. The UI must distinguish a lost connection, an unknown operation result, a stopped execution, and a missing resource.

These symptoms are related but are not proven to share one historical triggering request. In particular, the exact reported 400 response and 502 network trace have not been captured.

## 2. Effective source and evidence

The inspected production release is `2026-10-07T15-01-18-055Z-76b5c71c`, with service source at `.deploy/web-releases/2026-10-07T15-01-18-055Z-76b5c71c/source`. The main checkout contains substantial unrelated changes and lacks some production sandbox modules. An eventual implementation must use a production-compatible isolated worktree and recheck the effective source, frontend bundle, installed image identity, and native OpenCode pin. Do not patch an immutable deployed release in place.

Production conversation storage was opened read-only. Temporary, isolated diagnostics imported the deployed modules and ran through `pnpm platform:test` and the existing cgroup guard. They used synthetic accounts, local fixture servers, and disposable storage; they did not modify user conversations or workspace files.

| Finding | Evidence | Confidence and limit |
| --- | --- | --- |
| The five welcome starters use the normal send path | `components/thread/WorkflowStarters.tsx` and `components/session/SessionView.tsx` call the ordinary send handler | Confirmed code behavior; a separate starter transport is not indicated |
| Durable session existence and gateway registration are different | `TenantPolicy` keys session/request authority by instance, generation, and ID; managed proxy checks that registry before calling the runtime | Confirmed code behavior |
| A generation change can produce a misleading session 404 | Isolated HTTP diagnostic: revert succeeds, account generation changes while the upstream session remains, revert returns `404 session not found` without reaching upstream; verified session listing restores registration and revert succeeds | Reproduced mechanism. The triggering generation change for the user's exact failed revert is not yet traced |
| Running work is bound to browser presence | `CollaborationStore.heartbeat` expires after 45 seconds; `tick` pauses active/waiting execution and invokes cancellation when no lease survives | Confirmed and reproduced. This is existing policy, not proof that every navigation loses all leases |
| Background continuity already exists | `useConversationLeases` renews locally known running sessions; refresh discovery reads runtime status | Do not replace this with a duplicate heartbeat system or claim every switch necessarily cancels |
| A fast send/navigation or slow reload has a vulnerable ownership window | Async `performTurn` adds its running lock after prompt POST acknowledgement unless SSE establishes it first; refresh discovers runs after connection/list/status reads | Confirmed ordering; exact historical lease loss still needs trace evidence |
| Questions can outlive their runtime request in the UI | Backend cancellation retires native pending questions; frontend terminal-error handling does not perform the ask cleanup done by explicit `interrupt` | Confirmed code gap and consistent with the user's submission failure; exact failed question ID is not available |
| Failed question submissions lose their card | `answerQuestion`/`rejectQuestion` remove the question before awaiting the SDK request and only set a global error on failure | Confirmed code behavior |
| Permission replies have a related reliability gap | `replyPermission` removes a batch before acknowledgement and ignores all 404s as resolved, without proving that this answer was accepted | Confirmed code behavior |
| Revert blindly repeats an unrecovered failure | `revertToMessage` retries every failure up to five times, does not restore current-generation authority, and proceeds after an interrupt that may have failed | Confirmed code behavior |
| Backend cancellation occurred in recent conversations | October 8, 2026 around 01:35 Asia/Shanghai: several `question` calls, one `research_checkpoint`, and assistant messages contain aborted results; runtime logs contain cancellation entries | Verified historical interruption. Caller/reason attribution is incomplete; a platform restart at 01:36 is also recorded |
| The proposed 30-second SSE cutoff was disproved | The managed proxy clears its timeout after successful SSE headers; a healthy fixture stream lasted 35 seconds and 140 frames until the diagnostic client deadline | Negative finding. Preserve this existing behavior; do not lengthen or remove a nonexistent stream lifetime limit |

The three isolated diagnostic cases passed. They establish current mechanisms, not a completed live reproduction of the entire user sequence. Auxiliary administrator API probes belong to another account and can affect sandbox admission; they are not evidence that the user's runtime spontaneously restarted. Do not infer restart cause from those observations.

Pinned upstream references are OpenCode `v1.18.32`:

- `packages/opencode/src/question/index.ts`: pending questions are instance state; cancellation/finalization removes them.
- `packages/opencode/src/server/routes/instance/httpapi/handlers/question.ts`: a missing request becomes `QuestionNotFoundError`.
- `packages/opencode/src/server/routes/instance/httpapi/errors.ts`: the inspected handler declares HTTP 404 for that error. The user reports 400; retain both the exact status and typed cause during diagnosis rather than rewriting the report or treating every 400 as expiry.

## 3. Approaches and confirmed policy

1. **Only hide errors and retry buttons.** Small change, but leaves lost authority, expired questions, ambiguous acknowledgements, and page-triggered cancellation in place. Reject.
2. **Keep browser-bound execution and repair recovery within the lease window.** Preserves automatic stop after the last page disappears. Even with faster recovery, a long reload, mobile suspension, or network outage can exceed the window. This approach cannot promise that page absence never ends work.
3. **Separate accepted execution from browser presence, then repair authority and interaction recovery.** Recommended. Refresh, navigation, hidden tabs, and browser closure do not cancel an accepted turn. Explicit authenticated Stop, a real runtime interruption, and existing enforced execution/resource limits remain meaningful termination conditions.

**Confirmed user decision: A.** Actual browser closure allows an accepted execution to continue, as described in approach 3. Refresh, session navigation, mobile suspension, and browser closure do not cancel work merely because browser presence expires. Reopening attaches to the actual running, waiting, completed, or interrupted state without automatically resending a prompt. The requirements below specify this selected policy; approach 2 is retained only as the rejected alternative.

This changes the previous page-bound Web execution policy. It does not enable unattended arbitrary new work, remove tool permissions, widen workspace authority, enable Claude, or add cumulative usage limits. Existing host admission, per-task resource bounds, and selected autonomy policies remain enforced.

## 4. Requirements

### R1. Execution ownership and browser lifecycle

Once the backend accepts a user turn, its execution belongs to the authenticated account and session, not a mounted component or SSE connection. Component cleanup, page hide, refresh, switching panes, timer throttling, and heartbeat expiry must not forward Stop or revoke an accepted execution solely because the page is absent.

Use the existing durable collaboration/execution state and runtime liveness checks. Heartbeats may describe presence and support connection recovery, but do not establish completion or cancellation. A waiting question is still an execution requiring input, not an idle browser-owned timer.

Stop remains explicit and session-scoped. A worker crash/restart must be reported as interruption; surviving history is not proof that the process survived. Restore persisted decisions and draft answers, but never silently resume execution, reissue mutations, or invent model continuation after a worker restart.

Audit both the current collaboration path and any reachable legacy research-panel release callbacks so a second path cannot retain page-close cancellation. Do not remove unrelated legacy data.

### R2. Verified context recovery before session operations

Keep account, instance, generation, workspace, and parent-session checks. Old-generation authority must remain invalid; never make a cache miss authorize an ID supplied by the browser.

On an unregistered session in the current generation, the backend performs one bounded, coalesced, read-only lookup through that authenticated user's current worker. Re-register only the returned, validated session identity, owned directory, and required parent chain. Recheck context generation after the lookup. A genuine native absence remains not found. A failed/unavailable verification produces a recoverable context/runtime error rather than asserting that the session was deleted.

Do not depend on the user visiting the session list before history, question handling, Stop, or revert works. Scope every recovery to the account/instance/generation/session; no peer-account lookups, stale-credential fallbacks, guessed directories, or copying old request IDs into a new generation.

Use the existing Web recovery deadline and SDK bounded request facilities. Coalesce concurrent recovery and cancel superseded attempts. Do not add overlapping global reconnect loops or five unbounded retries.

### R3. Question and permission lifecycle

Use the existing request/session identifiers and native tool/message identifiers to correlate interactions with their owning runtime context. Preserve useful correlation fields in SDK normalization instead of losing them.

A question card remains mounted while its answer is submitting. Disable duplicate submission, preserve selections/free text, and retire the card after confirmed acceptance. Recovery reconciles current pending requests against the authoritative result for the correct directory/context; a late list result must not erase a newer request.

On a transient request failure, keep the answer and a retry/synchronize action. If the request truly expired, render it as expired with a plain explanation and preserve the user's answer. Do not present an expired ID as answerable or automatically submit its answer to a newly created question.

A missing pending request alone does not prove this submission succeeded: it may have been cancelled, answered elsewhere, or lost during restart. After a lost acknowledgement, reconcile native tool/history state where it establishes acceptance; otherwise show an unknown outcome and preserve the answer. Do not blindly replay an ambiguous submission or label it successful.

Confirmed terminal execution events invalidate unresolved cards for the affected session subtree, including backend-originated cancellation. A transport disconnect alone does not invalidate them. On runtime generation change, invalidate old request authority and recover live requests; preserve expired question content/draft answers for explanation and explicit user recovery.

Apply these rules to permission replies too. A stale duplicate may be retired, but a blanket 404 is not proof that a permission decision landed. Preserve each batch member's result; do not claim a successful grant after runtime restart or account/context change.

Existing gateway-owned research decisions remain durable and separate from native transient questions. Their existing revision/execution checks and authenticated answer ownership remain in force.

### R4. Revert and message editing

Before revert, verify current session ownership and the target message's membership. If execution is active or unknown, reconcile state and obtain confirmed Stop/idle before attempting a revert. A failed Stop must not be followed by a mutation presented as a valid idle operation.

Recover authority before retrying a registry-related error. Retry only a recognized transient/busy condition with a bounded deadline. Validation errors, foreign ownership, genuine missing messages/sessions, and expired context are not five immediate retries of the same request.

Do not truncate the local transcript before backend confirmation. After confirmed revert, reload authoritative session metadata/history and retire the affected pending interactions. If the acknowledgement is lost, inspect the existing revert marker/history before offering another attempt; do not blindly replay a file-affecting operation.

Use an explicit captured target session/client/context throughout. Navigation during the operation must not redirect it or its error into the newly focused conversation. Editing a past message may resend the corrected text only after revert is confirmed.

### R5. Truthful status and observability

Keep transport availability, execution liveness, and interaction validity separate. A recoverable 502/reconnect must not become a terminal model error or hide Stop while the worker is still running. Do not promise every 502 is recoverable: preserve genuine backend failure.

Record sanitized request path/operation, monotonic duration, HTTP status, error category, session/request/call identity, execution and runtime generation, and a trusted cancellation reason where available. Do not log credentials, cookies, tokens, conversation text, answer contents, or raw model bodies.

Distinguish explicit Stop, page-policy expiry if retained, worker restart, context unavailable, request expired, and unknown interruption. `Aborted` alone is not proof of user cancellation. Trace the user's exact 400/404/502 sequences before claiming one historical cause. Preserve existing human-readable typed research/network outcomes rather than replacing all failures with a service-unavailable banner.

### R6. Other tools and compatibility

The shared interaction/context defects can affect multiple tools. Do not label every recorded error a broken tool.

| Tool/path | Observed evidence | Required verification |
| --- | --- | --- |
| `question` | Successful older replies and recent aborted calls; reported missing request on submission | Answer, free text, refresh while waiting, session switch, expiry, cancellation, lost acknowledgement |
| Permission-gated `bash`, write/edit, network tools | Permission reply uses optimistic removal and blanket 404 suppression | Valid approval, denial, stale reply, worker generation change, preserved authorization |
| `research_checkpoint` | Recent aborted call; decisions have a durable gateway store | Waiting decision survives UI recovery; explicit Stop remains truthful; no unauthorized continuation |
| `research_delivery` | Recent `Research checkpoint service unavailable` despite earlier error-typing work | Identify actual typed rejection versus bridge failure; verify original-input/deliverable behavior |
| `skill` | Older ripgrep failures, later successful calls including after this release | Current installed skill discovery and execution, not a historical failure claim |
| `websearch` / `webfetch` | Older 403 failures; a separate tool/network reliability release exists | Current configured provider and scoped grants on the installed stack; do not undo that release based on old records |
| `read`, `glob`, `write`, `edit`, `bash`, `todowrite` | Successful records exist; some failures are permission or input errors | Valid calls, recoverable invalid input, correct scope, interruption/history fidelity |
| Revert/edit-message SDK path | Reported same-session 404 and reproduced registry failure | Recovery, confirmed idle, target ownership, response loss, no local premature truncation |

Inspect the effective installed runtime tool catalog for any additional advertised tools and test them by capability. Native computer/SSH controls that cannot work in gateway Web must remain hidden. Do not introduce a general tool-management framework or run Claude live tests.

## 5. Acceptance criteria

All implementation checks use package scripts and the small-host cgroup guard. Failed preparation must leave the deployed bundle untouched. Use real supported non-Claude models for live acceptance, and a pinned installed runtime/image when a runtime patch is required.

1. Each of the five welcome starters and ordinary typed text works at desktop and phone widths. No starter-specific transport is introduced.
2. Refresh during first-send acceptance, streaming, native question wait, permission wait, and research-checkpoint wait does not manufacture completion, trigger Stop, or lose an accepted answer.
3. Switching from session A to B preserves A's running/waiting state and never routes an answer, Stop, error, or revert into B.
4. A silent background run is recovered after cold reload. Status unavailable is shown as unknown; it does not mean idle. Test delayed status discovery and mobile timer suspension, not only immediate mocks.
5. A generation change with a still-existing owned session reproduces the current registry 404 before the fix and becomes usable after verified recovery. Old-generation requests and foreign sessions remain rejected.
6. A real worker restart invalidates transient native requests, preserves durable history/decisions/draft answers, and does not automatically resume or replay work.
7. A failed question/permission submission keeps the input; an expired request has an explicit state. Duplicate clicks, late snapshots, and lost acknowledgements cannot fabricate acceptance or grants.
8. Revert succeeds after safe ownership recovery and confirmed idle; failure preserves the transcript. A failed Stop, genuine missing target, or changed account does not cause blind retries.
9. Long-lived healthy SSE remains healthy beyond 30 seconds. Transport recovery and actual interruption remain separate.
10. Typed tool failures retain their real causes, including business/input failures in `research_delivery`. Test the advertised tool inventory and record untested capabilities as unverified.
11. For the confirmed browser-close policy A, close the last page during a run, wait beyond the old 45-second lease, reopen, and verify actual backend state without automatic resend. Explicit Stop still cancels the correct execution subtree and preserves accurate results.
12. Existing host resource limits, tenant isolation, autonomy/tool authorization, and key handling remain intact. No cumulative usage cap is introduced by this repair.

## 6. Review boundary and remaining uncertainty

Self-review checked the selected lifecycle against previous page-bound semantics, recorded the user-confirmed policy A, rejected the false SSE-timeout hypothesis, separated isolated reproductions from historical causality, retained generation isolation, and covered failed/ambiguous mutation acknowledgements.

The user confirmed browser-close policy A and subsequently approved the complete written spec; implementation planning is authorized. The exact 400 response shape, the initiating cancellation for the affected conversation, the specific 502 boundary, and the recent delivery bridge error remain tracing requirements. Only the implementation plan is authorized at this stage; implementation and publication remain pending. No product code was changed during this investigation.


## 7. Implementation evidence (October 8, 2026, Asia/Shanghai)

Implementation branch: `fix/web-session-continuity`; worktree: `.worktrees/web-session-continuity`. The implementation baseline was rechecked against release `2026-10-07T19-01-38-837Z-4b8c2d9c` and hash-verified before edits. It retains the deployed model/composer defaults and existing tool/network/attachment work. Native acceptance uses the installed OpenCode 1.18.32 binary selected from image `sha256:f667376723842db091649e5d72579dd62d7e0449b78e82c4f72201871cdafcdb`, with disposable workspaces and a local synthetic model; this is not external provider acceptance. No runtime image or native binary patch is required.

Implemented behavior:

- A validated asynchronous first prompt finishes upstream delivery even if the browser closes before acknowledgement; the existing 30-second request deadline remains enforced. A real gateway HTTP regression fails before the fix (upstream socket closed) and passes after it (one delivery, connection retained until acknowledgement). Completion diagnostics correlate accepted delivery with the disconnected receiver without recording prompt text.
- Browser leases now describe presence; release/expiry no longer cancels accepted collaboration or legacy research work. Explicit Stop and research decisions remain cancellation boundaries, and a durable pending decision prevents idle worker eviction.
- Managed session mutations and research bridge operations recover authority from the authenticated current worker, including root sessions after registry/generation changes. Recovery is bounded and checks account, generation, workspace and ancestry. Native not-found and transport failures retain distinct statuses.
- Question and permission replies retain controls until confirmed. Account-scoped question drafts survive refresh; genuinely expired requests remain visibly expired. Unknown submissions require read-only reconciliation and never automatically resubmit or grant permission.
- Current-generation gateway receipts coalesce identical question/permission reply retransmissions. A raw socket disconnect reproduced successful upstream delivery despite a lost browser acknowledgement; tests prove it does not cause a second native mutation. Chromium fault injection also reproduced lower-level POST retransmission. Neither reproduction identifies the user's historical 502 boundary.
- Stop waits for authoritative idle. Revert captures the owning session/client, verifies the native marker and reloads authoritative visible history. The gateway applies the native revert marker to message history so refresh does not restore reverted messages.
- The 320 px research controls previously overlapped the model picker. Web toolbar groups now wrap without shrinking the research trigger under another control; the real 1280/390/320 px browser scenario passes in English and Chinese. Desktop keeps its single-row behavior.
- Structured operation/cancellation diagnostics record safe IDs, context, status and correlation without answers, credentials or arbitrary upstream bodies. The verified healthy SSE timeout-clearing behavior is preserved.

The current installed binary advertised these built-in tools to the local fixture model: `bash`, `edit`, `glob`, `grep`, `question`, `read`, `skill`, `task`, `todowrite`, `webfetch`, `write`. This is the native acceptance fixture's catalog, not a claim that its provider configuration duplicates the complete managed account profile. With the managed collaboration plugin loaded, current-image native acceptance also advertised `research_checkpoint` and `research_delivery` (13 tools total). All four research modes passed on that same current binary and produced a verified actual artifact; `bash`/`write` were exercised as appropriate. Configured `websearch` is covered by managed profile/network tests and the retained deployed network release. The installed immutable image has no desktop custom-tools directory; desktop `computer`/`ssh_connect` controls remain outside Web acceptance. Added MCP/provider tools require their own capability acceptance and are not implicitly validated by this catalog.

| Tool/path | Verified in this repair | Remaining limit |
| --- | --- | --- |
| `question` | Current installed binary: fresh event reader recovers the pending request; reply produces exact tool/answer history; stale reply is typed 404; the same durable history remains revertible. SDK regression also preserves typed 400. Browser verifies drafts, switch/refresh, held acknowledgement, expiry, duplicate-click blocking and lost-ack readback. | Local synthetic model; real external provider acceptance follows publication approval. Old discarded runtime request IDs cannot be revived. |
| Permission replies | Gateway coalescing, current-context recovery, rejection, generation/account changes, unknown outcome and no automatic grant; browser confirms controls remain until acknowledgement. Current installed `webfetch` uses actual manual permission recovery and denial. | Other permission-gated tools are not each newly exercised through an external provider. |
| `research_checkpoint` | Durable waiting/barriers, page-presence independence, explicit Stop and root-session authority recovery; native four-mode checkpoint/write acceptance plus staged wide/phone checkpoint browser coverage. | All four native research modes now explicitly use the current-image binary in required preparation. External-provider checkpoint acceptance remains a post-publication gate. |
| `research_delivery` | Successful real artifact/hash validation, missing input, exhausted repairs, paused execution, current bridge/root authority and typed business error versus service failure. | Gateway/plugin deterministic tests; no fresh external-provider delivery in this repair. |
| `bash`, `write` | Current-image native research fixtures write actual artifacts only after required decisions; scope, scoped network revocation and Stop covered by deterministic tests. | Arbitrary scientific workloads and fresh external-model bash/write acceptance are outside this pre-publication check. |
| `webfetch`, configured `websearch` | Current native fetch approval remains recoverable with an omitted timeout, and explicit denial settles before outbound access. Full suite covers broker/provider selection, scoped grants, redirects, denial and typed outcomes. Previously deployed network fixes/image are retained. | No new real website/search success from an external model in this pre-publication phase. |
| `skill` | Advertised by current native fixture; installed skill inventory/image integrity and owned discovery tested. | Fresh native skill invocation through a real model is unverified. |
| `read`, `glob`, `grep`, `edit`, `task`, `todowrite` | Advertised by current native fixture; shared gateway authority, history/SDK normalization and relevant existing deterministic tests pass in the full suite. | No fresh native successful invocation of each capability; do not report these as individually live-validated. |
| Revert/edit-message | Current native revert marker, gateway generation recovery, confirmed idle/Stop, exact lost-ack evidence, preserved history on failure, and refresh respecting the native marker. | An actually missing native session still returns a real 404; recovery does not manufacture a session or automatically resend edits. |


Final candidate: `2026-10-07T21-32-04-409Z-81c03ee0`, source commit `e3cde067095472111c0748da3c1c2cfcad34d61c`, source fingerprint `12a6d2d2398ad1ef6436951ed9feded8de5a4625d5d323c63699dd9c7bef6914`. Preparation exited successfully and revalidated frozen source, installed dependencies, image identity and staged artifacts. Lint/typecheck/build passed; workflow tests: 42 passed, no skips; frontend: 1,906 passed, 28 opt-in skips; platform: 392 passed, 5 opt-in skips; required browser: 8 passed, zero failed or pending/skipped. Browser scenarios exercised 1280, 390, 360 and 320 px, including English/Chinese research decisions, all five starters plus typed input, refresh before first acknowledgement, expired/unknown question results, permissions, last-page absence beyond 45 seconds, Stop and reverted-history refresh. Native question/fetch and all four native research modes ran rather than skipped.

Production remains release `2026-10-07T19-01-38-837Z-4b8c2d9c`; platform service is active. The retained predecessor is `2026-10-07T15-01-18-055Z-76b5c71c`. No production source/bundle switch, external model probe, Claude probe, migration, remote push or merge was performed. Branch and worktree are retained for review/publication. Historical triggering requests remain untraced; publication must run required live acceptance and preserve the verified rollback release if that acceptance fails.


## Provider tool-call identifier follow-up (2026-10-08, Asia/Shanghai)

The user's second-starter conversation reproduced `questionList` HTTP 400 with `invalid identifier` under generation 157. Read-only native pending-request inspection and persisted tool metadata confirmed `functions.question:0`; the assistant model was `opencode/fledge-alpha-free`. `TenantPolicy.registerRequest` incorrectly ran this provider-owned correlation value through the route/session identifier validator. The colon and period caused the entire list to fail, and the shared permission-list/event/reply registration path has the same defect. A synthetic call registration using this exact value reproduced HTTP 400 before the change and succeeds after it.

Repair scope: distinguish tool correlation metadata from ownership identifiers. Preserve the exact nonempty call value with a 512-character ceiling and no ASCII control characters; continue strict account/session/request IDs, current-generation binding and authoritative session checks. Add gateway list/reply/generation and permission-rejection regressions plus namespaced question/permission browser fixtures. Use Fledge Alpha Free for installed question acceptance, rather than assuming another provider's identifier shape covers this model. Existing runtime question IDs cannot be revived after maintenance/restart.

Further audit identified separate strict call/correlation validators in `model-broker.mjs`, `tool-outcomes.mjs`, SDK `tool-outcome.mjs` and its immutable runner/runtime copies. They may reject namespaced calls for network or research delivery; question-list repair does not validate or fix those independent tool bridges. Broader changes require matching runtime/image acceptance and must not be advertised as complete based on the question test. No user data, inputs or credentials were printed during this diagnosis. Final publication evidence follows after required checks.


Published follow-up `2026-10-08T08-22-59-264Z-9c21cfda` from `e6e0329`, based on the exact hash-verified current Full-autonomy release `2026-10-08T07-07-38-773Z-2518211a` (retained as rollback). Lint/typecheck/build, 1,908 frontend tests (28 opt-in skips), 397 platform tests (6 opt-in skips), and seven required browser checks (zero skips) passed; the installed image is unchanged. Log: `/tmp/scikeel-question-id-prepare-v2.log`.

Installed `SCIKEEL_CONTINUITY_MODEL=fledge-alpha-free pnpm web:recovery:live` passed both tests with zero failures/skips (`/tmp/scikeel-question-id-fledge-live.log`). Both 1280 and 360 px native questions actually used `functions.question:0`: loading, refresh/navigation draft recovery, one exact answer receipt, native revert and hidden history after reload passed with zero HTTP 400/502 or page errors. Phone acceptance included 46-second last-page absence. Evidence sessions are `ses_ee557b5d9ffeljr504i5seFByM` and `ses_ee55761f4ffegs6e5xIf0mLfnm`; only the disposable acceptance account was disabled after cleanup. Five warm reloads and confirmed Stop also passed. This is current Fledge/provider native-question acceptance, not a claim that the unmodified second-starter full scientific workflow or all other tool bridges were individually accepted. The additional correlation-validator risks above remain separate unresolved work.
