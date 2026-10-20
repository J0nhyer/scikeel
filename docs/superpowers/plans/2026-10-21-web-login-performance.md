# Web Login Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make valid Web login reach a genuinely usable workbench within 3,000 ms when capacity is available, including idle cold workspaces, while preserving historical conversations, account isolation, running tasks, and host resource limits.

**Architecture:** Overlap public asset loading, authenticated indexed metadata reads, and selected-runtime workspace preparation. Introduce a durable summary catalog maintained through source-owned outboxes, start managed Codex environments without OpenCode, and separate at most two bounded resident environments from one executing job. Keep frontend readiness dependent on verified metadata, capabilities, workspace health, and event acknowledgement.

**Tech Stack:** Existing React/TypeScript/Vite Web client, `@ai4s/sdk`, Node platform services, existing `better-sqlite3@12.9.0` in a worker thread, Rust headless gateway/sandbox host, systemd cgroup v2, existing guarded test/release scripts.

---

## Execution boundary and baseline

Specification: [Web Login and Workspace Readiness](../specs/2026-10-21-web-login-performance-design.md).

This plan covers one integrated login path. Its tasks are ordered to keep each
change testable, and every mandatory gate belongs to the same finished release.
Writing this plan does not enable any proposed behavior in production.

Use `superpowers:using-git-worktrees` when execution begins. Read the then-current
`AGENTS.md` and invoked skills. Inspect the published platform process working
directory, frontend release manifest, and compatible source revision. The known
compatible baseline is `c05c4246950bbccc658ab4379ae1fa1b0935c6ce`; the frozen
frontend investigated was `2026-10-20T16-36-20-943Z-5932f252`. A newer verified
published baseline takes precedence. Preserve concurrent login-transition changes
from `.worktrees/web-auth-transitions-20261021`; do not edit that worktree or a
frozen served release. The modified main checkout is not an execution baseline.

Use manual file patches for edits. Never use Git to restore files. Commit only
the task's reviewed files inside the new execution worktree. Do not push.

Before any test, create an ignored, short-path scratch directory in that worktree:

```bash
mkdir -p .deploy/t
export TMPDIR="$PWD/.deploy/t"
export TMP="$TMPDIR"
export TEMP="$TMPDIR"
git check-ignore .deploy/t
```

Verify that child processes inherit these variables. Any fixture that explicitly
chooses a system temporary directory must be changed to honor this directory.
Keep short Unix-socket paths. All commands below run from the execution worktree
root, sequentially, through package scripts. A busy host lock requires scheduling
the protected operation after preserving active state; it never permits an
unguarded retry.

## File ownership and new boundaries

| Responsibility | Files |
| --- | --- |
| Catalog contract, SQL and worker RPC | New `services/platform/src/workspace-catalog.mjs`, `workspace-catalog-worker.mjs`, `workspace-catalog-schema.mjs` |
| Durable projection coordination | New `services/platform/src/catalog-outbox.mjs`; existing `conversation-state.mjs`, `workspace-state.mjs`, `cli-runtime.mjs` |
| Migration and reconciliation | New `services/platform/src/workspace-catalog-import.mjs`, `scripts/dev/migrate-workspace-catalog.mjs`; existing conversation/source adapters |
| Bootstrap service and routes | New `services/platform/src/workspace-bootstrap.mjs`; existing `platform-server.mjs`, `main.mjs` |
| Event readiness and change delivery | Existing `cli-runtime.mjs`, `platform-server.mjs`; the bootstrap service publishes context notifications |
| SDK transport/types | New `packages/sdk/src/GatewayBootstrapClient.ts`, `gatewayBootstrap.ts`; existing `index.ts` |
| Managed headless startup | Existing `runtime/sandbox/runner.mjs`, `crates/osd-cli/src/main.rs`, `server.rs`, `crates/osd-core/src/gateway.rs`, `runtime.rs` |
| Infrastructure/configuration sequencing | Existing `crates/osd-sandbox-host/src/backend.rs`, `services/platform/src/sandbox-control-plane.mjs`, `managed-worker-manager.mjs` |
| Aggregate limits and capacity | Existing `crates/osd-sandbox-host/src/lifecycle.rs`, `backend.rs`, `services/platform/src/host-admission.mjs`, `sandbox-scheduler.mjs`, `sandbox-native-jobs.mjs`, `managed-worker-manager.mjs` |
| Essential assets | Existing `apps/desktop/vite.config.ts`, `src/app/router.tsx`, `services/platform/src/login-page.mjs`; new `services/platform/src/login-assets.mjs` |
| Frontend startup state | New `apps/desktop/src/lib/runtime.bootstrap.ts`; existing `runtime.ts`, `loginPreparation.ts`, `webMode.ts`, `SessionView.tsx`, `AppShell.tsx` |
| Measurement/acceptance | New `apps/desktop/src/lib/loginTiming.ts`, `services/platform/test/web-login-performance.live.acceptance.mjs`; guarded scripts and release tests |

All `services/platform/src/` references in this table are relative to the same
directory. All frontend paths below are explicit where ambiguity is possible.
The existing large runtime and platform modules keep their current responsibilities;
new focused modules isolate catalog/bootstrap behavior without an unrelated rewrite.

## Shared contracts

Define these names before using them in tasks. Server code validates the same
wire representation; the SDK exports the TypeScript types and validates responses.

