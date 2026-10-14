# Web Runtime Recovery and Model Loading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task after user approval. Steps use checkbox (`- [ ]`) syntax for tracking. Do not dispatch subagents unless separately authorized.

**Goal:** Restore Web conversations automatically after refresh and publish models/history without waiting for optional availability, agents, or skills.

**Architecture:** Keep the existing gateway APIs, SDK, and runtime store. Give Web recovery one owner with validated platform context and an overall deadline; split catalog publication and history's command dependency; make public Zen availability a bounded background advisory with a public-only session cache. Preserve server-side workers and authoritative model/send checks.

**Tech Stack:** React, TypeScript, Zustand, existing OpenCode SDK, Vitest, Playwright, package-script cgroup guards, and the bounded Web release workflow.

**Spec:** `docs/superpowers/specs/2026-10-06-web-runtime-recovery-model-loading-design.md`.

**Status:** Draft for user review. No task has been implemented. Approval is required before code edits, tests that change runtime state, or deployment.

## 1. Execution boundaries and file map

Work from an isolated production-compatible checkout, not the dirty main checkout or the immutable live release directory. Task 1 establishes that checkout from the actual deployed source. All file paths below are relative to it. Keep the installed scientific image and provider configuration unchanged. Claude is excluded from all live probes and gates; retain deterministic compatibility tests.

| File | Responsibility |
| --- | --- |
| `packages/sdk/src/OpenCodeClient.ts`, `packages/sdk/src/index.ts` | Optional bounded/cancellable catalog reads while preserving existing no-argument calls |
| `apps/desktop/src/test/opencode-client.node.test.ts` | SDK catalog deadline, body cancellation, and default-call compatibility |
| `apps/desktop/src/lib/runtime.ts` | Validated Web context, owned retries, independent model/command publication, stale-result guards, selected-model send checks |
| `apps/desktop/src/lib/runtime.store.test.ts` | Deferred-branch, metadata failure, retries, ownership, account/model selection, and history regressions |
| `apps/desktop/src/lib/zenModels.ts` | Web background advisory, cache validation, timeout, no-Zen fast path; existing desktop behavior |
| `apps/desktop/src/lib/zenModels.test.ts` | Nonblocking reads, storage/module reload, fail-open and late-update tests |
| `apps/desktop/src/lib/webMode.ts` | Optional cancellation signal for gateway GET; preserve auth guard |
| `apps/desktop/src/lib/webMode.test.ts` | Signal forwarding and login/upstream-401 behavior |
| `apps/desktop/src/app/layout/AppShell.tsx` | Coalesced online/visible-tab recovery requests; cleanup |
| `apps/desktop/src/app/layout/AppShell.webRecovery.test.tsx` (new) | Browser event burst and healthy-tab behavior |
| `apps/desktop/src/components/session/SessionView.tsx` | Retry action uses the owned Web recovery entry |
| `apps/desktop/src/components/session/SessionView.launch.test.tsx` | Loading/failure/retry UI |
| `apps/desktop/src/app/routes/SettingsPage.tsx` | Web Connect action uses the same owned entry |
| `apps/desktop/src/components/thread/WebModelPicker.tsx` | Existing choice/loading/disabled presentation; change only if regression tests require it |
| `apps/desktop/src/components/thread/WebModelPicker.test.tsx` (new) | Native-model readiness and retired-choice behavior |
| `apps/desktop/src/lib/loginPreparation.ts`, `.test.ts` | Handoff for usable ready/limited catalogs, normal-reload behavior |
| `apps/desktop/src/test/webRuntimeRecovery.acceptance.test.mjs` (new) | Exact staged-bundle ordering, automatic refresh recovery, history, read-only and viewport scenarios |
| `scripts/dev/web-release.mjs`, `.test.mjs` | Always register the recovery browser scenario in session verification |
| `PROGRESS.md` | Actual results, with timestamp and no secrets |

Locale JSON files and parity tests are touched only if a new user-visible message is necessary. Reuse existing localized connecting/retry/unavailable text wherever it expresses the actual stage. Do not restructure the store or add a new settings surface.

## Task 1: Establish production identity and reproduce the blocked branches

