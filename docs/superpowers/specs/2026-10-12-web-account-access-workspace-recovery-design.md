# Web Account Access and Workspace Recovery Design

Date: 2026-10-12
Status: Written spec approved by the user on 2026-10-12 by requesting implementation planning. Implementation and deployment still require subsequent authorization.
Scope: SciKeel public multi-user gateway Web, including phone-width viewports.

## 1. Problem and Intended Outcome

The user reports persistent connection failure, including `Could not load /v1/whoami (HTTP 502)`, and no usable way to sign out. The user approved researching and specifying independent account access plus controlled workspace recovery, while retaining simultaneous logins.

A valid login must remain usable for account access and logout even when its workspace or agent runtime cannot respond. Recovery must distinguish an unavailable browser connection from an unhealthy server instance, preserve research data, and prevent multiple pages from repeatedly restarting the same account's workspace.

This extends the October 6 Web runtime recovery design. Keep its validated workspace identity, read-only enforcement, single browser recovery owner, catalog independence, cancellation, and 90-second connection budget. That design restores browser connections; this design additionally addresses account access during failure and server instance liveness. It does not replace the existing recovery owner.

## 2. Evidence and Uncertainty

The inspected deployment is `.deploy/web-releases/2026-10-11T19-55-20-683Z-4dcfb43d/source`. The main checkout contains substantial unrelated changes and differs from that source, including its managed sandbox modules. Planning and execution must re-identify the effective service source, bundle, and sandbox image before selecting an implementation baseline.

| Boundary | Observed evidence | Consequence |
| --- | --- | --- |
| Browser account loading | Deployed `apps/desktop/src/lib/runtime.ts` requests `/api/me` concurrently, but attaches account publication after workspace validation and SDK construction. A failed `/v1/whoami` returns before that publication. | A successful account read can still leave the UI without an account identity. |
| Account menu | `GatewayAccountMenu.tsx` returns no menu when `user` is null. | First-connection failure can hide logout entirely. |
| Platform account routes | `/api/me` and `POST /auth/logout` operate on the authentication store before workspace startup. | Account access already has an appropriate independent server boundary. |
| Authentication | `AuthStore.createSession` adds an independent session; `revokeSession` removes the supplied session only. | New logins do not intentionally evict previous device sessions. Tabs sharing cookies share the same login. |
| Workspace reuse | Deployed `ManagedWorkerManager.ensureWorker` returns a record marked `running` without a reuse-time liveness check. Its startup health check does not establish future availability. | Repeated requests can keep reusing a nonresponsive instance. |
| Existing concurrency | Same-account startup is coalesced. Managed workers use launcher generations and account-scoped leases. Collaboration operations already have locking and revision checks. | Extend existing ownership mechanisms rather than invent another workspace manager or collaboration lock. |
| Incident | On October 12, runtime reads timed out and catalog operations returned 503. The active test1 sandbox had `memory.high=640 MiB`, `memory.max=1 GiB`, more than 550,000 high-limit events, and approximately 90% memory pressure stall averages, with no recorded cgroup OOM kill. | Severe reclaim stalls are evidence of resource pressure, not proof of an exited process. |
| Operational recovery | The platform was restarted at 15:54:19 Asia/Shanghai. The stalled sandbox stopped, memory pressure dropped, and platform health/logout returned 200. Browser reconnection was not verified. | Restart relieved the observed condition; it does not establish a permanent fix or successful research-task continuation. |

The source of memory growth, whether simultaneous pages contributed materially, and the exact request producing the user's 502 are not established. Do not report a memory leak, a multi-login defect, or an OpenCode crash as proven. Diagnostics must identify the unhealthy layer without exposing credentials or research content.

## 3. Decision and Scope

Three approaches were considered:

1. Fix logout alone: a small improvement, but persistent workspace failure remains unresolved.
2. Independent account access plus controlled instance recovery: selected by the user; covers both failure paths without banning simultaneous logins.
3. Single-device login enforcement: rejected; it removes legitimate phone/computer use and has no demonstrated connection to this incident's cause.

Deliver in two increments under this spec: independent account/logout behavior first, then server liveness classification and controlled recovery. Both require the acceptance checks below; publishing only the first increment must be described as a partial fix.

Non-goals: desktop UX changes, device/session-management screens, per-device workspaces, independent per-device assistants, new collaboration semantics, automatic replay of research execution, a monitoring dashboard, or unrelated model-catalog redesign. Resource diagnosis is required, but a general runtime memory optimization project is not implied.