```ts
type Page<T> = { items: T[]; nextCursor: string | null; revision: number };
type ProjectSummary = {
  id: string; directoryRef: string; name: string;
  lifecycle: "active" | "trashed"; sourceRevision: number;
};
type ConversationSummary = {
  id: string; projectId: string | null; directoryRef: string; title: string;
  parentId: string | null; runtime: "codex" | "opencode" | "claude";
  lifecycle: "active" | "archived" | "trashed";
  updatedAt: number; sourceRef: string; sourceRevision: number;
};
type CatalogChange = {
  changeId: string; userId: string;
  source: "canonical" | "workspace" | "cli"; sourceKey: string;
  sourceRevision: number;
  projectUpserts: ProjectSummary[]; conversationUpserts: ConversationSummary[];
  projectTombstones: string[]; conversationTombstones: string[];
};
type Bootstrap = {
  schema: 1; account: { id: string; displayName: string };
  policyRevision: number;
  assistant: {
    runtime: "codex" | "opencode" | "claude"; label: string;
    enabled: boolean; defaultModel: string | null;
    capabilities: { prompt: boolean; files: boolean };
  };
  catalog: { state: "ready"; revision: number };
  projects: Page<ProjectSummary>; conversations: Page<ConversationSummary>;
  workspace: WorkspaceReport;
};
```

`WorkspaceReport` is the existing SDK report type; its usable state is `healthy`.
Recovering or unavailable
catalog responses use an HTTP 503 error with a typed catalog reason and current
workspace report; they do not return fabricated pages. `CatalogChange.sourceKey`
is an internal source identity. Public summaries expose only an opaque source
reference if needed; never serialize internal absolute filesystem paths.

Server modules expose these exact interfaces:

```ts
WorkspaceCatalog.open({ path, maxPending: 32 }): Promise<WorkspaceCatalog>;
catalog.apply(change: CatalogChange): Promise<{ revision: number }>;
catalog.snapshot(userId: string, { limit: number }): Promise<{
  projects: Page<ProjectSummary>; conversations: Page<ConversationSummary>;
  revision: number;
}>;
catalog.listConversations(userId: string, { limit, cursor, directoryRef, lifecycle }): Promise<Page<ConversationSummary>>;
catalog.listProjects(userId: string, { limit, cursor }): Promise<Page<ProjectSummary>>;
catalog.close(): Promise<void>;
CatalogProjector.drain(userId: string): Promise<void>;
WorkspaceCatalogImporter.run({ userIds, resume: boolean, verifyOnly: boolean }): Promise<ImportReport>;
WorkspaceBootstrap.read(user, { limit, signal }): Promise<Bootstrap>;
WorkspaceBootstrap.prepare(user): Promise<WorkspaceReport>;
```

`ImportReport` contains owner/source counts, id/reference digests, final source
revisions, checkpoint state, pending-change count, and `verified: boolean`; it
contains no transcript or secret data. Cursor arguments default to null, a limit
of 50, active lifecycle, and no directory filter. The catalog constructor receives
a validated cursor-signing key from private platform configuration. No caller can
select an account through a query parameter.

## Task 1: Lock the baseline and add honest timing

**Files:**

- Create `apps/desktop/src/lib/loginTiming.ts` and `loginTiming.test.ts`.
- Modify `services/platform/src/login-page.mjs`, `platform-server.mjs`.
- Modify `apps/desktop/src/lib/loginPreparation.ts`.
- Add `services/platform/test/login-timing.test.mjs`.

- [ ] Inspect the published source and concurrent authentication work. Create the isolated execution checkout, prepare scratch paths, and record baseline hashes in ignored acceptance artifacts. Preserve existing login events, logout cleanup and preparation attributes.
- [ ] Add tests proving that the attempt starts on submit, continues across the existing redirect using the current pending timestamp mechanism, finishes once, rejects another account epoch, and contains no credentials. Use real `performance.now()` semantics with a controllable clock:

```ts
const timing = createLoginTiming({ attemptId: "attempt-1", submittedAt: 1000 });
timing.mark("authCommitted", 1100);
timing.mark("workspaceReady", 2500);
expect(timing.finish(3100).durationMs).toBe(2100);
expect(() => timing.finish(3200)).toThrow("login_timing_finished");
```

- [ ] Run red: `pnpm --filter @ai4s/desktop test src/lib/loginTiming.test.ts`. Expect the missing timing module/API to fail. Record the actual failure.
- [ ] Implement `createLoginTiming({attemptId, submittedAt})` with `mark(name, now)` and `finish(now)`, bounded serializable stage data, validated monotonic timestamps, and a single completion guard. Use `performance.timeOrigin + performance.now()` across same-origin navigation. The server records `authCommitted` separately with request correlation; calculate browser totals entirely from browser timestamps. Preserve the existing timestamp across navigation and clear it after logout/completion.
- [ ] Run green with the same frontend command and `pnpm platform:test test/login-timing.test.mjs`. Confirm malformed or expired pending timestamps cannot fabricate a fast result. Commit only the timing files and touched integration points.

## Task 2: Implement the durable indexed catalog

**Files:**

- Create `services/platform/src/workspace-catalog.mjs`, `workspace-catalog-worker.mjs`, `workspace-catalog-schema.mjs`.
- Create `services/platform/test/workspace-catalog.test.mjs`.
- Reuse existing `services/platform/package.json` dependency; keep its pinned version.

- [ ] Write database tests using real named SQLite files under `TMPDIR`. Insert two owners, 100 projects, 10,000 conversations, tied timestamps, archived rows, and malicious cursor/filter inputs. Verify owner isolation, stable paging, revision invalidation and a verified empty account.

```js
const first = await catalog.listConversations("alice", {limit: 50});
const second = await catalog.listConversations("alice", {limit: 50, cursor: first.nextCursor});
assert.equal(first.items.length, 50);
assert.equal(new Set([...first.items, ...second.items].map(row => row.id)).size, 100);
await assert.rejects(catalog.listConversations("bob", {limit: 50, cursor: first.nextCursor}),
  error => error.code === "invalid_catalog_cursor");
```

- [ ] Run red: `pnpm platform:test test/workspace-catalog.test.mjs`; expect missing catalog exports.
- [ ] Create the schema and worker. Open exactly one named database connection; configure the pragmas in the specification, 64 MiB worker heap, 32 pending RPC operations, 50 ms busy timeout, and bounded results. Implement owner-bound prepared statements and synchronous SQL transactions. Do not copy telemetry's dropped-write policy.