**Files:** Existing source/manifest and test files are read; add reproduction cases to `runtime.store.test.ts`, `zenModels.test.ts`, and the new browser scenario only after approval.

- [ ] **1. Re-inspect production and prepare an isolated checkout.** Run the following read-only commands from the main repository:

```bash
systemctl show osd-platform -p WorkingDirectory -p ExecStart
pnpm web:release inspect --source /opt/open-science-desktop
git status --short
```

Record effective source/Web/image identity from the inspection, not environment values or credentials. Use `superpowers:using-git-worktrees` at execution time to create `.worktrees/web-runtime-recovery-2026-10-06` as a linked detached worktree from the main repository; verify that `git rev-parse --path-format=absolute --git-common-dir` equals the main repository's result. Do not initialize a separate git repository: its separate task locks would defeat cross-checkout serialization. Overlay the allowlisted effective deployed source using `inventorySource(production.source, { git: false })`, `fingerprintFiles()`, and `freezeSource()` from `scripts/dev/web-release-source.mjs`. Remove only source-allowed files absent from that inventory in the newly created worktree; preserve its `.git` link and do not delete main/production files. Read the pinned dependency references from the current release manifest, validate them with `dependencyIdentity(production.source, { references })`, and pass that validated identity to `freezeSource(..., { dependencies })`; this stages dependencies and remaps workspace packages to the candidate. No dependency installation is needed. Compare every copied file hash with the deployed inventory, then commit this isolated baseline with no remote or push. Carry only the two approved design documents into `docs/superpowers/`. Package guards and release tooling must already exist in the copied source. Re-run release inspection against this checkout; unexpected source/image drift or dependency mismatch requires a corrected baseline before edits.

- [ ] **2. Capture a safe refresh baseline.** Use an authenticated test browser without printing storage state, cookies, headers, payloads, or message contents. Capture monotonic timestamps for document/navigation, `/api/runtime`, `/api/me`, `/v1/whoami`, `/event`, session list, messages, `/command`, `/config/providers`, `/global/config`, `/agent`, `/skill`, and `/v1/zen-models`. Record only endpoint path, status, duration, and control-ready timestamps. Observe five warm reloads; do not create model turns or stop workers in this baseline. A real manual-reconnect failure must identify the failed boundary if reproducible; otherwise explicitly label it unreproduced and retain deterministic reproductions of the confirmed code paths.

- [ ] **3. Add deferred test gates to the existing mock methods.** Add `agentGate`, `commandGate`, `providerGate`, `skillGate`, and constructor/close call spies to `mocks`. Each gate is `Promise<void> | null`; await it at the beginning of the corresponding method and preserve all existing behavior afterward. Clear gates/spies in the existing test reset. Use this complete deferred helper in new tests:

```ts
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
```

Add store cases with ready platform context and deferred agents/skills: a model read finishes while those gates remain pending, and a message/command read finishes while models remain pending. Do not unblock the optional gates until after asserting the intended readiness. Add a Zen case using a never-finishing `gatewayGet` and an immediately available non-Zen provider catalog. Always release deferred gates in cleanup.

- [ ] **4. Run the reproductions through package scripts.** In the isolated checkout:

```bash
pnpm test src/lib/runtime.store.test.ts src/lib/zenModels.test.ts
```

Expected before the fix: readiness/nonblocking assertions fail for the identified dependencies. Verify that failures are the intended assertions, not imports, fixture errors, missing guards, or skipped tests. Do not begin refactoring until the baseline and red failures distinguish connection-context, model publication, and history publication.

- [ ] **5. Commit only the reproduction test paths.** Suggested message: `test: reproduce blocked Web runtime restoration`. Record a progress milestone only when the reproductions are established.

## Task 2: Validate platform context and own bounded Web recovery

**Files:** `runtime.ts`, `runtime.store.test.ts`, `webMode.test.ts`; later UI callers are covered in Task 5.

- [ ] **1. Add failing context and concurrency tests.** Extend the existing Web mock with `isPlatformWeb`, reset it independently of `isGatewayWeb`, and route fetch fixtures by pathname. Cover: first runtime metadata 503 then success; failed `/api/me` with valid runtime; malformed/unknown runtime/kind; failed whoami; read-only whoami; two concurrent recovery calls; old context failure after a new workspace/assistant succeeds; session-list failure then success; total budget exhaustion. Preserve standalone fixtures separately rather than updating them to require platform metadata.

