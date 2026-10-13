# Web Account Access and Workspace Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not spawn subagents unless the user separately authorizes delegation; subagent-driven-development is an alternative only after that authorization.

**Goal:** Keep account access and logout usable during Web connection failures, and recover unhealthy shared workspaces without restart storms, data loss, or repeated research execution.

**Architecture:** Publish account identity on an authentication lifecycle independent of the existing browser connection owner. Extend the existing managed worker manager with shared bounded liveness and generation-scoped replacement, reusing launcher cleanup, admission, and tenant authority. Expose authenticated recovery through a small SDK client and the existing failure surfaces; never turn reconnect into mutation replay.

**Tech Stack:** React, TypeScript, Zustand, Radix, lucide-react, Node.js ES modules, existing SDK, managed sandbox launcher, node:test, Vitest, Playwright, guarded pnpm release scripts.

---

## Authorization and Execution Rules

- Revised October 13, 2026, after the user approved the revised spec by requesting `plan`. This turn writes the plan only: no product edits, heavy tests, service restarts, or deployment. Continue implementation only on a subsequent execution request.
- Spec: `docs/superpowers/specs/2026-10-12-web-account-access-workspace-recovery-design.md`, revised and approved for planning on October 13, 2026.
- Execution history: Tasks 1-3 were implemented and internally reviewed on October 12 on `fix/web-account-workspace-recovery`. Their recorded test results are historical, not fresh verification. Tasks 4-10 and publication remain pending; do not recreate or erase the completed account/logout increment.
- Implementation has two internal checkpoints: Tasks 1-3 produce independently usable account/logout behavior; Tasks 4-9 produce controlled workspace recovery. Task 10 verifies the integrated candidate. Review checkpoints are internal checks, not repeated user-approval barriers during authorized implementation. Publishing only the first increment is a partial fix, not complete recovery. Deployment requires separate authorization after candidate verification.
- Checkboxes track actual execution: Tasks 1-3 are complete; Tasks 4-10 remain unchecked. Pending source snippets are implementation contracts/core patches, not evidence of existing functionality. Complete the named integrations and tests in each step; do not paste snippets as unrelated scaffolding.
- Use TDD for each behavior: establish the intended assertion failure, implement, run the same focused command, then commit only the named task files. Unexpected test/setup failures require systematic debugging, not a reduced assertion. Suggested commit messages appear per task; stage exact named paths with `git add -- <paths>`, inspect `git diff --cached --name-only` and `git diff --cached --check`, then commit. Do not include unrelated files or generated credentials.
- Never run Vite, Vitest, Cargo, or heavy jobs directly. Use the listed guarded package scripts sequentially. Package script commands below run from the isolated checkout root.
- Preserve all unrelated main-checkout changes. Do not push, install dependencies without approval, change runtime limits, probe Claude live, or make native desktop UX a deliverable.

## Remaining Delivery Order

| Sequence | Tasks | Result required before moving on |
| --- | --- | --- |
| Recheck baseline and incident evidence | Task 4, preparation | Identify the failing layer when reproducible; otherwise record an unknown root cause without guessing. |
| Bounded, shared availability classification | Task 4 | On-demand ten-second checks, five-second successful-result cache, two separated failures, cancellation, durable cooldown. |
| Single authoritative server recovery | Tasks 5-6 | One admitted replacement, verified cleanup, generation fences, tenant checks, truthful interrupted-task records. |
| Browser/SDK integration | Task 7 | Reuse the existing 90-second recovery owner; preserve drafts and never replay uncertain mutations. |
| Actionable failure surfaces | Task 8 | Retry/signout remain usable; eligible restart requires an observed-generation interruption confirmation, including cold login failure. |
| Exact-candidate acceptance | Tasks 9-10 | Two-device/two-tab checks, English/Chinese 1280/390/320 layouts, release registration, guarded full verification and bounded resource diagnosis. |

No polling service, device eviction, blanket local-storage deletion, generic write retries, sandbox-image change, or runtime/host-limit increase is included. This repairs missing availability/recovery behavior; it does not claim to fix the unknown source of resource growth.

## Baseline and File Ownership

The isolated checkout is `/opt/open-science-desktop/.worktrees/web-account-workspace-recovery`. Its baseline `c8b15a7` matches published Web release `2026-10-12T12-09-53-262Z-99537e6d`; account/logout commits are `82f227f` and `746124d`. The last inspected platform service source was `.deploy/web-releases/2026-10-11T19-55-20-683Z-4dcfb43d/source`, whose platform source matched at baseline inspection. Re-inspect effective source, Web bundle, and image before implementation; none of these historical paths is automatically the current publication target. If production has advanced, carry forward only verified later changes in the isolated checkout without overwriting the account/logout increment or unrelated main-worktree changes. Do not repeat the initial baseline overlay blindly.

| File | Responsibility |
| --- | --- |
| `apps/desktop/src/lib/gatewayAccount.ts` (existing, Task 2 complete) | Browser account-request lifecycle, logout suspension, and stale authentication-result fences; no runtime startup. |
| `apps/desktop/src/lib/runtime.ts` | Publish verified account metadata independently; browser-only teardown; integrate structured recovery through the existing connection owner. |
| `apps/desktop/src/lib/webMode.ts`, `apps/desktop/src/main.tsx` | Bind authentication-expiry/logout lifecycle before bootstrap without changing standalone token behavior. |
| `apps/desktop/src/components/sidebar/GatewaySignOut.tsx` (existing, Task 3 complete), `GatewayAccountMenu.tsx` | Shared accessible logout command and unknown-identity fallback. |
| `apps/desktop/src/lib/loginPreparation.ts`, `services/platform/src/login-page.mjs` | Reachable overlay logout and structured-failure handoff to the existing React recovery surface. |
| `services/platform/src/workspace-recovery.mjs` (new) | Sanitized recovery outcomes, bounded/coalesced probes, and durable replacement-window metadata; no independent workspace process manager. |
| `services/platform/src/sandbox-client.mjs` | Optional cancellation/deadline for inspection, including closing the launcher socket. |
| `services/platform/src/managed-worker-manager.mjs` | Authoritative lifecycle ownership, admission, generation fences, cleanup, mutation gating, and replacement. |
| `services/platform/src/sandbox-control-plane.mjs`, `platform-server.mjs` | Wire probes and interruption reconciliation; authenticate/validate recovery routes before ordinary worker startup. |
| `services/platform/src/research-tasks.mjs`, `collaboration.mjs`, `cli-runtime.mjs`, `sandbox-native-jobs.mjs` | Narrow existing interrupted-execution transitions and generation-scoped native cleanup; do not add a new research schema or execution engine. |
| `packages/sdk/src/GatewayWorkspaceClient.ts` (new), `index.ts`, `OpenCodeClient.ts` | Typed same-origin recovery transport and optional expected-generation header for platform writes. |
| `apps/desktop/src/components/session/WorkspaceRecoveryActions.tsx` (new), `SessionView.tsx` | Existing failure-surface actions and explicit shared-workspace restart confirmation. |
| `apps/desktop/src/i18n/locales/{en,zh-Hans,de,es,fr,ja,ko}/session.json` | Recovery/logout failure strings with locale parity; modify all seven concrete paths, not a generated eighth locale. |
| `apps/desktop/src/test/webAccountRecovery.acceptance.test.mjs` (existing, extend) | Exact staged-bundle cold failure, logout, two-page/device behavior, and viewport acceptance. |
| `scripts/dev/web-release.mjs`, `web-release-policy.mjs`, `web-release.test.mjs` | Mandatory new browser scenario registration; no weakened verification selection. |