## 4. Account Access and Logout

### R1. Independent Account Loading

Load and publish `/api/me` independently of workspace, catalog, session-list, and event-stream success. Reuse the existing account state and platform route. Account requests retain their own bounded timeout and cancellation; workspace retry must not continually cancel a still-current account lookup.

Scope account results to the current browser authentication lifecycle. Late results from a superseded login or completed logout must not restore an old identity, permissions, or controls. A workspace generation change alone must not erase a verified identity for the same authenticated account.

Never persist authentication secrets or use a cached username/role as authority. Unknown identity keeps privileged account/settings controls hidden, but must not remove the logout action. Logout does not require inventing a fallback user or admin role.

### R2. An Accessible Logout Path

Show a working Sign out command while connecting, offline, failed, recovering, and ready, even if `/api/me` has not succeeded. Reuse the account menu where identity is known; provide a minimal fallback action where it is not. The login-preparation/error surface must also expose logout after authentication succeeds, so an overlay cannot make the fallback unreachable.

Use the existing same-origin `POST /auth/logout` behavior. Logout revokes only the browser session presented by that request. Other independent device sessions stay valid; tabs sharing that cookie become unauthenticated on their next request. Signing out does not stop the shared workspace or cancel server-side research.

On logout submission, suspend new browser recovery and invalidate pending account/runtime publications for that authentication lifecycle. After confirmed logout, cancel remaining browser requests, close browser event streams, clear browser account/workspace/session presentation state and account-scoped transient drafts according to existing logout policy, and navigate to login. Do not delete workspace files, conversations, saved model defaults, or other devices' state. Do not introduce blanket local-storage clearing.

If logout cannot reach the platform, retain an actionable error and retry; do not claim that server-side revocation succeeded or automatically resume the suspended connection loop. An explicit platform authentication-expiry response performs the existing single login transition and cancels runtime retries. A bare 502, model-provider authentication error, or metadata timeout does not imply login expiry.

## 5. Liveness and Failure Classification

### R3. Separate Availability Signals

Keep authentication status separate from workspace and runtime status. A process record marked `running`, a platform `/health` response, a successful `/v1/whoami`, and an open event stream are different signals; none alone proves the application is fully usable.

Use the existing manager, launcher inspection, and scoped runtime reads to classify failures. Probe only the authenticated account's instance, and retain its workspace scope and generation. Never accept a client-supplied upstream address, credential, filesystem root, or another account ID.

Return sanitized structured failures with a stable code, failed stage, retryability, current instance/generation when known, and allowed recovery action. Required distinctions are: authentication expired, workspace stopped, workspace unreachable, runtime unresponsive, host capacity unavailable, recovery in progress, and stale recovery context. Raw upstream messages are diagnostic details, not the sole user-facing instruction.

For managed CLI assistants, include their existing job/execution probe in activity decisions. Do not probe Claude live unless the user confirms restoration. Preserve deterministic adapter compatibility.

### R4. Bounded, Shared Liveness Checks

Perform checks when reusing an instance without a recent successful liveness result, or when transport failures invalidate that result. Share in-flight probes per account/instance/generation and cache successful checks for at most five seconds during use. Do not create a frequent platform-wide polling loop or start inactive accounts solely to check them.

A liveness cycle has a ten-second total budget, including launcher inspection, runtime read, and body decoding. Clamp individual deadlines to its remaining budget; the server-side recovery owner, not each joining browser request, owns the shared cycle. Losing one browser request must not cancel recovery awaited by other pages.

One transport timeout only marks availability uncertain. Before declaring an alive instance unresponsive, require two failed scoped liveness cycles separated by at least one second. Successful recovery of the same instance clears the failure streak. A catalog-only failure or failed external model call is not evidence that the workspace needs restarting.

Cold startup remains under existing bounded startup/admission limits. The browser's existing 90-second recovery deadline covers probes, startup, metadata, SDK connection, and retries; do not stack another full browser timeout onto each stage. When that deadline expires, display the actual failed stage and usable actions.

## 6. Controlled Recovery

### R5. Recovery Policy