A complete route-aware response fixture for the happy platform context is:

```ts
function contextResponse(input: RequestInfo | URL): Response {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const path = new URL(raw, "http://gateway.test").pathname;
  const bodies: Record<string, unknown> = {
    "/v1/whoami": { directory: "/ws/base", mode: "full" },
    "/api/me": { user: { id: "usr_fixture", username: "fixture", role: "user" } },
    "/api/runtime": { runtime: "opencode", kind: "opencode", available: [
      { runtime: "opencode", kind: "opencode", enabled: true, models: [], status: "ready" },
    ] },
  };
  return new Response(JSON.stringify(bodies[path] ?? {}), { status: 200 });
}
```

Use fake timers to assert at most four attempts and a 90-second total budget. A budget-expired old attempt may not close or mutate the winner. Assert no desktop `startRuntime`, `restartRuntime`, or server-side abort is called by Web restoration.

- [ ] **2. Run the red cases.**

```bash
pnpm test src/lib/runtime.store.test.ts src/lib/webMode.test.ts
```

Expected: invalid platform context currently appears connected or loses valid runtime metadata; deadline/owner assertions fail.

- [ ] **3. Separate response ownership and validate required reads.** Import `isPlatformWeb` into the store. Keep requests concurrent but replace the coupled metadata rejection with independently observed results. Check required response status and shape before constructing the client; use the existing runtime-option decoder only after checking runtime membership and compatible `kind`. Fail the current attempt for platform runtime/workspace failure. Account-read failure leaves verified account/role null. Preserve standalone-only legacy fallback.

Use a shared deadline calculation for every required context request:

```ts
const WEB_RECOVERY_BUDGET_MS = 90_000;
function remainingWebBudget(deadline: number): number {
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw new Error("AI assistant connection recovery timed out.");
  return remaining;
}
function webRequestSignal(owner: AbortSignal, deadline: number, ceiling: number): AbortSignal {
  return AbortSignal.any([
    owner,
    AbortSignal.timeout(Math.ceil(Math.min(ceiling, remainingWebBudget(deadline)))),
  ]);
}
```

Keep the five-second SDK stream deadline and clamp each attempt to remaining overall time. Request signals also cover body decoding; do not consider headers alone a successful context read. Abort obsolete request owners. Observe all rejected promises immediately.

- [ ] **4. Give Web recovery one context owner.** Add a Web-only context generation incremented by explicit workspace/assistant changes and disconnect, an attempt generation, and an in-flight owner containing the captured context generation, deadline, controller, and `Promise<boolean>`. Equal-context calls return that promise. Different-context calls abort the old owner before starting the new one. Capture the source client/attempt generation in status callbacks and required reads; apply a result only if both remain current. An old `finally` may clear only its own owner/timers.

Keep one-attempt connection work separate from the owner entry so retries do not recursively call their own in-flight promise. Route all Web `connect()`/`connectRetry()` entry calls through that owner while preserving desktop's one-attempt and long-retry paths. Add automatic retry only for required context/session failures; model branch failures never tear down a ready stream. Preserve SDK stream recovery and blip grace.

- [ ] **5. Run the focused suite and existing selection/failure regressions.**

```bash
pnpm test src/lib/runtime.store.test.ts src/lib/webMode.test.ts src/lib/runtime.test.ts
```

Expected: strict context tests and single-owner races pass; standalone, desktop, failed-authoritative-refresh and valid model-selection tests still pass. Commit reviewed Task 2 hunks only: `fix: restore Web runtime with validated owned recovery`.

## Task 3: Bound catalog transport and decouple model/history readiness

**Files:** `packages/sdk/src/OpenCodeClient.ts`, `packages/sdk/src/index.ts`, `apps/desktop/src/test/opencode-client.node.test.ts`, `runtime.ts`, `runtime.store.test.ts`.

- [ ] **1. Strengthen the deferred regressions.** Assert independently: models while agents/commands/skills are pending; commands/history while native providers are pending; foreground and background slash-command reconstruction waits for command templates only; model failure blocks sends but does not close SSE; retry restores models without re-reading already-successful commands; late earlier model failure does not invalidate a later success. Retain tests that reconcile a removed managed model only after a successful authoritative read.