Tests live beside frontend helpers/components, in `services/platform/test/` for service modules, and under `apps/desktop/src/test/` for SDK/node/browser tests. Exact paths are listed per task. New modules are limited to genuine ownership boundaries above; do not split unrelated code.

## Shared Contracts

### Availability Response and Commands

Add this type contract to `packages/sdk/src/GatewayWorkspaceClient.ts`; mirror its enum validation in `workspace-recovery.mjs`. Only validated, sanitized fields are sent to the browser.

```ts
export type WorkspaceContext = { instanceId: string; generation: number };
export type WorkspaceState =
  | "healthy" | "stopped" | "starting" | "recovering"
  | "unreachable" | "unresponsive" | "unknown" | "capacity";
export type WorkspaceReport = {
  context: WorkspaceContext | null;
  state: WorkspaceState;
  activity: "idle" | "running" | "maintenance" | "unknown";
  canRestart: boolean;
  retryAfterMs: number;
};
export type WorkspaceRecoveryCommand =
  | { action: "retry" }
  | { action: "restart"; instanceId: string; generation: number; confirmed: true };
export type WorkspaceFailureCode =
  | "workspace_stopped" | "workspace_unreachable" | "runtime_unresponsive"
  | "workspace_status_unknown" | "workspace_capacity_unavailable"
  | "workspace_recovery_in_progress" | "workspace_recovery_cooldown"
  | "workspace_recovery_required" | "stale_workspace_context"
  | "workspace_cleanup_unverified";
export type WorkspaceFailure = {
  error: string;
  code: WorkspaceFailureCode;
  stage: "workspace" | "runtime" | "capacity" | "recovery";
  retryable: boolean;
  context: WorkspaceContext | null;
  action: "retry" | "confirm_restart" | "wait" | "none";
  retryAfterMs: number;
};
```

- `GET /api/workspace/status`: authenticate, inspect/probe only the caller's account; never start a stopped workspace to answer status. Return `WorkspaceReport`, or a sanitized `WorkspaceFailure` when inspection itself cannot finish.
- `POST /api/workspace/recover`: same-origin authenticated JSON; exact command keys only. `retry` may reconstruct a verified stopped instance; `restart` requires current context plus explicit confirmation and is rejected for a healthy instance or active maintenance.
- `401` authentication-expiry responses retain `x-scikeel-auth: session-required`. Recovery never fabricates authentication success.
- Invalid body: 400; foreign origin/account: 403; stale context/healthy restart/maintenance: 409; temporarily unavailable/recovering/cooldown: 503 with bounded `Retry-After` when known. No payload contains URL, token, path, prompt, or resource content.
- Limits: 5-second healthy-result TTL; 10-second complete liveness cycle; two failures separated by at least 1 second before declaring an alive instance unresponsive; 60-second durable replacement cooldown; one replacement per browser recovery window; existing 90-second browser budget and existing startup/resource limits remain.

### Manager Entry Points

Extend the existing manager rather than creating a second lifecycle owner:

```js
// Optional fields are injected at construction for deterministic tests.
// Existing account identity fields remain required and owner-checked.
ensureWorker({ instanceId, userId, allowRecovery = true })
workspaceStatus({ instanceId, userId })
recoverWorker({ instanceId, userId, action, generation, confirmed })
noteTransportFailure({ instanceId, generation })
setRecoveryHooks({ beforeCleanup, afterCleanup })
stopWorker(instanceId, { expectedGeneration } = {})
```

`allowRecovery=false` is mandatory for an ordinary mutating request. It may verify an existing healthy instance, but cannot reconstruct and then silently dispatch that request into a replacement generation. A genuinely new user command can be resubmitted after the browser establishes fresh context; unknown prior delivery is reconciled, not replayed. Internal mutation paths must use the same gate, not rely on the default `true`.

## Task 1: Establish a Reproducible Isolated Baseline

**Status:** Complete. Effective Web source was updated to release `2026-10-12T12-09-53-262Z-99537e6d`; its platform sources matched the prior service source at inspection. All 1,080 source hashes matched after overlay. Baseline commit `c8b15a7`, 13 platform and 297 frontend checks passed. Existing whitespace in deployed OpenCode patch data was preserved verbatim; it was not introduced or reformatted by this feature. Account regression failed as intended and was committed in `0836307`.

**Files:** Read effective release `manifest.json`, `scripts/dev/web-release-source.mjs`, `package.json`, and package guards; carry only this plan and its spec into the candidate. No production source edits.

- [x] **1. Inspect the effective source and active release.** Run:

```bash
pnpm web:release inspect --source /opt/open-science-desktop
systemctl show osd-platform.service -p WorkingDirectory -p MainPID
git status --short
```

Record source/bundle/image fingerprints and dependency references, never raw environment or cookies. A managed-source incompatibility from inspecting the main checkout is an expected baseline finding, not permission to deploy it. Identify the effective frozen source through `inspectProduction()` and the published pointer/manifest.

- [x] **2. Invoke `using-git-worktrees` and create an isolated linked checkout.** Use `/opt/open-science-desktop/.worktrees/web-account-workspace-recovery`, created from current HEAD, then verify its git common directory equals the main repository's. Overlay the source allowlist from `inventorySource(production.source, {git:false})` with `freezeSource()` and the dependency identity validated from that release manifest's `source.dependencies.references`. Remove only baseline source files absent from the deployed inventory in this new checkout; do not remove `.git`, main files, live files, credentials, or data. Preserve execution-session AGENTS rules even if the frozen source contains older guidance. Compare every source hash, commit the verified baseline locally, and set `task_checkout` to that absolute path. No new git repository, remote, dependency install, or push.

- [x] **3. Verify the package test arguments and fixture boundaries.** Confirm `pnpm test <frontend paths>` is guarded, and use the platform package directly for its node:test paths:

```bash
pnpm --filter @ai4s/platform test test/auth-store.test.mjs test/managed-worker-manager.test.mjs
pnpm test src/lib/runtime.store.test.ts src/components/sidebar/GatewayAccountMenu.test.tsx
```

Expected: baseline deterministic suites pass under a shared cgroup/lock, with managed fixtures using temporary directories. If the host is busy, wait or use authorized project maintenance; never bypass admission. Save exit codes and counts. Live acceptance and opt-in browser suites are not claimed by these commands.

- [x] **4. Add the cold-failure store reproduction to `apps/desktop/src/lib/runtime.store.test.ts`.** Use the existing Web fixture and mocked SDK setup. Return an immediate valid `/api/me` user and repeated `/v1/whoami` 502, then assert account publication before runtime success:

```ts
const user = { id: "usr_fixture", username: "fixture", role: "user" as const };
vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
  const path = new URL(String(input), "http://gateway.test").pathname;
  return new Response(JSON.stringify(path === "/api/me" ? { user } : { error: "worker unavailable" }),
    { status: path === "/api/me" ? 200 : 502, headers: { "content-type": "application/json" } });
}));
await useRuntimeStore.getState().connectRetry();
expect(useRuntimeStore.getState().gatewayUser).toEqual(user);
expect(useRuntimeStore.getState().status).toBe("error");
```

Run `pnpm test src/lib/runtime.store.test.ts`; expected red is the null account assertion, not a missing mock or rejected SDK import. Commit only this reproduction as `test: reproduce missing account identity during Web failure`.

## Task 2: Separate Account Publication and Browser-Only Logout Lifecycle

**Status:** Complete in `82f227f`. Guarded tests passed 315 checks, including late authentication results, body-inclusive deadlines, suspension, and preserving active background reviewers; guarded typecheck passed.

**Files:** Create `apps/desktop/src/lib/gatewayAccount.ts` and `.test.ts`; modify `runtime.ts`, `runtime.store.test.ts`, `webMode.ts`, `webMode.test.ts`, `main.tsx`.