```sql
CREATE INDEX conversations_recent ON conversations
  (user_id, lifecycle, updated_at DESC, id DESC);
CREATE INDEX conversations_directory_recent ON conversations
  (user_id, directory_ref, lifecycle, updated_at DESC, id DESC);
```

Use keyset pagination with owner, lifecycle, optional directory, and
`(updated_at < @time OR (updated_at = @time AND id < @id))`. Sign JSON cursor
payloads with Node crypto and validate owner, filters and catalog revision before
executing the statement. Parse JSON with `JSON.parse`, never a custom parser.

- [ ] Implement `apply()` as one transaction: validate change and hash, reject conflicting receipts, upsert/tombstone owned rows, increment account revision, write the receipt. Preserve source precedence: a canonical binding owns its public conversation id; duplicate native sources contribute references to that row without creating a second conversation. Import rejects conflicting owners/origins.
- [ ] Run green with the same command. Assert query plans use the two indexes, first-page results stay bounded, duplicate changes do not increment revision twice, corrupt storage fails explicitly, and queue overflow returns `catalog_busy` without lost writes. Commit this catalog unit.

## Task 3: Make source mutations project reliably

**Files:**

- Create `services/platform/src/catalog-outbox.mjs`.
- Modify `services/platform/src/conversation-state.mjs`, `workspace-state.mjs`, `cli-runtime.mjs`.
- Create `services/platform/test/catalog-outbox.test.mjs`.
- Extend `conversation-state.test.mjs`, `workspace-state.test.mjs`, `cli-runtime-history-concurrency.test.mjs` in that test directory.

- [ ] Write tests that interrupt after each durable boundary: source replacement, SQL projection, and source acknowledgement. Restart the actual stores and catalog for each case. Verify exactly one metadata effect, preserved user events, no repeated prompt/tool execution, and blocked success while projection is unavailable.

```js
await source.commitMetadataChange(change, {interruptAt: "sourceCommitted"});
await projector.drain("alice");
await projector.drain("alice");
assert.equal((await catalog.snapshot("alice", {limit: 50})).revision, 1);
assert.equal(await source.pendingCatalogChanges("alice").then(rows => rows.length), 0);
assert.equal(nativePromptCalls.length, 0);
```

Expose interruption hooks only through test-injected storage hooks, never through
HTTP flags. `commitMetadataChange()` above is the test fixture's real source writer
wrapper, not a new production store abstraction.

- [ ] Run red: `pnpm platform:test test/catalog-outbox.test.mjs test/conversation-state.test.mjs test/workspace-state.test.mjs test/cli-runtime-history-concurrency.test.mjs`.
- [ ] Upgrade readers for canonical schema 3, workspace schema 2, and CLI history version 2 before emitting the new fields. Source envelopes add `catalogRevision: number` and `catalogOutbox: CatalogChange[]`. Support validated legacy reads; write upgraded envelopes through existing durable file replacement and directory synchronization.
- [ ] In each source's existing serialized writer, add one validated change to the same file transaction as the metadata mutation. Add `pendingCatalogChanges(userId)` and `acknowledgeCatalogChange(userId, changeId, payloadHash)` to the source adapters. Implement the projector with explicit ordering:

```js
for (const entry of await source.pendingCatalogChanges(userId)) {
  await catalog.apply(entry);
  await source.acknowledgeCatalogChange(userId, entry.changeId, digest(entry));
}
```

Use the catalog module's exported canonical `digest(change)` for both projection
and acknowledgement. `CatalogProjector` takes the three source adapters in its
constructor and drains them under a per-account queue. Source revisions are
monotonic per `sourceKey`; acknowledgement never erases later entries. The
source's existing atomic writer owns the entire operation. Reads wait behind
pending projection; a failed projection is reported and never acknowledged.

- [ ] Enforce the 1,024-entry outbox bound and existing byte limits before side effects. Run green, including concurrent writes and schema migration regressions. Commit source/projector changes together.

## Task 4: Cover lifecycle operations and import every retained source

**Files:**

- Create `services/platform/src/workspace-catalog-import.mjs`.
- Modify `services/platform/src/workspace-management.mjs`, `conversation-router.mjs`, `opencode-conversation.mjs`, `cli-runtime.mjs`, `workspace-state.mjs`.
- Create `services/platform/test/workspace-catalog-import.test.mjs`, `workspace-catalog-lifecycle.test.mjs`.
- Create `scripts/dev/migrate-workspace-catalog.mjs`.
- Modify `scripts/dev/safe-desktop-task.mjs`, `services/platform/package.json`.
- Create `scripts/dev/safe-desktop-task.test.mjs`.

- [ ] Add real-store tests for project create/rename/trash/restore/conflict restore/delete, conversation create/rename/archive/delete/fork/handover, and accepted/completed turn timestamps. Verify the resulting summaries, source references and owned directory mappings. Existing metadata operations must await projection before returning successful receipts.
- [ ] Add import tests for canonical and legacy CLI branches, active/archived OpenCode, nested project roots, parent chains, conflicting origins, interrupted pages, changed source revisions, and incomplete accounts. Import fixtures use existing source validators rather than handwritten JSON interpretation.

```js
const report = await importer.run({userIds: ["alice"], resume: true, verifyOnly: false});
assert.equal(report.verified, true);
assert.deepEqual(report.sources.map(row => row.sourceDigest), expectedOwnedDigests);
assert.equal(report.pendingChanges, 0);
```