| Verified condition | Permitted behavior |
| --- | --- |
| Healthy workspace, browser stream lost | Reconnect the browser; no stop/restart/abort. |
| Required catalog read fails but runtime responds | Retry catalog reads independently; no instance restart. |
| Launcher verifies instance stopped/exited and cleanup is complete | Automatically perform one bounded reconstruction through existing admission/startup mechanisms. |
| Launcher still reports alive; runtime fails repeated liveness checks | Expose a confirmed Restart workspace action; do not automatically terminate the instance. |
| Task is running, maintenance is active, native execution is running, or task state cannot be established | Do not automatically restart. Explicit confirmation must warn that research may be interrupted; maintenance must finish or be safely reconciled before reset. |
| Host capacity unavailable | Explain temporary resource unavailability and permit a bounded retry; no limit increases or restart loop. |
| Cleanup or launcher identity cannot be verified | Fail closed and expose retry/error; no competing replacement or host fallback. |

Confirmed reconstruction does not mean interrupted work succeeded. Preserve files and history, reconcile research/execution records through their existing transitions, and report interrupted or unknown work truthfully. Do not automatically continue a research task merely because a replacement instance becomes ready.

### R6. One Recovery Owner Per Shared Instance

Keep browser request coalescing in the existing recovery owner. Add server-side recovery ownership to the existing managed worker lifecycle, keyed by authenticated account and instance generation, so different tabs/devices join one probe/start/restart outcome.

An explicit browser recovery command must use the authenticated same-origin platform boundary. A restart additionally requires explicit confirmation and the last observed instance/generation. If the browser does not know that context, it must first obtain a verified status; it cannot request an unscoped restart. Automatic reconstruction of a verified stopped instance uses server-authoritative launcher context. Revalidate context after asynchronous checks and immediately before acting. A queued request or old confirmation targeting a replaced generation returns a stale-context result and must not restart the new generation.

Allow at most one replacement attempt per recovery window and enforce a 60-second server-side replacement cooldown shared across tabs/devices. Read-only probes and reconnection to a healthy generation remain allowed during the cooldown. Failed replacement must not automatically reset its own cooldown. A platform process restart must reconcile launcher state before starting anything; process-local caches cannot prove that the old instance is gone.

Serialize termination and startup with existing admission, leases, generation invalidation, and credential revocation. During a confirmed restart, fence new workspace mutations, finish or classify outstanding operations, revoke the old generation's authority, and verify cleanup before replacement. Never start two active generations for one account.

### R7. No Blind Mutation Replay

Automatic retry is limited to safe reads, liveness checks, and browser connection establishment. Do not automatically resend a prompt, command, deletion, approval reply, or task start with an unknown outcome because its transport failed.

Reuse existing message IDs, attachment receipts, interaction receipts, collaboration revisions, and durable history to reconcile what was accepted. Existing explicitly idempotent receipt replay can remain; do not extend it into generic mutation retries. Unknown delivery stays visible until reconciled or explicitly resubmitted by the user.

When the winning generation is available, each page reacquires authoritative context, stream, history, and valid model selection through the SDK. Discard old generation callbacks and pending dialogs. Preserve unsent text/attachments within the current account and conversation; never silently submit them after reconnecting.

## 7. Simultaneous Login Contract

Multiple authenticated devices remain supported. Additional logins do not create separate account workspaces or evict other device sessions. Reading history from two devices must not restart the workspace or stop a turn.

Workspace files, conversations, account-selected assistant, and account-level defaults remain shared. Existing per-conversation draft model choices stay per-conversation where already supported; do not turn all local choices into global settings. Refresh authoritative shared settings on the existing events/focus/catalog path without overwriting a different conversation's draft.

Retain existing collaboration locking, revision conflict checks, and runtime-busy checks. Stale/conflicting operations must surface their existing conflict outcome rather than being retried as a new command. This work does not introduce a device-wide control lock or promise collaborative file editing/merge safety.

Different conversations can still compete for the same runtime/resource budget. Keep existing scheduling and admission limits. Multi-login support is not a promise of unlimited simultaneous research tasks.

## 8. User Experience and Safety

Use the existing failure surface and restrained controls: Retry connection, Sign out, and Restart workspace only when the server allows it. Confirmation names the shared workspace and warns that all devices using it may be affected and current tasks may stop. No new dashboard, explanatory onboarding, or manual console workaround is part of the normal flow.

Show a finite connecting/recovering state, then actionable failure when the deadline expires. Disable duplicate restart submissions while a shared recovery is active. Never show ready solely from remembered state or treat a successful account read as runtime readiness.