- [x] **1. Add deferred lifecycle tests.** Test successful account publication while whoami is pending/failed; workspace reconnect does not cancel account lookup; timeout includes JSON decoding; logout invalidates a late account reply; explicit session expiry suspends recovery once; a provider 401 and a 502 do not sign out. Include an abort-insensitive fetch mock to prove publication fencing rather than relying only on cancellation.

```ts
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const reply = deferred<Response>();
const publish = vi.fn();
const account = createGatewayAccountLifecycle({ fetchImpl: vi.fn(() => reply.promise), publish,
  suspend: vi.fn(), clear: vi.fn(), navigate: vi.fn() });
const loading = account.load();
account.suspend();
reply.resolve(new Response(JSON.stringify({ user: { id: "u", username: "alice", role: "user" } })));
await loading;
expect(publish).not.toHaveBeenCalled();
```

- [x] **2. Run red.** `pnpm test src/lib/gatewayAccount.test.ts src/lib/runtime.store.test.ts src/lib/webMode.test.ts`. Expected: new lifecycle export absent and intended account assertions fail. Do not tolerate unrelated suite failures.

- [x] **3. Implement one browser authentication-lifecycle helper.** Define `createGatewayAccountLifecycle({fetchImpl,publish,suspend,clear,navigate})` returning `load`, `suspend`, `signOut`, and `dispose`. `load` coalesces pending `/api/me`, uses 15-second complete-response timeout, validates id/username/role, and publishes only if its authentication epoch is current. `suspend` increments epoch, aborts reads, calls the browser-only suspension callback, and prohibits new loads/recovery until a new document/login lifecycle. `signOut` coalesces submissions; uses `POST /auth/logout`, JSON accept, same-origin credentials, a 15-second body-inclusive deadline, and only clears/navigates after a valid `{ok:true}` success. On failure keep suspension and return an error to the caller; allow logout retry, not connection resume. Use this exact result fence within `load`:

```ts
const epoch = authenticationEpoch;
const response = await fetchImpl("/api/me", { credentials: "same-origin", signal });
const body: unknown = await response.json();
if (!response.ok || suspended || epoch !== authenticationEpoch || signal.aborted) return;
if (typeof body !== "object" || body === null || !("user" in body)) return;
const user = body.user as Record<string, unknown> | null;
if (!user || typeof user.id !== "string" || !user.id || typeof user.username !== "string" ||
    !user.username || (user.role !== "admin" && user.role !== "user")) return;
publish({ id: user.id, username: user.username, role: user.role });
```

Keep state variables `authenticationEpoch`, `suspended`, pending account/logout promises, and request controllers inside the helper. Race both fetch and decoding against the deadline, remove abort listeners/timers in finally, and make dispose invalidate late work. Define a single app-lifetime installation in `main.tsx` before bootstrap; tests instantiate isolated helpers.

- [x] **4. Integrate without using `disconnect()`.** Remove the connection-owned `account.then` and account resets in deployed `connect`; trigger independent load at platform boot, not on every workspace generation. Add store methods `suspendPlatformBrowser()` and `clearPlatformPresentation()`. The first calls `cancelWebRecovery()`, aborts the catalog owner, closes local clients via teardown helpers, and sets offline without calling runtime abort, reviewer abort, task release, or workspace stop. The second clears identity and account-scoped in-memory presentation after logout succeeds; preserve workspace files, durable history/defaults, and unsent data until that success. Standalone token-gate and desktop disconnect behavior remain unchanged. Gate `bootstrap`, `connectRetry`, event/focus recovery, and SDK reconnect creation on the account helper's suspended flag. Route auth-guard expiry through suspension before redirect. The public contract is:

```ts
type PlatformBrowserLifecycle = {
  suspendPlatformBrowser: () => void;
  clearPlatformPresentation: () => void;
};
```

Test that all runtime abort/stop spies stay at zero during logout, including existing background-review jobs; local event-stream close is allowed.

- [x] **5. Run green and commit.** Repeat Step 2, then `pnpm typecheck`. Expected: account survives workspace failure, no stale publication, no task stop/abort, and standalone behavior passes. Commit named paths as `fix: decouple Web account access from runtime recovery`.

## Task 3: Make Logout Reachable in All Authenticated Failure Surfaces

**Status:** Complete in `746124d`; first review checkpoint reached. Self-review added red/green tests for direct suspension, queued recovery publication, and post-success workspace presentation clearing. Final guarded verification passed 2,035 frontend checks (33 opt-in/platform checks skipped), 43 scoped platform checks, lint, and a Web build including TypeScript checking. The final staged bundle `.deploy/web-build-iPcUO0` passed one non-skipped browser test with nine known/unknown/preparation combinations at 1280/390/320, including failed logout retry, independent-session validity, zero workspace starts, no page errors, and visible button/overflow bounds. Screenshots are in `.deploy/verification/account-*.png`; automated geometry passed, but the image-view tool could not decode them in this session. The original service was restored and its health, source, Web root, entry hash, and image were checked unchanged. No deployment or managed recovery work has started.

**Files:** Create `apps/desktop/src/components/sidebar/GatewaySignOut.tsx` and `.test.tsx`; modify `GatewayAccountMenu.tsx`, `.test.tsx`, `Sidebar.tsx`, `loginPreparation.ts`, `.test.ts`, `services/platform/src/login-page.mjs`, `services/platform/test/platform-server.test.mjs`, and all supported `session.json` locales.

- [x] **1. Add UI/service red cases.** Unknown account at connecting/error/offline shows Sign out but no admin/settings item; known account menu still works by pointer/keyboard; submitting twice sends one request; 502 logout preserves actionable error and no success navigation. Preparation overlay shows a usable logout command before and after its error event. `POST /auth/logout` revokes one independent session and never calls `ensureWorker`, `stopWorker`, or `restartWorker`.

```tsx
render(<MemoryRouter><GatewayAccountMenu user={null} /></MemoryRouter>);
expect(screen.getByRole("button", { name: "Sign out" })).toBeEnabled();
expect(screen.queryByRole("menuitem", { name: "Settings" })).not.toBeInTheDocument();
```

```js
const f = await makeFixture();
const a = makeClient(f.base); const b = makeClient(f.base);
await login(a, "admin", "admin-password"); await login(b, "admin", "admin-password");
f.manager.ensureWorker = async () => { throw Error("logout must not start workspace"); };
assert.equal((await a.request("/auth/logout", { method: "POST", headers: { accept: "application/json" } })).status, 200);
assert.equal((await a.request("/api/me", { headers: { accept: "application/json" } })).status, 401);
assert.equal((await b.request("/api/me", { headers: { accept: "application/json" } })).status, 200);
```

- [x] **2. Run red.** `pnpm test src/components/sidebar/GatewayAccountMenu.test.tsx src/components/sidebar/GatewaySignOut.test.tsx src/lib/loginPreparation.test.ts`; then `pnpm --filter @ai4s/platform test test/platform-server.test.mjs test/auth-store.test.mjs`.

- [x] **3. Implement the shared logout control.** Keep the mounted form/menu keyboard behavior, intercept submit to call the Task 2 lifecycle's `signOut`, render localized error and busy state, and use `LogOut` icon plus existing label. If `user` is null, render this control directly instead of returning null; hide settings and admin role. Do not invent a user. Expose the same app-installed handler to the preparation markup via `scikeel:sign-out`; its result events are `scikeel:sign-out-failed` and successful navigation, with no cookie/token payload.

```tsx
<form method="post" action="/auth/logout" onSubmit={submitSignOut}>
  <button type="submit" disabled={pending} aria-busy={pending}>
    <LogOut size={15} aria-hidden="true" />{t("nav:sidebar.signOut")}
  </button>
  {error && <p role="alert">{t("session:live.account.signOutFailed")}</p>}
</form>
```