- [ ] Run red: `pnpm platform:test test/workspace-catalog-import.test.mjs test/workspace-catalog-lifecycle.test.mjs`.
- [ ] Implement import with fenced writers, bounded provider pages and source revision checkpoints. Read each account/source once per import pass; import metadata, not transcript copies. Resolve canonical/native duplicates with the existing bindings. Store both count and stable id/reference-set digests. Refuse finalization if any source is unreadable, changed or inconsistent. Do not start Claude.
- [ ] Implement OpenCode event-to-summary projection with a durable provider checkpoint, duplicate event handling and source revision reconciliation. On lost synchronization, mark the affected catalog recovering before subsequent successful listing. Native source discovery is scheduled once per affected account/revision and coalesced; it never reappears in the bootstrap read path.
- [ ] Register `catalog-migrate` as a fixed guarded mode and package script `catalog:migrate` accepting only `--verify` or `--apply --resume`. The script operates on configured private platform state, writes its report under `.deploy`, and requires publication protection and fenced writers. Its driver calls `WorkspaceCatalogImporter.run()`; it never replays user operations.
- [ ] Create `scripts/dev/safe-desktop-task.test.mjs` for fixed migration-mode and resource-guard coverage. Run green, plus `pnpm release:test scripts/dev/safe-desktop-task.test.mjs`. Run `pnpm --filter @ai4s/platform catalog:migrate --verify` only against isolated test state during implementation. Commit lifecycle/import changes.

## Task 5: Add account bootstrap and acknowledged context events

**Files:**

- Create `services/platform/src/workspace-bootstrap.mjs`.
- Modify `services/platform/src/platform-server.mjs`, `main.mjs`, `cli-runtime.mjs`.
- Create `services/platform/test/workspace-bootstrap.test.mjs`.
- Extend `services/platform/test/workspace-platform.test.mjs`.

- [ ] Add tests for unauthenticated denial, independent metadata with a deliberately pending worker, local policy capabilities, one preparation across HTML/JSON login and two tabs, project/conversation pagination, event acknowledgement and stale generations.

```js
const login = await fixture.login("alice");
const response = await fixture.get("/api/me/bootstrap?limit=50", login.cookie);
assert.equal(response.status, 200);
assert.equal(response.body.assistant.runtime, "codex");
assert.equal(fixture.workerStarts, 1);
assert.equal(fixture.historyScans, 0);
assert.equal(fixture.providerInventoryCalls, 0);
assert.equal(response.body.workspace.state, "starting");
```

The test fixture uses a pending infrastructure promise and the real catalog.
Use `starting` for initialization and `healthy` for a verified usable workspace,
matching the existing report validator.

- [ ] Run red: `pnpm platform:test test/workspace-bootstrap.test.mjs test/workspace-platform.test.mjs`.
- [ ] Wire catalog/projector startup into `main.mjs`: validate storage, drain known pending entries once, and expose per-account readiness before serving verified snapshots. Read metadata under the per-account mutation/projection queue. Return `503 catalog_recovering`, `catalog_unavailable`, or `catalog_busy` explicitly when applicable.
- [ ] Register the three authenticated bootstrap routes, bounded limits, signed continuation cursors, no-store headers, request cancellation and existing owner checks. Both successful login variants invoke the same coalesced manager preparation operation without awaiting completion. Derive minimal model/capability fields from current managed policy, with no remote inventory request.
- [ ] Extend existing platform-owned `/event` delivery with `workspace.bootstrap` acknowledgement and `workspace.changed`/`catalog.changed` frames carrying owner/context/revision. Route the authenticated managed account subscription before worker acquisition so it can observe preparation. Send the current authorized snapshot on subscribe, then ordered changes. Remove the subscription's `ensureUser()` full-history initialization; initialize authenticated event delivery independently and load histories only for selected transcript/native operations. The ready predicate uses the frame's context; stale generation streams are revoked using the existing mechanism. One active account stream carries both these and existing CLI agent events.
- [ ] Run green and existing authenticated routing tests. Verify no API calls `listOpenCode`, project filesystem discovery or full history listing to answer bootstrap. Commit the service/API unit.

## Task 6: Start a managed gateway without mandatory OpenCode

**Files:**

- Modify `crates/osd-cli/src/main.rs`, `server.rs`.
- Modify `crates/osd-core/src/gateway.rs`, `runtime.rs`.
- Add tests in the existing Rust test modules and `services/platform/test/managed-runtime-readiness.test.mjs`.
- Modify `runtime/sandbox/runner.mjs`.

- [ ] Write Rust tests for default eager startup, explicit managed on-demand startup, workspace API availability with no runtime process, and a coalesced explicit OpenCode start. Add runner tests that assert unconfigured jobs are refused, equal profiles do not restart, and changed policy cannot bypass mutation admission.
- [ ] Run red sequentially:

```bash
pnpm exec node scripts/dev/safe-desktop-task.mjs core-test --package osd-cli
pnpm exec node scripts/dev/safe-desktop-task.mjs core-test --package osd-core
pnpm platform:test test/managed-runtime-readiness.test.mjs
```

- [ ] Add a validated `--runtime-mode=on-demand` managed flag. Preserve the existing eager default. Make the `server.rs` lifetime hold an optional OpenCode child; shutdown always cleans up whichever child was actually started. The workspace HTTP API starts independently.

```rust
match runtime_mode {
    RuntimeMode::Eager => { runtime::start_runtime(&env)?; }
    RuntimeMode::OnDemand => {}
}
```

Define `RuntimeMode` in the CLI argument module and pass it explicitly to the
server entrypoint. The on-demand OpenCode lifecycle is held in the existing
runtime state, serializes startup and reports failure; callers of `endpoint()`
must await/require its readiness. Preserve configured sidecar version, permission
guards and standalone proxy behavior. Audit every `endpoint()` caller in
`gateway.rs`, especially events and OpenCode-dependent project/session handlers.
Workspace file routes cannot inherit an implicit OpenCode dependency.