- [ ] **2. Run the red suite.**

```bash
pnpm test src/lib/runtime.store.test.ts src/test/opencode-client.node.test.ts
```

Expected: current shared publication/history promise fails the independent-readiness assertions.

- [ ] **3a. Bound the five SDK catalog reads for Web callers.** Export `OpenCodeCatalogReadOptions` from the SDK client and index; add an optional argument to `listProviders`, `getDefaultModel`, `listCommands`, `listAgents`, and `listSkills`. Do not alter the common `AgentRuntime` interface or ACP signatures; Web's concrete `opencodeClient` performs these HTTP reads. Preserve the existing decoding in each method. Introduce a private `readCatalogJson<T>(path, what, options)` to replace only their fetch/body reads, with the existing direct behavior when options are absent. With options, compose owner cancellation and the requested deadline, clamp `timeoutMs` to the existing 15-second `requestTimeoutMs`, abort the transport, and keep timeout enforcement active until JSON/error decoding finishes. Race against cancellation so a body stall still settles, and remove listeners/timers in `finally`. Do not change SSE, writes, auth/provenance, or `fetchWithTimeout` semantics for unrelated methods.

```ts
export type OpenCodeCatalogReadOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};
```

Add real-response-body and signal-aware fetch tests: stalled headers, successful headers with stalled JSON body, pre-aborted owner, superseded owner, and ordinary no-options decode. Assert abort/deadline settlement, no default writes/dispose calls, and no timer/listener leak. Calls from the Web model/command/agent/skill branches pass the captured source controller and `Math.min(15000, remainingWebBudget(deadline))`. Non-Web calls keep their existing no-options behavior. Add this SDK suite to all Task 3 red/green commands. A timer that only bounds headers is insufficient.

- [ ] **3b. Split branches without changing the store's public catalog API.** Add `commandsInFlight: Promise<void> | null` and a model-load generation. The command branch owns `commands`, handles failure with the existing empty-command fallback, and clears only its own promise. Replace the two history waits with:

```ts
if (commandsInFlight && get().commands.length === 0) await commandsInFlight;
```

Make models publish through their own guarded branch as soon as native providers and default/reconciliation are known. Keep agents/skills as separately guarded background branches. `catalogInFlight` still joins the complete branch set for explicit `loadCatalog()` callers, but no history/login/model control awaits it. Keep existing empty-skill retries and model-switch grace. Preserve runtime-specific reconciliation and successful-only default healing; no model writes are added to failed reads.

- [ ] **4. Retry the authoritative model branch independently.** At most four reads with 250/500/1000-ms delays, clamped to the captured 90-second startup deadline; explicit later catalog refresh starts its own 90-second budget. Deduplicate same-source model loads. Treat switching/disconnect/new-source as cancellation, not an unavailable result for the winner. After genuine failure, use the existing unavailable catalog/send-blocking policy and retry action. A command failure must finish its promise rather than strand history.

- [ ] **5. Run focused history/selection regressions and commit.**

```bash
pnpm test src/lib/runtime.store.test.ts src/lib/historyGuard.test.ts src/lib/runtime.test.ts src/test/opencode-client.node.test.ts
```

Expected: history and native model readiness precede unrelated gates; command expansion, selected model, failed refresh and stale-response restrictions pass. Suggested commit: `fix: publish Web models and history independently`.

## Task 4: Make public Zen availability background-only in Web

**Files:** `zenModels.ts`, `zenModels.test.ts`, `webMode.ts`, `webMode.test.ts`, `runtime.ts`, `runtime.store.test.ts`.

- [ ] **1. Add failing availability cases.** Test deferred Zen while native providers resolve; no-Zen catalog causes zero requests; two Web calls share one request; cached success survives `vi.resetModules()` with retained `sessionStorage`; desktop still awaits its original lookup; unknown/failure never hides models. Exercise corrupted JSON, expired/future timestamps, wrong version, invalid/control-character IDs, 4097 IDs, storage throwing, three-second timeout, 30-second failure cooldown, logout/account/native-provider change, and late callback after source/model generation changes.