Define `submitSignOut` as the component's event handler: prevent default, set pending, await the installed handler, catch to set error, and clear pending in finally only while mounted. The server-rendered overlay button dispatches the same event outside its disabled login form. On failure it re-enables itself and shows an alert; it does not reload or navigate back into the broken app. No additional GET logout route.

- [x] **4. Run green/checkpoint.** Repeat Step 2 and `pnpm test src/i18n/parity.test.ts`. Expected: first failure, unknown identity, and inert preparation overlay all permit logout; logout failure does not claim success. Commit as `fix: keep Web sign out reachable while workspace is unavailable`. Internal review is complete; once continuation is authorized, proceed to Task 4 without asking for another checkpoint approval. Any partial publication still needs deployment authorization.

## Task 4: Add Bounded Liveness and Durable Recovery Windows

**Files:** Create `services/platform/src/workspace-recovery.mjs`, `services/platform/test/workspace-recovery.test.mjs`; modify `sandbox-client.mjs`, `services/platform/test/sandbox-client.test.mjs`.

- [ ] **Preparation A: Re-identify the effective baseline.** Run `git status --short` and `pnpm web:release inspect --source /opt/open-science-desktop/.worktrees/web-account-workspace-recovery`; inspect `systemctl show osd-platform.service -p WorkingDirectory -p MainPID -p ActiveState`. Compare source/bundle/image fingerprints using the existing release manifest/inventory. Expected: the intended account/logout-only delta is understood, and no unrelated production changes are silently lost. Missing prerequisites or source/image mismatch block preparation, not justify weakening release checks. Do not dump service environment or process arguments.

- [ ] **Preparation B: Record bounded incident evidence.** Use existing trusted diagnostics on the affected account if the incident is reproducible. Separate account authentication, platform health, launcher identity/status/generation, gateway health/whoami, and scoped runtime response; share a ten-second complete liveness sample, including response decoding, and cancel remaining reads on expiry. No inactive-account startup, destructive restart, real stress test, prompt/file-content logging, or credential logging. Read only existing authorized per-instance memory/pressure/high-event counters. Expected: a verified failing boundary or an explicit unverified root cause. Do not block deterministic regression work merely because the original incident is no longer reproducible. Task 10 repeats a bounded resource comparison against the candidate; reconstruction success alone is not a memory-fix claim.

- [ ] **1. Write policy/deadline tests first.** Use injected clock and deferred transport; cover five-second success TTL, one shared cycle, one failed cycle versus two separated failures, body decoding hang, catalog-only failure, inspection abort closing socket, caller disconnect not canceling shared owner, and cooldown surviving a new helper instance. Advancing the clock without a caller must cause zero probes; `/api/me` and logout must cause zero liveness calls. Use temporary root paths, not `/private/workers` or live platform data. Corrupt cooldown metadata and failed atomic write must deny replacement.

```js
let now = 1000; let calls = 0;
const gates = [];
const owner = new WorkspaceRecovery({ now: () => now, rootDir: root,
  probe: async () => { calls++; return new Promise(resolve => gates.push(resolve)); } });
const context = { userId: "a", instanceId: "user-a", generation: 1 };
const a = owner.check(context); const b = owner.check(context);
await new Promise(resolve => setImmediate(resolve));
assert.equal(calls, 1);
gates[0]({ context: { instanceId: "user-a", generation: 1 }, state: "healthy",
  activity: "idle", canRestart: false, retryAfterMs: 0 });
assert.deepEqual(await a, await b);
now += 6000;
await new Promise(resolve => setImmediate(resolve));
assert.equal(calls, 1); // Expiry alone must not poll.
```

- [ ] **2. Run red.** `pnpm --filter @ai4s/platform test test/workspace-recovery.test.mjs test/sandbox-client.test.mjs`.

- [ ] **3. Implement `WorkspaceRecovery`.** Constructor `{rootDir,now=Date.now,probe}`; methods `check(context)`, `invalidate(context)`, `reserveReplacement(context)`, `cooldown(context)`, and `dispose()`. `check` owns controllers and one 10-second complete deadline per context, coalesces all callers, caches only successful results for five seconds, and keeps failure streaks scoped to account/instance/generation. Call the injected probe as `probe(context, {signal, deadline})`, where deadline is the injected clock's cycle-end timestamp. The probe returns the Shared Contracts report fields; classify one failed transport as unreachable/unknown, not restart authority. Reject obsolete publication after invalidation. Define constants:

```js
export const HEALTH_TTL_MS = 5000;
export const PROBE_BUDGET_MS = 10000;
export const FAILURE_SEPARATION_MS = 1000;
export const REPLACEMENT_COOLDOWN_MS = 60000;
```

Also export `recoveryError(code, details)` with a fixed message/stage/status table for every `WorkspaceFailureCode`. Unknown codes are rejected, not reflected into responses. Copy only `context`, `action`, and numeric `retryAfterMs` from validated details; set `retryable=true` only for retry/wait outcomes. Preserve 409 for stale context and 503 for bounded temporary failures. The route must not serialize arbitrary Error properties.

The TTL is a cache, not a polling interval: only a caller or generation-matched transport invalidation can request a fresh cycle. A single 502 is not restart authority. Failed launcher identity inspection remains `unknown` with `canRestart:false`, even after repeated failures; repeated runtime failures may permit confirmation only when account/instance ownership is verified. Successful checks clear that generation's failure streak. Account routes never call this helper.

`reserveReplacement` runs only under the manager's serialized lifecycle queue, reads `${rootDir}/recovery/${instanceId}.json`, validates exact schema/identity and safe integer timestamps, then writes `{version:1,userId,instanceId,generation,reservedAt:now}` atomically before any stop/start. Keep mode 0600, directory 0700, exclusive temporary creation and rename; never store credentials. Refuse rollback-clock timestamps as unavailable instead of clearing cooldown. Preserve failed attempt reservations; initial cold start is not a replacement, but a prior failure reservation applies even if the manager process restarted. Reuse local atomic-write style; do not extract a generic filesystem framework.

- [ ] **4. Extend launcher inspection cancellation.** Change `call(op,args,options={})` and `inspect(args,options={})` to accept `{signal,timeoutMs}` without modifying wire fields. Use the smaller validated timeout, pre-abort immediately, remove listeners in finally, and destroy the socket on abort. Preserve existing register/start/stop defaults, 30-second maxima, endpoint validation, and peer-auth protocol. Do not claim cancellation proves a stop operation did not execute.

```js
const timeoutMs = Math.min(this.timeoutMs, options.timeoutMs ?? this.timeoutMs);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("invalid launcher timeout");
if (options.signal?.aborted) throw options.signal.reason;
```

- [ ] **5. Run green and commit.** Repeat Step 2 with fake-clock tests; assert no real 60-second sleeps and no leaked sockets/controllers. Commit as `feat: add bounded workspace liveness and recovery windows`.

## Task 5: Integrate Generation-Scoped Managed Worker Recovery

**Files:** Modify `managed-worker-manager.mjs`, `services/platform/test/managed-worker-manager.test.mjs`, `sandbox-control-plane.mjs`; test new restart/process-reconciliation cases in `services/platform/test/workspace-recovery.test.mjs`.