- [ ] Remove the runner's initial unconfigured gateway start. Listen on its authenticated control endpoint immediately, report `configured=false`, and refuse jobs until the authenticated profile install completes. Install the profile, start the managed on-demand gateway once, then report selected-runtime capabilities. Cache the installed profile digest with context; equal repeats share the pending/result promise. Credentials stay in the existing private profile channel.
- [ ] Run green with all three commands. Assert Codex readiness performs zero OpenCode health/session/inventory requests. Selected OpenCode tests must still wait for its real readiness; deterministic Claude compatibility tests do not call the live service. Commit runtime readiness changes.

## Task 7: Sequence infrastructure and configuration once

**Files:**

- Modify `crates/osd-sandbox-host/src/backend.rs`.
- Modify `services/platform/src/sandbox-control-plane.mjs`, `sandbox-client.mjs`, `managed-worker-manager.mjs`.
- Extend `services/platform/test/sandbox-control-plane.test.mjs`, `sandbox-client.test.mjs`, `managed-worker-manager.test.mjs`.

- [ ] Add tests for host-start infrastructure liveness before profile install, one configuration/start per generation, selected-runtime health, failed profile installation, cancellation, and concurrent ensure calls.

```js
await Promise.all([manager.ensureWorker(context), manager.ensureWorker(context)]);
assert.equal(hostStarts.length, 1);
assert.equal(profilePosts.length, 1);
assert.equal(openCodeSessionProbes.length, 0);
assert.equal((await manager.workspaceStatus(context)).state, "healthy");
```

`context` contains `instanceId`, `userId`, and `allowRecovery: true`. The arrays
observe real injected boundary calls.

- [ ] Run red: `pnpm platform:test test/sandbox-control-plane.test.mjs test/sandbox-client.test.mjs test/managed-worker-manager.test.mjs` and the guarded `osd-sandbox-host` Rust package tests.
- [ ] Make host start verify the isolated runner control endpoint and pinned image identity. Keep configuration-pending distinct from usable workspace state. The manager performs authenticated profile installation, then verifies gateway file API and selected native runner capabilities, and only then publishes ready. Replace unconditional `waitManagedRuntime()` OpenCode session polling and status probes with the typed selected-runtime health report. Apply the same selected-runtime distinction to `assistantInventory()` and idle/handoff inspection; Codex must not become uncertain merely because OpenCode is absent.
- [ ] Keep deadlines and abort propagation at each boundary; failed configuration produces a concrete failed state. One account's request cancellation cannot terminate another tab's accepted job. Validate strict host response schemas and prohibit provider secrets in host start arguments.
- [ ] Run green and inspect the startup call trace: register/start once, configure once, selected-runtime verification once, ready once. Commit sequencing changes.

## Task 8: Enforce an aggregate tenant resource ceiling

**Files:**

- Modify `crates/osd-sandbox-host/src/lifecycle.rs`, `backend.rs`.
- Create `runtime/sandbox/system-scikeel-workspaces.slice`, embedded by the sandbox host at build time.
- Extend `services/platform/test/host-admission.test.mjs` and Rust lifecycle tests.
- Create `scripts/dev/sandbox-host-resources.test.mjs` for the fixed slice definition and release inclusion.

- [ ] Embed the reviewed fixed slice definition into the sandbox-host binary. Its privileged `ensure_tenant_slice()` helper writes only that exact definition under `/run/systemd/system`, using existing root-owned directory/file checks and atomic replacement, then invokes fixed `systemctl daemon-reload` and `start` commands when required. Verify effective limits before returning. No caller-supplied content or unit arguments are accepted.
- [ ] Write failing tests for the exact aggregate parent name and fixed properties, descendant membership, rejection of look-alike cgroups, missing parent limits, and a job child outside the hierarchy.

```rust
assert_eq!(aggregate_properties().memory_max, 1_073_741_824);
assert!(allowed_tenant_cgroup(
    "/system.slice/system-scikeel-workspaces.slice/scikeel-tenant-a-g1.service"));
assert!(!allowed_tenant_cgroup(
    "/system.slice/untrusted.slice/scikeel-tenant-a-g1.service"));
```

`aggregate_properties()` and `allowed_tenant_cgroup()` are the new lifecycle
helpers; expose only validated fixed values and exact escaped unit names.

- [ ] Run red: guarded `osd-sandbox-host` package tests and `pnpm platform:test test/host-admission.test.mjs`.
- [ ] Set the embedded `system-scikeel-workspaces.slice` definition to aggregate MemoryHigh 640 MiB, MemoryMax 1024 MiB, swap 128 MiB, CPU quota 100%, TasksMax 256. Add `Slice=system-scikeel-workspaces.slice` to the fixed tenant unit properties. Update `unit_cgroup()` and inspection to verify both levels and exact owned ancestry. Put every native-job descendant there and retain existing per-service limits. During release maintenance, stop/recreate protected idle tenants in the new hierarchy; never leave an old live tenant outside the ceiling.
- [ ] Replace the host preflight's repeated full 1,024 MiB reservation with verified aggregate headroom accounting for the proposed admission, retaining the 600 MiB host reserve. Do not charge the aggregate limit again for a second resident, and do not infer job headroom solely from an idle process's current RSS. Use the configured aggregate ceiling plus actual pressure and job admission rules.
- [ ] Refuse residency admission if aggregate enforcement cannot be verified. Preserve the 600 MiB reserve and current pressure rejection. Run green, including `pnpm release:test scripts/dev/sandbox-host-resources.test.mjs`. Commit aggregate enforcement before changing residency counts.

## Task 9: Separate idle residency from active job admission

**Files:**

- Modify `services/platform/src/host-admission.mjs`, `sandbox-scheduler.mjs`, `managed-worker-manager.mjs`, `sandbox-native-jobs.mjs`, `prompt-admission.mjs`.
- Extend their corresponding existing tests in `services/platform/test/`.
- Extend `services/platform/test/web-workspace-capacity.live.acceptance.mjs`.