- [ ] **2. Extend gateway GET with an optional signal.** Keep all existing one-argument callers valid:

```ts
export async function gatewayGet<T>(path: string, options?: { signal?: AbortSignal }): Promise<T | null>
```

Forward only `options?.signal` alongside the existing token headers. Do not change POST or auth-guard handling. In the Web Zen fetch, pass a three-second signal and keep it active through response decoding. The promise must settle on timeout even in the deterministic fixture; the production request must also be aborted. Add a signal-forwarding test and preserve the existing explicit-session-expiry versus upstream-401 tests.

- [ ] **3. Add the validated public session cache.** Keep these names and schema identical in reader, writer, tests, and callers:

```ts
type ZenCacheRecord = { version: 1; fetchedAt: number; models: string[] };
const ZEN_CACHE_KEY = "scikeel.zen.models.v1";
const ZEN_SUCCESS_TTL_MS = 10 * 60 * 1000;
const ZEN_FAILURE_TTL_MS = 30_000;
function validZenCache(value: unknown, now: number): value is ZenCacheRecord {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ZenCacheRecord>;
  return candidate.version === 1 && typeof candidate.fetchedAt === "number" &&
    Number.isFinite(candidate.fetchedAt) && candidate.fetchedAt <= now &&
    now - candidate.fetchedAt < ZEN_SUCCESS_TTL_MS && Array.isArray(candidate.models) &&
    candidate.models.length > 0 && candidate.models.length <= 4096 &&
    candidate.models.every(id => typeof id === "string" && id.length > 0 &&
      id.length <= 160 && !/[\x00-\x1f\x7f]/.test(id));
}
```

Read/write only successful public IDs; catch storage exceptions; treat invalid records as a miss. Deduplicate IDs. `resetZenModelCache()` keeps deterministic page-memory reset semantics; tests explicitly clear session storage when they require a cold public cache. Failure cooldown is page memory only. Cached IDs cannot create providers or models.

- [ ] **4. Add the Web enrichment callback contract.** Extend the existing helper with an optional callback:

```ts
export type AvailabilityUpdate = (providers: ProviderInfo[]) => void;
export async function listProvidersWithAvailability(
  client: Pick<OpenCodeClient, "listProviders">,
  onAvailability?: AvailabilityUpdate,
  readOptions?: OpenCodeCatalogReadOptions,
): Promise<ProviderInfo[]>
```

Import `OpenCodeCatalogReadOptions` from the SDK; in Web, await only `client.listProviders(readOptions)`. The third argument forwards Task 3 cancellation/deadline options; desktop callers omit it. If it lacks `opencode`, return directly. Apply a fresh validated cached advisory synchronously; otherwise return unknown availability. Start/deduplicate `zenServedModels()` in the background and notify only when a valid, overlapping result changes an availability annotation. Catch lookup/callback errors to prevent an unhandled rejection. Preserve awaited behavior outside Web. All store Web callers provide a callback with client, assistant, connection generation, and model-load generation guards; it updates only availability/view state, never calls `setDefaultModel` or rewrites session model overrides.

- [ ] **5. Enforce explicit selection after retirement.** In `reconcileGatewayModels()`, distinguish native identity membership from selectable choices for OpenCode: an existing native model marked unavailable by an advisory remains the saved default/session selection until the user changes it; only a model actually absent from the successful native catalog is eligible for existing removal reconciliation. Add a cold-load test with a cached advisory retiring the saved default, as well as a late-advisory test, so cache reuse cannot silently select a paid alternative. Apply `webModelChoices()` membership to OpenCode as well as managed CLIs in both existing send guards. Capture the chosen model before a turn and recheck immediately before dispatch. A late retired model requires user selection and cannot silently become a paid/default model. Preserve strict unavailable-authoritative-catalog send blocking.

- [ ] **6. Run and commit the focused regression set.**

```bash
pnpm test src/lib/zenModels.test.ts src/lib/webMode.test.ts src/lib/runtime.store.test.ts src/lib/webModelCatalog.test.ts
```

Expected: no Web caller waits on Zen; cache validation/account isolation and desktop semantics pass. Suggested commit: `fix: enrich Web Zen models without blocking readiness`.

## Task 5: Wire automatic browser recovery and usable login/model controls