- [ ] **1. Upgrade the manager fixture and add red cases.** `fixture` must maintain actual mock lifecycle status: register -> registered, start -> ready, stop -> stopped with advanced generation; inspect returns identity/status and private endpoints only when ready. Inject writable temporary metadata root and fake clock. Test running reuse with stale health, stopped-instance cleanup/reconstruction, alive unhealthy requires confirmation, same-generation concurrent restart, stale late confirmation, maintenance denial, reserve failure, stop uncertainty, and process recreation with a live launcher instance. Add separate cases for verified alive identity with unknown task activity (confirmation eligible after repeated failures), unverifiable launcher identity (never restart eligible), and maintenance (confirmation cannot override the lease). Preserve old startup coalescing/tenant tests.

```js
const f = fixture({ rootDir: root, now: () => clock });
await f.manager.ensureWorker({ instanceId: "user-a", userId: "a" });
f.failHealth(true); clock += 6000;
await f.manager.workspaceStatus({ instanceId: "user-a", userId: "a" });
clock += 1100;
const report = await f.manager.workspaceStatus({ instanceId: "user-a", userId: "a" });
assert.equal(report.state, "unresponsive");
assert.equal(f.calls.filter(([op]) => op === "stop").length, 0);
const command = { instanceId: "user-a", userId: "a", action: "restart", generation: 1, confirmed: true };
await Promise.allSettled([f.manager.recoverWorker(command), f.manager.recoverWorker(command)]);
assert.equal(f.calls.filter(([op]) => op === "stop").length, 1);
assert.equal(f.calls.filter(([op]) => op === "start").length, 2);
```

Define `failHealth` and clock plumbing in the fixture in this step; health failure applies only to current-generation probes, not replacement configuration, so the test does not accidentally reject replacement startup.

- [ ] **2. Run red.** `pnpm --filter @ai4s/platform test test/managed-worker-manager.test.mjs test/workspace-recovery.test.mjs`.

- [ ] **3. Wire probes to existing identity/admission.** Inject the Task 4 helper into the manager. Inspect launcher before reusing stale `running` records; authenticate `/v1/health` and a read-only scoped runtime status inside the same complete deadline. Native assistant activity uses the existing execution probe. A base-directory idle reply cannot prove that other project directories or native jobs are idle: include known current-generation session/native reservations, active mutations, and maintenance in activity classification; missing coverage stays unknown. Record failures with `noteTransportFailure` for matching generation only. Probe failure never silently changes permission mode or redirects to an unverified address. `workspaceStatus` does not create a record/start just to answer an absent workspace.

For fresh process state, inspect before starting: verified registered/stopped may enter existing startup; ready-but-not-adopted context must not be configured as a fresh instance. Recover an observation-only record from launcher-verified owned registration and generation; keep mutations fenced until broker authority is reconciled. A confirmed cleanup path is eligible only if ownership and safe cleanup can be verified; otherwise report unknown with `canRestart:false`. Do not run the existing profile configuration against a healthy live generation merely to adopt it; that may reconfigure execution. Unknown instance may register for genuine initial startup, but any other inspection error fails closed.

- [ ] **4. Implement controlled replacement inside the existing serial queue.** Coalesce replacement by old generation; revalidate generation/maintenance after awaiting probes and immediately before termination. `retry` never stops an alive/unknown instance. `restart` requires exact generation and `confirmed===true`, repeated failed liveness, and no maintenance. A later old-generation request returns stale rather than repeating the operation. Fence new mutations before cleanup; invalidate old probe/authority; persist reservation before cleanup; verify launcher stop, release old admission, revoke credentials/brokers, then invoke the existing startup path once. Avoid calling public serialized `stopWorker` recursively while holding `#serialized`; use private lifecycle helpers to prevent self-deadlock.

Use this precondition in the queued restart body:

```js
if (!record || record.userId !== input.userId || record.generation !== input.generation)
  throw recoveryError("stale_workspace_context", { context: currentContext, action: "retry" });
if (input.confirmed !== true || record.maintenance || report.state === "healthy")
  throw Object.assign(new Error("Workspace cannot be restarted in its current state"), { statusCode: 409 });
await recovery.reserveReplacement({ userId: record.userId, instanceId: record.id, generation: record.generation });
```

Define exported `recoveryError(code,details)` in Task 4 with allowlisted codes, safe messages, statusCode 503 by default and 409 for stale; `currentContext` is derived from that record, never request-supplied authority. Do not return manager's private token.

On cleanup failure keep authority invalid and lifecycle fenced, retain cooldown, and do not start. Lifecycle recovery covers unavailable records too; existing `#stop` currently skips unavailable records, so explicit recovery cleanup must not rely on that guard. After cleanup verify current launcher generation rather than guessing `old+1`. No parallel old/new process tree.

- [ ] **5. Add ordinary mutation gating and shared failure outcome.** `ensureWorker(...allowRecovery:false)` returns `workspace_recovery_required` before rebuilding when the instance is stopped/unhealthy. GET/retry can reconstruct a verified stopped generation once; internal metadata reads must not bypass failed cleanup. Request cancellation releases leases but never cancels a shared replacement awaited by other callers. Distinguish maintenance from unknown activity.

- [ ] **6. Run green and commit.** Repeat Step 2, then `pnpm --filter @ai4s/platform test test/sandbox-control-plane.test.mjs test/sandbox-scheduler.test.mjs test/tenant-policy.test.mjs`. Expected: no double generation, stale repeat stop, admission bypass, lost cooldown, or tenant authority reuse. Commit as `fix: recover managed workspaces without duplicate generations`.

## Task 6: Expose Authenticated Recovery and Reconcile Interrupted Work

**Files:** Modify `platform-server.mjs`, `services/platform/test/platform-server.test.mjs`, `research-tasks.mjs`, `collaboration.mjs`, `cli-runtime.mjs`, and their existing `test/*.test.mjs`; wire hooks in `sandbox-control-plane.mjs`/`main.mjs` only where ownership requires it.

Also modify `services/platform/src/sandbox-native-jobs.mjs`, `services/platform/test/sandbox-native-jobs.test.mjs`, and generation-scoped cleanup in `managed-worker-manager.mjs` where the existing native failure fallback calls `stopWorker`.

- [ ] **1. Add route/security red tests.** Add injected manager recovery spies to the existing fixture; test the two exact routes before generic `/api/` handling. Cover missing session, cross-origin POST, extra userId/url/token/body fields, missing confirmation, unknown context, stale version, read-only capability denial, status never starting worker, structured 503, restart cooldown, and no mutation forwarding after `allowRecovery:false` rejection. Existing same-origin validation must reject absent Origin on browser mutation requests unless an existing explicit trusted-client path applies.

```js
const response = await admin.request("/api/workspace/recover", {
  method: "POST", headers: { origin: f.base, accept: "application/json", "content-type": "application/json" },
  body: JSON.stringify({ action: "restart", instanceId: "user-foreign", generation: 1, confirmed: true }),
});
assert.equal(response.status, 403);
assert.equal(recoveryCalls.length, 0);
```

- [ ] **2. Run red.** `pnpm --filter @ai4s/platform test test/platform-server.test.mjs test/research-tasks.test.mjs test/collaboration.test.mjs test/cli-runtime.test.mjs`.

- [ ] **3. Implement exact route dispatch.** Authenticate using `#currentUser`; derive workerId from userId, parse strict JSON commands, enforce same-origin and generation constraints, call the Task 5 manager directly (not `#ensureWorker`), serialize validated reports/errors, and preserve `no-store`. Status/recovery routes do not depend on catalog reads, and `/api/me`/logout stay ahead of worker startup. Thread `allowRecovery` through `#ensureWorker` call sites: reads may safely reconstruct a verified stopped worker; ordinary writes may not. In generic proxy error paths invalidate health for its generation only; do not count external-provider/catalog rejection as liveness failure. Set/reconcile the existing runtime-generation response header.