- [ ] Add behavioral tests for two idle residents, same-account reuse, third-account LRU admission, job memory-headroom eviction, accepted/unknown-job protection, one-second read drainage, one job permit and build exclusion.

```js
await fixture.prepare("alice");
await fixture.prepare("bob");
await fixture.prepare("alice");
assert.deepEqual(fixture.runningUsers().sort(), ["alice", "bob"]);
assert.equal(fixture.startCount("alice"), 1);
assert.equal(fixture.activeJobPermits(), 0);
```

- [ ] Run red: `pnpm platform:test test/host-admission.test.mjs test/sandbox-scheduler.test.mjs test/managed-worker-manager.test.mjs test/prompt-admission.test.mjs test/cli-runtime-sandbox.test.mjs test/sandbox-native-jobs.test.mjs`.
- [ ] Replace unconditional other-account stopping with healthy-resident reuse and bounded LRU eviction of verified idle contexts. Set resident maximum two and job maximum one independently. A worker acquires a shared host lease only after Task 8's aggregate verification; builds/tests retain their exclusive host lease. Use scheduler permits at actual prompt/native-job admission, with the current durable accepted-job identity and cleanup handling.

```js
const permit = await scheduler.acquire({ ...jobIdentity, kind: "job", signal });
try {
  return await nativeRunner.run(acceptedJob, {signal});
} finally {
  if (await executions.isVerifiedFinished(jobIdentity)) await permit.release();
}
```

Integrate this ordering into the existing accepted-job lifecycle; do not add a
second runner. Define `isVerifiedFinished(identity)` as a query of existing
durable completion/cleanup state, with unknown returning false. The permit lives
with that execution state, including process restart recovery; a `finally` block
cannot release uncertain execution capacity. New resident/job admission checks
aggregate usage, available headroom and pressure before granting capacity.

- [ ] Keep bounded handoff and typed refusal reasons; never evict approval waits, active mutations or uncertain work. Run green, plus existing capacity/recovery tests. Verify flock behavior with actual separate processes inside the guarded tests. Commit admission changes.

## Task 10: Add a validated SDK bootstrap adapter

**Files:**

- Create `packages/sdk/src/gatewayBootstrap.ts`, `GatewayBootstrapClient.ts`.
- Modify `packages/sdk/src/index.ts`.
- Create `apps/desktop/src/test/gateway-bootstrap-client.node.test.ts`.
- Preserve `packages/sdk/src/OpenCodeClient.ts` standalone behavior.

- [ ] Add failing tests for response validation, no-store transport, cursor/filter encoding, cancellation, capacity/error reasons and partial bootstrap state. Test account/generation tags supplied by the existing Web transport and malformed event acknowledgements.

```ts
const bootstrap = await client.read({limit: 50, signal: controller.signal});
expect(bootstrap.assistant.defaultModel).toBe("gpt-6.1-sol");
expect(requests.map(request => request.url.pathname)).toEqual(["/api/me/bootstrap"]);
expect(requests[0].cache).toBe("no-store");
```

- [ ] Run red: `pnpm --filter @ai4s/desktop test src/test/gateway-bootstrap-client.node.test.ts`.
- [ ] Implement `GatewayBootstrapClient.read({limit,signal})`, `listConversations({limit,cursor,directoryRef,lifecycle,signal})`, and `listProjects({limit,cursor,signal})`. Validate every discriminated response and model capability before returning. Export contracts. Reuse existing auth/transport wrappers and event parsing facilities; never bypass revision guards or parse SSE with a new handwritten format parser.
- [ ] Keep managed catalog selection explicit; default `OpenCodeClient.listSessions()` remains compatible with desktop and standalone gateways. Run green plus `src/test/opencode-client.sessions.test.ts` and `src/test/gateway-workspace-client.node.test.ts`. Commit SDK changes.

## Task 11: Make frontend branches independent and cancelable

**Files:**

- Create `apps/desktop/src/lib/runtime.bootstrap.ts`, `runtime.bootstrap.test.ts`.
- Modify `apps/desktop/src/lib/runtime.ts`, `webMode.ts`.
- Extend `apps/desktop/src/lib/runtime.store.test.ts`, `runtime.initialAccess.test.ts`.

- [ ] Use controllable promises to test actual overlap, partial success, a slow optional model inventory, a failed list read with healthy environment, two subscribers sharing initialization, account logout and stale generations.

```ts
const attempt = coordinator.start({accountEpoch: 7, signal});
expect(calls).toEqual(expect.arrayContaining(["bootstrap", "workspace", "events"]));
optionalCatalog.reject(new Error("catalog endpoint unavailable"));
metadata.resolve(verifiedSnapshot);
workspace.resolve(readyReport);
events.resolve(ackForReadyReport);
await expect(attempt.ready).resolves.toMatchObject({accountEpoch: 7});
expect(disconnectCalls).toBe(0);
```

`createBootstrapCoordinator({readBootstrap, ensureWorkspace, subscribeEvents,
loadSelectedTranscript})` creates `coordinator`; `start()` returns `{ready,cancel}`.
The injected operations are the real SDK adapters in production. Selected
transcript loading resolves immediately only for the new-conversation route.

- [ ] Run red: `pnpm --filter @ai4s/desktop test src/lib/runtime.bootstrap.test.ts src/lib/runtime.store.test.ts src/lib/runtime.initialAccess.test.ts`.
- [ ] Implement the coordinator with one account/context owner, a real `AbortController`, independent metadata/workspace/events/transcript states, and explicit readiness evaluation. Start independent operations together after authentication; do not await the project list before conversations. Attach rejection handling to every concurrent promise immediately. Background inventories have a separate controller and concurrency two.
- [ ] Replace managed Web's per-directory initial `refreshSessions()` path with the indexed account-wide first page. Project and conversation pagination use their cursors and catalog revision. Preserve all older histories through load-more behavior and direct-id lookup. A list error retries only that list. Remove the 15-second list deadline's connection teardown; keep bounded transport deadlines and the existing capacity recovery owner.
- [ ] Apply results only when captured `accountEpoch`, policy revision and applicable generation still match. Logout aborts requests, stops delivery and clears private state before another account renders. A generation refresh retains account-level metadata only after ownership/policy validation. Run green and existing store cancellation/recovery regressions. Commit startup coordination.