**Files:** `AppShell.tsx`, new `AppShell.webRecovery.test.tsx`, `SessionView.tsx`, `SessionView.launch.test.tsx`, `SettingsPage.tsx`, `WebModelPicker.tsx` and new test, `loginPreparation.ts` and test.

- [ ] **1. Add UI and event tests.** Simulate online/visibility bursts while errored, while connecting, while ready, and during a login redirect. Assert one owned recovery, no healthy-tab re-fetch, a five-second event cooldown, and listener/timer cleanup on unmount. A manual Web retry joins the same recovery. Verify a ready/limited verified model releases fresh-login preparation; model errors offer catalog retry without stream teardown; normal reload has no preparation overlay. A retired selected model remains explicit and sends disabled.

- [ ] **2. Use the owner's entry for Web retry actions.** Switch existing SessionView/Settings Web Connect callbacks to `connectRetry()`; retain desktop's appropriate existing behavior. Shell `online` and visible-tab handlers call that same owner only when failed/offline and not already recovering. Use `performance.now()` for the five-second event cooldown, and remove listeners on cleanup. Do not create an interval or compete with a connecting SDK stream.

- [ ] **3. Change usable-catalog handoff.** Replace only the successful readiness condition with:

```ts
const usableCatalog = state.gatewayCatalogState === "ready" ||
  state.gatewayCatalogState === "limited";
if (state.status === "ready" && state.sessionListReady && usableCatalog && state.defaultModel) {
  finish("scikeel:login-ready");
}
```

Keep explicit failure, cleanup, the existing 90-second preparation bound, and the no-marker no-op. The runtime branch must already have verified the model's presence before marking the catalog usable. Optional enrichment has no handoff state dependency.

- [ ] **4. Run focused UI/language checks.**

```bash
pnpm test src/app/layout/AppShell.webRecovery.test.tsx src/components/session/SessionView.launch.test.tsx src/components/thread/WebModelPicker.test.tsx src/lib/loginPreparation.test.ts src/app/routes/SettingsPage.web.test.tsx src/i18n/parity.test.ts
```

Expected: correct automatic/manual retry behavior, usable limited catalogs, failed model disablement and existing localized controls. If new text is necessary, add all locale keys in this task and re-run parity. Commit reviewed UI hunks: `fix: complete Web recovery and login handoff automatically`.

## Task 6: Require exact-bundle browser acceptance and guarded release checks

**Files:** New `webRuntimeRecovery.acceptance.test.mjs`; `scripts/dev/web-release.mjs`, `scripts/dev/web-release.test.mjs`; existing refresh/login/continuity tests remain intact.

- [ ] **1. Add the staged-browser scenario.** Follow the local HTTP-fixture and `createRequire(import.meta.url)(process.env.OSD_PLAYWRIGHT_PATH)` pattern in `webRefresh.acceptance.test.mjs`. Serve `OSD_WEB_CANDIDATE`, inject both Web flags, and use recorded monotonic response/control-ready times. In English and Chinese at 1280, 390 and 320 pixels, serve native model/default/messages/commands within 100 ms, open SSE at 700 ms, and hold Zen/agents/skills for six seconds. Assert models and history usable before three seconds and before optional completion, zero page errors/overflow, valid selection after repeated reloads, and no Connect click/stop/restart request.

Add isolated scenarios for transient required-context/session failure, catalog-only retry, read-only context, valid/expired public cache, stale callbacks after switch, command expansion, login limited-catalog handoff, and ongoing turn continuity including Stop. Use mock models and deterministic events; no Claude endpoint or alternative model probes. Close browsers, timers, sockets and streams in `finally` blocks.

- [ ] **2. Register acceptance unconditionally for session verification.** Current `browserStage()` chooses continuity *or* refresh, so adding a test alone is insufficient. When `groups.includes("session")`, require the new recovery file, add it to `tests`, and set `environment.OSD_RECOVERY_ACCEPTANCE = "1"`. Preserve continuity/refresh coverage and add the recovery test even when continuity exists. Missing browser configuration, missing recovery file, or a skipped required scenario must fail preparation. Extend release workflow fixtures to assert this registration and fail-on-skip behavior.

The registration fragment is:

```js
const recovery = 'src/test/webRuntimeRecovery.acceptance.test.mjs';
if (!await lstat(join(desktop, recovery)).catch(() => null)) {
  throw new Error('Required Web runtime recovery scenario is unavailable');
}
tests.push(recovery);
environment.OSD_RECOVERY_ACCEPTANCE = '1';
```

- [ ] **3. Run guarded checks in sequence.**

```bash
pnpm release:test
pnpm test
pnpm platform:test
pnpm typecheck
pnpm lint
pnpm web:release prepare --source "$task_checkout"
```

Here `task_checkout` is the absolute checkout created and verified in Task 1; set it once to that concrete directory. Release preparation builds one staged bundle and runs configured browser scenarios against it, under existing shared locks/cgroup limits. Confirm the recovery scenario executed rather than skipped. Because `runtime.ts` affects live behavior, accept the existing conservative selection and required non-Claude live checks; do not weaken the selector or skip required verification to save time. Record test counts, timing, candidate/source/asset hashes, and failures without secrets. Before/after browser comparison must use equivalent deterministic fixtures.

- [ ] **4. Verify image/source and host safety.** Confirm changed paths are the reviewed frontend/release-check paths; source/image identity must still match the current baseline and require no new scientific image. If image inputs or backend prerequisites changed, stop and revise scope. A failed guarded build does not replace live assets; no direct Vite/Vitest/Cargo or parallel heavy jobs are permitted. Suggested commit: `test: require Web refresh recovery acceptance`.

## Task 7: Publish the verified candidate and confirm the user's outcome

**Files:** Existing release manifest/verification artifacts and `PROGRESS.md` only.

- [ ] **1. Publish only after plan approval and successful preparation.** The approval to implement this plan authorizes its described Web publication; any later user deployment restriction takes precedence. Use the exact successful candidate's ID, never a rebuild or the dirty main source:

```bash
pnpm web:release deploy --release "$task_release_id"
```

Set `task_release_id` from the successful preparation manifest. Confirm effective source/Web hashes, current release identity and health. This design needs no worker restart or scientific image replacement. Use the release workflow's verified rollback if publication/health/required acceptance fails; report rollback failure explicitly.

- [ ] **2. Validate production recovery.** Use the existing authorized test account/session without copying credentials into artifacts. Verify five warm reloads, an existing conversation's correct model/workspace, and one non-Claude OpenCode continuity scenario across reload with Stop functional. Use a temporary acceptance session only if a real turn is necessary; preserve original conversations/files and do not delete verification/user data automatically. Do not simulate outages by altering unrelated services. Report monotonic median/max reload timings and a trace proving optional enrichment is outside readiness. Separate cold-worker startup from warm reload measurements.

- [ ] **3. Record actual results and limitations.** Prepend one dated English milestone to `PROGRESS.md`, newest first. Final report identifies published candidate/source/assets, tests, observed timing, preserved user data, and any unreproduced original failure. No improvement or completion claim is made unless automatic restoration and model/history readiness were actually verified.

## 2. Coverage and self-review

| Spec | Plan coverage |
| --- | --- |
| R1 automatic connection and ownership | Tasks 1, 2, 5, 6, 7 |
| R2 required context and standalone fallback | Task 2; Tasks 5/6 auth/read-only regressions |
| R3 total deadline, independent catalog retry, event recovery | Tasks 2, 3, 5, 6 |
| R4 independent catalog/history branches | Tasks 1, 3, 6 |
| R5 optional public cache, timeout, retired choice, late updates | Task 4; Tasks 5/6 |
| R6 login and truthful localized controls | Tasks 3, 5, 6 |
| R7 auth/state/model/platform boundaries | Tasks 2, 4, 5, 6, 7 |
| R8 evidence, exact bundle, bounded release and rollback | Tasks 1, 6, 7 |

Self-review checked task ordering, current file names, gateway/helper signatures including the SDK read-options argument, shared worktree locks, complete-response deadlines, cache schema consistency, command promise behavior, competing recovery cancellation, authoritative failure/send rules, no new live Claude probes, and mandatory release registration. Browser acceptance must not disappear behind the existing continuity-or-refresh branch. All execution checkboxes remain unchecked. This plan and the spec await the user's approval.