```js
const workerId = workerIdForUser(user.id);
if (body.action === "restart" && body.instanceId !== workerId) {
  sendJson(response, 403, { error: "Workspace does not belong to this account" });
  return;
}
const result = await this.workerManager.recoverWorker({ userId: user.id, instanceId: workerId,
  action: body.action, generation: body.generation, confirmed: body.confirmed });
sendJson(response, 200, result);
```

- [ ] **4. Bind generation preconditions to mutations.** Platform Web runtime writes send `x-scikeel-runtime-generation`; reject mismatches with 409 before prompt/command/approval/deletion delivery. Keep standalone/Desktop requests compatible by applying this requirement only to platform-managed routes. Route-specific generation checks must run again after async authority/probe work. Never retry a failed write server-side. Test the response-lost case with accepted messageID and receipts; one turn only.

- [ ] **5. Reconcile interrupted work only after verified cleanup.** Implement manager `setRecoveryHooks({beforeCleanup,afterCleanup})` through platform-owned callbacks. `beforeCleanup` records only current-generation pending deliveries/executions as interrupted/unknown and fences new work; it does not mark them completed. Signal native cancellation without waiting for a fallback that reacquires the manager's serial queue; the manager's verified instance cleanup stops the old process tree. `afterCleanup` uses existing paused/failed/revision transitions for matching research and collaboration records and settles old native execution via its existing cancellation control. Add methods `interruptGeneration(context)` to research/collaboration/native manager only where their current APIs cannot perform this exact transition without a network request. Filter durable records by owned instance/generation before changing them; preserve completed historical outputs, defaults, unanswered decisions, and unrelated sessions/generations. Do not call `ResearchTasks.stop()` against an unresponsive runtime as a prerequisite for local bookkeeping. Missing records are harmless; unreadable records produce a reconciliation error and block claims of ready completion.

Extend native failure fallback to `stopWorker(instanceId, {expectedGeneration: context.generation})`; the manager revalidates this optional precondition inside its queue. A late generation-1 cleanup cannot stop generation 2. Keep existing unscoped admin shutdown semantics only for explicit current lifecycle shutdown, not old asynchronous job callbacks. Add a deferred native-abort test where replacement wins before fallback runs, and assert no new-generation stop. This is also required for research/interaction asynchronous cleanup callbacks that can terminate an instance.

Test interrupted records with the existing fields:

```js
await tasks.interruptGeneration(context);
const saved = await tasks.load(context.userId, sessionId);
assert.equal(saved.executionActive, false);
assert.equal(saved.status, "paused");
assert.equal(saved.stopReason, "workspace-restarted");
assert.equal(saved.execution, previous.execution);
assert.deepEqual(saved.deliverables, previous.deliverables);
```

Bind the context using each module's existing owner schema; do not invent a task field solely to satisfy this snippet. Tests must include persisted records not already cached in memory.

- [ ] **6. Run green and commit.** Repeat Step 2 plus `pnpm --filter @ai4s/platform test test/attachment-turns.test.mjs test/interaction-replies.test.mjs test/sandbox-native-jobs.test.mjs test/managed-worker-manager.test.mjs`. Expected: account routes independent, tenant/cross-origin denial, interrupted not completed, no blind replay, native cleanup cannot stop the new generation, and receipts still work. Commit as `feat: expose controlled account-scoped workspace recovery`.

## Task 7: Add SDK Recovery Transport and Integrate Browser Ownership

**Files:** Create `packages/sdk/src/GatewayWorkspaceClient.ts`, `apps/desktop/src/test/gateway-workspace-client.node.test.ts`; modify SDK `index.ts`, `OpenCodeClient.ts`, `apps/desktop/src/lib/runtime.ts`, `runtime.store.test.ts`, `apps/desktop/src/test/opencode-client.node.test.ts`.

- [ ] **1. Add transport/store red tests.** Test report decoding, fixed route paths, same-origin credentials, full response timeout/cancel, stale generation, and invalid response (no fake readiness). Store tests cover existing 90-second budget including probes, one replacement per recovery owner, manual confirmation not using captured obsolete context, auth suspension, preserved drafts, one shared browser window, and no prompt/abort/restart on ordinary healthy refresh.

```ts
const calls: Array<{ path: string; init?: RequestInit }> = [];
const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  calls.push({ path: String(input), init });
  return new Response(JSON.stringify({ context: { instanceId: "user-a", generation: 2 },
    state: "healthy", activity: "idle", canRestart: false, retryAfterMs: 0 }));
});
const client = new GatewayWorkspaceClient({ fetchImpl });
await client.recover({ action: "restart", instanceId: "user-a", generation: 1, confirmed: true },
  { signal: new AbortController().signal, timeoutMs: 1000 });
expect(calls[0].path).toBe("/api/workspace/recover");
expect(calls[0].init?.credentials).toBe("same-origin");
expect(JSON.parse(String(calls[0].init?.body)).generation).toBe(1);
```

- [ ] **2. Run red.** `pnpm test src/test/gateway-workspace-client.node.test.ts src/lib/runtime.store.test.ts src/test/opencode-client.node.test.ts`.

- [ ] **3. Implement the fixed-origin SDK client.** Export the shared contracts above; define constructor `{fetchImpl=globalThis.fetch}` and methods `status(options)` and `recover(command,options)`, with required `{signal,timeoutMs}`. Always use fixed relative routes, parse/validate complete success and failure bodies within cancellation/deadline, and throw `GatewayWorkspaceError` exposing only validated `WorkspaceFailure`. Define it in this file and export it through `index.ts`:

```ts
export class GatewayWorkspaceError extends Error {
  constructor(readonly status: number, readonly failure: WorkspaceFailure) {
    super(failure.error);
    this.name = "GatewayWorkspaceError";
  }
}
```

Unknown/non-JSON failure bodies become a safe generic connection failure, not a guessed recovery action. Never accept a URL, credential, account ID, or arbitrary path from the UI.

```ts
export type WorkspaceRequestOptions = { signal: AbortSignal; timeoutMs: number };
export class GatewayWorkspaceClient {
  constructor(options?: { fetchImpl?: typeof fetch });
  status(options: WorkspaceRequestOptions): Promise<WorkspaceReport>;
  recover(command: WorkspaceRecoveryCommand, options: WorkspaceRequestOptions): Promise<WorkspaceReport>;
}
```

The declarations describe the class to implement, not a second abstract class. Add `OpenCodeClient.setGatewayGeneration(generation:number|null)` and an optional header from `headers()` for writes. Export the state/error types from this file; do not duplicate an incompatible type union in the runtime store. Do not include this header on cross-origin model/provider probes or require it in desktop/standalone operation. Test SDK write methods using current generation and no automatic retry after a 409/unknown delivery.

- [ ] **4. Extend the existing store owner.** Add `gatewayWorkspaceReport`, `gatewayWorkspaceFailure`, `gatewayRestartPending`, and `restartGatewayWorkspace(context)`; use existing error string for compatibility. On required-context/stream failure obtain bounded status through SDK within `beforeDeadline`, preserve structured failure, and perform at most one `recover({action:"retry"})` if verified stopped. Use the winning context for later metadata/stream/session reads and SDK generation. Catalog-only failure keeps the existing independent catalog retry. Manual restart creates one fresh explicit recovery window; coalesce pending submissions, capture context from the confirmation dialog, and never replace it with a newly fetched generation before dispatch. After server replacement, reacquire whoami/runtime/session list and expire old interactions; preserve unsent draft/attachment data in the same account/conversation.

Use the existing cancellation guard at every publication:

```ts
if (!active() || owner.controller.signal.aborted) return false;
const remaining = beforeDeadline(owner.deadline, 10000);
const report = await workspaceClient.status({ signal: owner.controller.signal, timeoutMs: remaining });
if (!active()) return false;
set({ gatewayWorkspaceReport: report });
```