Project files and new source copy remain English, with translations and parity checks for supported locales. Verify English and Chinese at desktop and 390/320-pixel widths, keyboard access, and reachable logout/confirmation without overflow or hidden overlays.

Recovery preserves current workspace containment, read-only mode, approval rules, model authority, tenant isolation, credentials, and stable artifact/workflow schemas. It must not widen permissions or reset read-only restrictions on failed metadata reads.

Retain the host's build guards and managed runtime resource limits. Capture per-instance resource/operation evidence to investigate memory growth; do not increase `memory.high`, `memory.max`, swap, or host admission limits to make recovery appear successful. Logs may include stage, safe error code, elapsed time, generation, recovery outcome, and correlation ID, never secrets or prompt/file contents.

## 9. Acceptance Criteria

| Scenario | Required result |
| --- | --- |
| First connection: `/api/me` succeeds, `/v1/whoami` keeps returning 502 | Verified identity publishes; logout is reachable and works; no false runtime readiness. |
| `/api/me` is unavailable while workspace connection fails | Fallback logout remains reachable; privileged controls stay hidden. |
| Login preparation ends in connection failure | Retry/logout are reachable without a console or clearing site data. |
| Logout while a probe, catalog read, or stream-open attempt is pending | Browser work is canceled; late responses cannot restore identity or restart recovery; workspace tasks are not stopped by logout. |
| Logout response fails | No false revocation success; visible error and retry. |
| Independent second-device login and logout | First device remains authenticated; no workspace replacement caused by login/logout. |
| Two tabs sharing one browser session; one logs out | Both become unauthenticated on subsequent platform access; shared research is not canceled. |
| Healthy turn during refresh/focus on two pages | Both regain history/stream; no stop/restart/abort and no duplicate prompt. |
| Concurrent requests encounter a stopped instance | One verified cleanup/start sequence, one replacement generation; joining pages share the result. |
| Alive instance misses one health cycle, then responds | Connection recovers without terminating the instance. |
| Alive instance misses repeated cycles; task status is unknown | Actionable failure and explicit interruption confirmation; no automatic restart. |
| Two devices confirm restart against the same old generation | One replacement; stale/late confirmation never restarts the winner. |
| Restart fails, repeated clicks, or new tabs retry | Shared cooldown and replacement limit hold; no restart storm or parallel generation. |
| Mutation delivered but response lost | Reconcile receipt/history; no blind resend or duplicate execution. |
| Superseded login returns account metadata, or old generation returns runtime/stream results | Authentication lifecycle and generation fences prevent stale state publication without erasing the still-valid account identity. |
| Catalog outage or external model-provider failure | Correct failure stage; healthy workspace remains running. |
| Host capacity rejection, maintenance, or cleanup failure | Bounded, truthful error; no limit increases, competing instance, host fallback, or file loss. |
| Confirmed reconstruction after interrupted research | Original files, conversation history, and defaults survive; interrupted/unknown task status is not reported as completed. |
| Read-only user and cross-account/cross-origin recovery requests | Write restrictions preserved; unauthorized recovery denied without probing another account. |
| Shared assistant/settings change and stale collaboration operation | Existing sharing and conflict behavior retained; no new device eviction or silent operation replay. |
| Desktop Web and phone-width English/Chinese failure states | Logout, retry, and restart confirmation accessible; no horizontal overflow or inaccessible overlay. |

Use deterministic service/store/SDK tests for failure classification, concurrent recovery, logout races, and stale generations; browser acceptance must exercise the exact staged bundle, including cold failure and two-page scenarios. Live acceptance uses available non-Claude runtimes only. All builds, typechecks, lint, and tests run through guarded package scripts, with no parallel heavy jobs on this host.

## 10. Review and Publication Boundary

Spec self-review completed on October 12: checked evidence versus hypotheses, logout lifecycle races, simultaneous recovery ownership, generation fencing, cooldown, interrupted work, unknown mutation outcomes, authorization, scope, and numeric deadlines. Clarified logout-submission suspension and the distinction between explicitly scoped browser restart commands and server-authoritative reconstruction. No unresolved placeholders remain.

Implementation planning must start from the effective deployed baseline and preserve unrelated checkout changes. Publication uses the existing frozen-source verification/release workflow; a failed bounded build leaves the deployed bundle untouched, and rollback preserves user data and credentials.

This is a design artifact, not a claim that the proposed behavior has been implemented, tested, or deployed. The user approved this written spec on October 12 by requesting a plan. Implementation and deployment require subsequent authorization.