## Task 12: Preload only essential assets and defer other routes

**Files:**

- Modify `apps/desktop/vite.config.ts`, `apps/desktop/src/app/router.tsx`.
- Create `services/platform/src/login-assets.mjs` and `services/platform/test/login-assets.test.mjs`.
- Modify `services/platform/src/login-page.mjs`, `services/platform/test/login-page.test.mjs`.
- Modify `scripts/dev/web-release-source.mjs` and its existing release tests.

- [ ] Write tests with a real-shaped Vite manifest covering static imports, CSS, dynamic routes, cycles, missing files and disallowed paths. Assert login hints include essential entry/static dependencies once and exclude optional renderers. Verify public asset loading never performs authenticated reads.

```js
const hints = loginAssets(manifest, "index.html");
assert(hints.modulepreload.includes("/assets/main-abc.js"));
assert(hints.styles.includes("/assets/shell-def.css"));
assert(!hints.modulepreload.includes("/assets/notebooks-xyz.js"));
```

- [ ] Run red: `pnpm platform:test test/login-assets.test.mjs test/login-page.test.mjs` and affected guarded release script tests.
- [ ] Enable Vite `build.manifest`, retain the current HTML entry, and include the manifest in the frozen release. Read it once with `JSON.parse`; validate public `/assets/` paths and file existence. Replace regex-based HTML asset discovery. Generate hints from the entry and static-import graph only. Cache immutable hashed assets by release and keep auth/bootstrap responses no-store.
- [ ] Change noninitial routes in `router.tsx` to React Router's `lazy` route modules. Keep the default live route and shell available; load settings, analytics, notebook, file-rendering and other optional routes at navigation. Check shared imports from the live shell so optional renderers do not re-enter the entry graph. Preserve every route and deep link.

```tsx
{ path: "notebooks", lazy: async () => ({
  Component: (await import("./routes/NotebooksPage")).NotebooksPage,
}) }
```

- [ ] Run green, then `pnpm web:build` under the existing guard. Inspect the generated manifest and compressed essential bytes against the 1,000 ms asset budget at the stated network profile. A build failure leaves the served bundle untouched. Commit assets and route changes.

## Task 13: Connect the existing login surface to real readiness

**Files:**

- Modify `apps/desktop/src/lib/loginPreparation.ts`, `runtime.ts`.
- Modify `apps/desktop/src/components/session/SessionView.tsx`, `src/app/layout/AppShell.tsx` under `apps/desktop/`.
- Add/extend `apps/desktop/src/lib/loginPreparation.test.ts`.
- Extend `apps/desktop/src/components/session/SessionView.launch.test.tsx`.
- Update existing translated error/status keys in `src/i18n/locales/en/common.json` and `zh-Hans/common.json` under `apps/desktop/` if needed.

- [ ] Test readiness as the full conjunction from the specification. A complete optional inventory cannot make an unready workspace interactive; a pending optional inventory cannot block a ready workspace. Deep links require the selected transcript. A verified empty account is ready, while missing/unverified history is an error.

```ts
expect(isLoginReady({ ...valid, optionalCatalog: "loading" })).toBe(true);
expect(isLoginReady({ ...valid, eventAcknowledged: false })).toBe(false);
expect(isLoginReady({ ...valid, metadataState: "unavailable" })).toBe(false);
expect(isLoginReady({ ...valid, selectedTranscriptReady: false })).toBe(false);
```

`isLoginReady(state)` lives in `runtime.bootstrap.ts` and validates identity,
metadata, assistant/model, workspace, event acknowledgement and selected route.
Optional catalog state is intentionally outside its required-state type; the
test helper may carry that additional field to prove independence.

- [ ] Run red: `pnpm --filter @ai4s/desktop test src/lib/loginPreparation.test.ts src/components/session/SessionView.launch.test.tsx`.
- [ ] Replace loginPreparation's full-catalog/default-model discovery wait with `isLoginReady()`, using bootstrap's validated default model. Preserve login markup ownership, theme, locale, capacity waiting, 90-second recovery ceiling, failure actions, event listener cleanup and sign-out flow. At three seconds display an accurate wait/failure state when necessary; never emit ready just because a timer expired.
- [ ] Enable the composer only with matching prompt capability/context. Keep file controls bound to actual file capability. Use the server-provided assistant label in connection errors. No internal API names, timing budgets, or implementation instructions appear in the visible UI.
- [ ] Run green and route/login lifecycle regressions, including logout during initialization and multiple mount/unmount cycles. Commit readiness/UI integration.

## Task 14: Add fixed guarded performance acceptance

**Files:**

- Create `services/platform/test/web-login-performance.live.acceptance.mjs`.
- Modify `services/platform/package.json`, `scripts/dev/safe-desktop-task.mjs`.
- Extend `scripts/dev/safe-desktop-task.test.mjs`, `scripts/dev/web-release.test.mjs`.
- Extend existing real Codex/project/file/capacity acceptance drivers without duplicating their protocol implementations.