`owner` is the current `webRecovery` owner, not a new second store loop. Status healthy reconnects only. Unknown/unresponsive never dispatches restart automatically. Retry never upgrades to a live-instance restart. A new status arriving during an open confirmation cannot retarget that confirmation; the command always carries the captured context, and stale context returns 409. Logout during status/recovery cancels local publication, not the shared server lifecycle. Legacy metadata fallback stays confined to non-platform Web; this new status client is platform-only.

- [ ] **5. Run green and commit.** Repeat Step 2 and `pnpm typecheck`; assert prompt/stop/abort counters remain zero in healthy reload, logout, and liveness recovery cases. Commit as `feat: connect Web recovery to the scoped workspace SDK`.

## Task 8: Add Actionable Failure and Explicit Restart Confirmation

**Files:** Create `apps/desktop/src/components/session/WorkspaceRecoveryActions.tsx`, `.test.tsx`; modify `SessionView.tsx`, `SessionView.launch.test.tsx`, `apps/desktop/src/lib/loginPreparation.ts`, `.test.ts`, `services/platform/src/login-page.mjs`, `services/platform/test/platform-server.test.mjs`, all supported `session.json` locales, `apps/desktop/src/i18n/parity.test.ts`.

- [ ] **1. Add action-matrix red tests.** Healthy reports omit restart; unknown/unresponsive with verified current context and server `canRestart:true` expose it; maintenance, cooldown, unverifiable identity, unsupported standalone, and context-null disable/hide restart. Confirm dialog retains observed generation even after store generation changes, supports keyboard cancel, states impact on all devices, and requires explicit confirmation. Sign out remains usable during recovery and cooldown. A cold login failure must expose the same React recovery controls despite the initially inert root; no hidden-button acceptance.

```tsx
render(<WorkspaceRecoveryActions report={{ context: { instanceId: "user-a", generation: 1 },
  state: "unresponsive", activity: "unknown", canRestart: true, retryAfterMs: 0 }} />);
await user.click(screen.getByRole("button", { name: "Restart workspace" }));
expect(screen.getByRole("dialog")).toHaveTextContent("all devices");
useRuntimeStore.setState({ gatewayContext: { instanceId: "user-a", generation: 2 } });
await user.click(screen.getByRole("button", { name: "Confirm restart" }));
expect(restart).toHaveBeenCalledWith({ instanceId: "user-a", generation: 1 });
```

- [ ] **2. Run red.** `pnpm test src/components/session/WorkspaceRecoveryActions.test.tsx src/components/session/SessionView.launch.test.tsx src/lib/loginPreparation.test.ts src/i18n/parity.test.ts`; then `pnpm --filter @ai4s/platform test test/platform-server.test.mjs`.

- [ ] **3. Implement compact existing-surface controls.** Use existing Radix Dialog (not a custom modal), `RefreshCw`/`LogOut` icons, localized commands, existing Retry/Connect behavior, and the Task 3 shared signout action. Display sanitized stage-specific summaries and a finite recovery state. Hide new actions outside platform Web. Confirmation includes account username only if verified, shared-workspace impact, interruption warning, cancel, and Confirm restart. Healthy pages must not gain a new dashboard or constant warning. Add keys `live.recovery.{retry,restart,confirmRestart,cancel,sharedImpact,interruptWarning,workspaceUnavailable,runtimeUnresponsive,capacityUnavailable,recovering,staleContext,cooldown,cleanupUnverified}` and `live.account.signOutFailed` to every supported locale.

For a failed login preparation, add `scikeel:login-recovery` to the existing bridge. Extend its `PreparationState` with the SDK `gatewayWorkspaceReport` and `gatewayWorkspaceFailure` fields from Task 7. When `status === "error"` and a validated structured workspace failure/report is available, dispatch this event instead of leaving the root inaccessible behind the preparation error. Its server markup listener removes only the preparation host/marker and clears `root.inert`; it does not emit login-ready, set runtime ready, reload, erase drafts, or issue a recovery request. React displays the same failure controls and Radix confirmation after handoff. Keep the current overlay Retry/Sign out fallback for failure without a validated workspace report, and keep logout suspension/delayed-response fences intact. This reuses one recovery UI rather than implementing another confirmation in Shadow DOM. Add the event to the existing typed `finish` event union and remove the logout bridge listener on either ready or recovery handoff.

Do not unsubscribe permanently on fallback `login-error` before a later structured report can arrive. Retain a bounded-by-page-lifetime subscription with an error-emitted guard until ready/recovery handoff, logout suspension, or disposal; clear the preparation deadline after the first terminal display, and allow only one handoff. Test both report-before-error and report-after-error, with zero handoff after logout begins.

```js
document.addEventListener('scikeel:login-recovery', () => {
  host.remove();
  if (root) root.inert = false;
  document.documentElement.removeAttribute('data-scikeel-login-preparing');
  try { sessionStorage.removeItem('scikeel.login.pending'); } catch {}
}, { once: true });
```

- [ ] **4. Run green and commit.** Repeat Step 2 and `pnpm lint`; no untranslated strings, layout-shifting controls, or admin controls for unknown account. Commit as `feat: make Web workspace recovery failures actionable`.

## Task 9: Exact-Bundle Two-Page and Cold-Failure Acceptance

**Files:** Extend `apps/desktop/src/test/webAccountRecovery.acceptance.test.mjs`, already created and exercised during Task 3; modify `scripts/dev/web-release.mjs`, `web-release-policy.mjs`, `web-release.test.mjs`; extend existing service/store tests for spec scenarios not covered yet. Preserve all nine original account/logout browser combinations.

- [ ] **1. Add a release-registration red test.** `browserStage` must include the new scenario for both `login` and `session` groups without duplicate registration, set `OSD_ACCOUNT_RECOVERY_ACCEPTANCE=1`, and fail if its file is missing. Changes to gateway account/recovery SDK/policy must select frontend/platform tests and the new browser group. Its acceptance metadata must include 320 as well as 1280/390 when this scenario runs; desktop-only flags cannot count as full acceptance. Never suppress required existing recovery/tool/notification scenarios or live checks.

```js
assert.ok(invocations.some(call => call.args.includes("src/test/webAccountRecovery.acceptance.test.mjs")));
assert.equal(environment.OSD_ACCOUNT_RECOVERY_ACCEPTANCE, "1");
```

- [ ] **2. Run red.** `pnpm release:test scripts/dev/web-release.test.mjs`.

- [ ] **3. Extend fixture-driven browser acceptance.** Follow `webRuntimeRecovery.acceptance.test.mjs`: load exact `OSD_WEB_CANDIDATE`, inject both flags, use Playwright path/executable prerequisites, a local HTTP fixture, and opt-in test guard. Record only path/status/timing/operation counts, no request bodies/cookies. Model/auth/workspace states are controllable independently. Mock server recovery uses one in-flight gate and old-generation validation; real server coalescing is separately established by manager tests, not inferred from a browser mock.

Use two contexts for independent-device sessions and two pages in one context for shared-cookie behavior. Cold whoami 502 with account success shows signout; account failure also shows fallback; real preparation HTML must remain usable. Repeated restart clicks and two device confirmations yield one server fixture replacement; old context then returns 409. Lost prompt response does not increase prompt counter on retry/reload. Assert no false completed/interrupted task state and restored history after replacement.

Include cold preparation -> structured failure -> React recovery handoff -> keyboard restart confirmation, plus fallback overlay logout without a structured report. Assert no restart for one failed cycle, healthy focus/refresh, catalog/provider failure, unverified launcher identity, or logout. Closing one joining page must not cancel another page's shared replacement. Restart and its cooldown must leave both independent login sessions valid; shared-cookie logout must produce explicit auth expiry on the other tab's next platform request without terminating research.

```js
for (const width of [1280, 390, 320]) {
  for (const locale of ["en", "zh-Hans"]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    try {
      const page = await context.newPage();
      await page.goto(origin + "/live");
      await expect(page.getByRole("button", { name: locale === "en" ? "Sign out" : "\u9000\u51fa\u767b\u5f55" })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally { await context.close(); }
  }
}
```

Reuse the actual Chinese nav label if it differs from this example; test locale text from the staged translations, not guessed labels. Capture screenshots locally for 1280/390/320 critical failure/confirmation surfaces, inspect them for hidden controls and overlap, and clean up browser/server/timers in finally.

- [ ] **4. Register and run green.** Register the scenario once when either group is selected, with mandatory opt-in and zero skipped/pending scenarios during candidate acceptance. Run `pnpm release:test scripts/dev/web-release.test.mjs`, then the focused browser file through `pnpm test src/test/webAccountRecovery.acceptance.test.mjs` only after setting the existing candidate/browser prerequisites and opt-in environment. Ordinary opt-out skip is not acceptance evidence. Commit as `test: verify Web account recovery across tabs and devices`.

## Task 10: Full Candidate Verification and Publication Gate

**Files:** No additional product scope. Read candidate manifest and update only `PROGRESS.md` with verified milestones.

- [ ] **1. Audit spec coverage before full runs.** Every spec acceptance row must map to a passing test or an explicitly recorded unverified live condition. Verify Tasks 2-3 cover account/loading/logout and auth expiry; Tasks 4-6 cover liveness, cooldown, generation, resource denial, maintenance and cleanup; Tasks 7-8 cover SDK ownership and user actions; Task 9 covers exact-bundle browser/device/viewport behavior. Inspect no-blind-replay paths for prompt, command, deletion, approval, and task start, not just one representative prompt. Review patch for unrelated changes, credential exposure, limits, or new task schema.

- [ ] **2. Run all relevant guarded deterministic suites sequentially.**

```bash
pnpm --filter @ai4s/platform test
pnpm test
pnpm typecheck
pnpm lint
pnpm release:test scripts/dev/web-release.test.mjs
```

Expected: all applicable tests pass; opt-in live/browser tests may skip only in these ordinary runs and must execute during preparation. No claim of acceptance from skipped tests. Stop on resource/lock rejection; do not raise limits or run concurrent jobs.

- [ ] **3. Prepare one frozen candidate under the existing release workflow.** From the isolated checkout with prerequisites configured:

```bash
pnpm web:release inspect --source "$task_checkout"
pnpm web:release prepare --source "$task_checkout" --maintenance
```

`task_checkout` was set in Task 1; capture the returned concrete candidate ID as `task_release_id`. Maintenance stops only authorized project workloads and must preserve files/history/credentials. Verify candidate source hashes, original image digest, guard settings, selection, test counts, non-Claude live checks, browser screenshots and zero opt-in skips. Do not bypass an incompatible effective source/image or missing prerequisite. No sandbox runner/image/Rust changes are intended; if inspection proves launcher cannot establish safe state, stop and review scope instead of changing the image ad hoc.

- [ ] **4. Perform bounded resource diagnosis without promising a memory fix.** During synthetic/non-Claude live checks, compare one versus two idle browser pages and one authorized synthetic research turn. Record operation counts, latency, launcher generation, readable per-instance cgroup memory/high-event/pressure evidence through existing trusted diagnostics, and unexpected native execution. Do not make the platform a general host filesystem reader. Use no real prompt/file content in logs; never create a stress test that risks host reserve. If the source of growth cannot be established, record it as unknown. Recovery success does not establish resource optimization.

- [ ] **5. Review candidate and request deployment authorization.** Provide the ID, covered scenarios, remaining live uncertainties, preserved state, and interruption warning. A request to start implementation or write this plan alone is not deployment approval. No service switch at this step.

- [ ] **6. After explicit authorization, publish and verify.**

```bash
pnpm web:release deploy --release "$task_release_id"
```

Verify served asset identity, independent account read/logout, cold failure behavior, shared recovery and history with available runtimes. Do not force a production runtime into memory thrashing to test restart. Run interruption tests against synthetic state; real active work requires the documented maintenance policy. Use the workflow's prior published ID for rollback if acceptance fails; never delete live source or user data. Report actual production/browser verification separately from fixture results.

- [ ] **7. Record results, then stop.** Prepend timestamped English milestones to `PROGRESS.md` only for verified outcomes/blockers. Final report names candidate/commit, actual tests and limits, publication status, unresolved memory diagnosis, and any unverified scenario. No complete claim until all required scope is done; a logout-only delivery is labeled partial.

## Plan Self-Review

Coverage: R1-R2 -> Tasks 1-3; R3-R4 -> Tasks 4-6; R5-R6 -> Tasks 5-8; R7 -> Tasks 6-7/9; simultaneous login -> Tasks 3/5-9; resource/tenant/viewport/publication constraints -> Tasks 4-10. All 22 revised-spec scenarios have an assigned layer below.

| Spec acceptance scenario | Implementing/verification tasks |
| --- | --- |
| First whoami failure, successful account metadata | 1, 2, 3, 9 |
| Account metadata unavailable, fallback logout | 2, 3, 9 |
| Login-preparation failure | 3, 9 |
| Logout with pending browser operations | 2, 3, 9 |
| Failed logout response | 2, 3, 9 |
| Independent device sessions | 3, 9 |
| Shared-cookie tab logout | 3, 9 |
| Healthy active turn during refresh/focus | 5, 7, 9 |
| Concurrent stopped-instance requests | 4, 5, 6 |
| One missed cycle followed by success | 4, 5 |
| Repeated failed cycles with unknown task state | 4, 5, 8, 9 |
| Two old-generation restart confirmations | 5, 6, 8, 9 |
| Replacement failure and cooldown | 4, 5, 6, 8 |
| Delivered mutation with lost response | 6, 7, 9 |
| Superseded login and old-generation results | 2, 5, 7 |
| Catalog/provider outage without restart | 4, 5, 7 |
| Capacity, maintenance, cleanup failure | 4, 5, 6 |
| Incident not reproducible or resource-growth cause unknown | 4 preparation, 10 |
| Interrupted research preserves data/history | 6, 7, 9, 10 |
| Read-only/foreign account/origin | 5, 6, 7 |
| Shared settings and stale collaboration | 6, 7, 9 |
| Desktop/phone English/Chinese failure UX | 3, 8, 9 |

Checked API names, exact paths against the inspected deployment, unknown-first-context handling, cancellation versus operation delivery, shared-probe ownership, durable cooldown, mutation generation guards, process reconciliation, deadlock avoidance, logout without task abort, interrupted records, and dirty-baseline preservation. Numeric budgets match the spec. Test fixture upgrades are explicit; fake launcher `registered` forever is not valid liveness evidence.

October 13 self-review additionally checked no polling without callers, account-only route independence, single-failure versus verified-identity restart eligibility, maintenance denial despite confirmation, non-destructive retry, cold-preparation handoff, existing acceptance-file reuse, and coverage of the revised diagnosis criterion. Completed account/logout work is retained; future implementation reviews are internal checks, not redundant permission pauses.

Tasks 1-3 have the recorded October 12 verification. Tasks 4-10 remain pending, including fresh integrated verification and publication. This revision wrote documentation only: no product code, heavy test run, service restart, candidate preparation, or deployment. A later execution request starts at Task 4 preparation and proceeds inline through candidate review; deployment still requires explicit authorization.