- [ ] Add guard tests before changing dispatch: `web-login-live` is fixed-input, refuses arbitrary test paths, uses the publication lock and the existing live 384/512 MiB memory limits with 64 MiB swap, and validates its cgroup. Register package script `test:login:live`. Keep ordinary build/test locking unchanged.
- [ ] Run red: `pnpm release:test scripts/dev/safe-desktop-task.test.mjs scripts/dev/web-release.test.mjs`.
- [ ] Add the login-live mode following the existing `web-capacity-live` branch. Dispatch only `test/web-login-performance.live.acceptance.mjs` with explicit opt-in environment `SCIKEEL_LOGIN_LIVE_ACCEPTANCE=1`. Set all temporary-directory environment variables to ignored `.deploy/t` before launching browsers or subprocesses.
- [ ] Implement real browser scenarios: twenty measured submissions each for warm, stopped idle, alternating two accounts, new accounts, and platform restart. Rotate browser contexts for cold-cache samples; preserve real source state. Include the public network profile and report all sample durations from form submit to readiness paint. Screenshots/interactions cover 1280/390/320 widths and English/Simplified Chinese. Reuse authenticated state safely; never save plaintext credentials in artifacts.

```js
for (const sample of results.filter(row => row.capacity === "available")) {
  assert(sample.readyMs <= 3000, JSON.stringify(sample.safeTiming));
  assert.equal(sample.promptAccepted, true);
  assert.equal(sample.fileRoundTripVerified, true);
}
assert.equal(results.filter(row => row.scenario === "idle-cold").length, 20);
```

The browser records actual accepted prompts/responses and reversible file
read/write checks in dedicated owned test projects. Use real existing historical
conversations for continuity and verified retained data for migration acceptance.
Generated scale fixtures remain isolated catalog tests. Test cleanup removes only
new test-owned data and verifies retained account state is unchanged.

- [ ] Add real busy-account survival, third-resident admission, aggregate-cgroup peak usage, exclusive build refusal, stream acknowledgement, logout/relogin and history pagination checks. Report occupied-capacity waits separately, including time to visible state and eventual admission. Do not reclassify slow idle starts.
- [ ] Run green for guard/release tests. Run `pnpm --filter @ai4s/platform test:login:live` against the isolated fully built candidate after the next task's deterministic checks. An unavailable required Codex service is an explicit incomplete gate; Claude remains excluded. Commit acceptance code before using it as evidence.

## Task 15: Review, validate the complete candidate, and publish

**Files:**

- Review every changed file against the specification and the published source manifest.
- Modify only existing release integration points needed to run the new migration and gates.
- Update `PROGRESS.md` for verified milestones.

- [ ] Use `superpowers:requesting-code-review` and `superpowers:verification-before-completion`. Perform code review locally unless delegation is explicitly authorized. Inspect authentication boundaries, source/outbox atomicity, canonical id precedence, migrations, generation checks, unknown-job protection, cgroup ancestry, aggregate limits, and completion predicates. Resolve every correctness finding before release.
- [ ] Run deterministic checks sequentially with real scratch paths:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm platform:test
pnpm release:test
pnpm exec node scripts/dev/safe-desktop-task.mjs core-test --package osd-core
pnpm exec node scripts/dev/safe-desktop-task.mjs core-test --package osd-cli
pnpm exec node scripts/dev/safe-desktop-task.mjs core-test --package osd-sandbox-host
pnpm web:build
```

Expected: every command exits zero, no skipped mandatory regressions, resource
guard intact, no unexpected temporary paths. If a command is blocked by an
active workspace, preserve its state and schedule exclusive checks using the
existing authorized maintenance process. Do not increase resource limits.

- [ ] Build the pinned managed gateway/runner/host candidate through existing guarded release scripts. Verify the sandbox image digest, deployed binary identity, catalog native dependency, profile compatibility and required assets. Recheck concurrent published authentication changes and integrate before freezing the candidate source.
- [ ] Against the isolated candidate, run crash-restart catalog tests, complete historical import reconciliation, the fixed login-live gate, and existing real Codex capabilities/project/file/capacity gates. Require exact history id/reference preservation, actual prompts/files, at most one job, correct aggregate limits, no OOM events, and every uncontended login sample within 3,000 ms.
- [ ] Prepare the production migration report using fenced writers and preserved data. Verify source digests and zero pending changes. Upgrade readers before enabling schema writes. Switch listing only with a verified catalog for every enabled account; retain user data and pre-change state files in protected release recovery storage.
- [ ] Publish using the existing compatible-reader release mechanism only after all mandatory checks pass. Recheck public health, asset hash/manifest, selected Codex model, real account login timing, retained history and file access, event context, and recoverable execution state. A failed build, migration or timing gate keeps the prior served bundle in place and reports the actual blocker.
- [ ] Record verified results and artifact paths in `PROGRESS.md`; commit only reviewed task files. The final report states measured maximum/p95 and sample counts, real acceptance outcomes, release identity, and any unfinished gate. Do not claim the three-second requirement from endpoint timings or mocked tests.

## Specification coverage and review checklist

| Specification requirement | Implementation tasks |
| --- | --- |
| Submit-to-usable measurement, honest cold samples | 1, 13, 14, 15 |
| Public assets during login; private work after authentication | 5, 11, 12 |
| Metadata/workspace/event overlap and optional loading | 5, 10, 11, 12, 13 |
| One bounded indexed listing; all histories and pagination | 2, 3, 4, 5, 10, 11 |
| Durable updates, crash recovery, no replayed side effects | 3, 4, 15 |
| Correct assistant and minimum validated model capabilities | 5, 6, 7, 13 |
| One configured startup; Codex independent from OpenCode | 6, 7 |
| At most two residents, one job, protected ongoing work | 8, 9, 14 |
| Same aggregate host ceiling and exclusive heavy tasks | 8, 9, 14, 15 |
| Account/policy/generation cancellation and logout | 5, 7, 10, 11, 13 |
| Mobile/localization/deep-link readiness | 12, 13, 14 |
| Real data, real Codex, retained history and project lifecycle | 4, 14, 15 |
| Compatible publication, no partial release on failed checks | 4, 12, 15 |

Before implementation, verify exact baseline paths and published changes. During
execution, record actual red/green results and review findings with their fixes.
Completion requires the observed end-to-end behavior specified here; writing the
catalog, changing the spinner, or finishing isolated unit tests is insufficient.
