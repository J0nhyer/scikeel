# Administrator Agent Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans when the user authorizes implementation. Execute task-by-task with the checkpoints below. Steps use checkbox (`- [ ]`) syntax for tracking. Do not dispatch subagents without separate user authorization.

**Goal:** Add an admin-only Web menu and Agent analytics page covering task results, execution, tools/skills, models/subagents and human interventions using reliable, privacy-safe metadata.

**Architecture:** Collect sanitized execution metadata passively inside the existing platform service, persist it in one bounded SQLite worker, and expose administrator-guarded read APIs. Use a typed SDK client and a runtime-independent React route that follows the accepted prototype and existing platform design. Missing measurements remain explicit coverage gaps.

**Tech Stack:** Existing React, TypeScript, React Router, Radix, lucide, theme/i18n providers, Node ESM platform service, SDK, SQLite, Node tests, Vitest, Playwright and guarded package scripts.

**Spec:** `docs/superpowers/specs/2026-10-14-admin-agent-analytics-design.md`.
**Design reference:** `examples/agent-analytics-preview/`, published at `/preview/agent-analytics`.
**Status:** Web publication is authorized. The isolated branch `feat/admin-agent-analytics-20261014` includes the Simplified Chinese interface, the published Codex baseline `38e43f9`, the currently deployed project-management interface, legacy workspace history compatibility, and privacy-filtered native Codex metadata collection. Focused collector/storage/authorization/runtime/broker/lifecycle/research tests pass 153/153; native and historical conversation tests pass 72/72. Preparation on the integrated source passed lint (three existing warnings), typecheck, 92 workflow tests, 2,219 frontend tests (37 existing optional skips), and 1,187 platform tests (six optional skips). Canonical native research correlation and Web SDK subpath resolution now have regression coverage: 33 collector/runtime tests and one SDK import test pass. A source-matched candidate must complete the full preparation gates. Production remains `2026-10-20T03-38-20-633Z-ecb2ca65-reader`; analytics is not published. Live Codex execution requires permission for its fixed tenant-local temporary directory under the current workspace rules. Real analytics collection and public production browser acceptance remain pending.

### Execution Notes

- The proposed `better-sqlite3@12.9.1` was not available from the package registry. The implementation pins the published `12.9.0`, whose installed package declares Node 20 and 24 compatibility. Lock generation, frozen installation and native compilation ran through fixed guarded scripts. Minimum-Node CI execution remains unverified.
- Related view components are consolidated in `AgentAnalyticsViews.tsx`; the observer and metrics tests live in the platform collector/contract suites. This avoids adding separate wrappers solely to match the original file list.
- Models distinguish linked assistant-message metadata in the run-start cohort from unlinked broker attempts in a separately labeled attempt-start cohort. Missing retries, usage and latency remain unavailable. No inference-based run attribution was added.
- Research analytics bookkeeping remains private to the durable authority record and is excluded from public task responses and agent prompts. Analytics-disabled configurations do not install the research callback.
- Initial shared-resource verification waited for the project/file-management release to finish and release its locks. Its approved source was merged into this feature to avoid removing newly deployed behavior. The subsequently authorized publication attempt used the existing maintenance and rollback workflow; the restored production remains `2026-10-14T13-10-17-696Z-cd4c7c5e`.
- The native browser `fetch` binding was corrected after candidate acceptance exposed an illegal invocation; the SDK regression and rebuilt candidate browser check passed. Metrics/collector review also fixed late child linking, private research bookkeeping, explicit stop authority, detail pagination and interrupted timing coverage.
- Screenshots were captured for all nine theme/width combinations, including overview and drawer. Browser DOM/style assertions passed; screenshots were not manually inspected because the available image viewer cannot read images in this environment.
- Browser login coverage exposed the shared unauthenticated redirect dropping analytics filters. A failing route regression reproduced it; a narrowly scoped analytics destination fix passed that regression, the full platform suite (611 passed, 8 optional skips, zero failures), and the browser login/authorization/theme/width test (one passed, zero skips).
- The initial loopback developer preview used `http://127.0.0.1:4797/admin/agent-analytics`, a separate test account and an empty analytics database. It cannot start runtimes and has no production data. The private test credentials remain in `.deploy/verification/local-analytics-state/credentials.json`; nothing in that ignored directory belongs in Git.
- On 2026-10-15, the user chose to retain and simply finish the isolated domain preview: `http://agent-analytics.81.70.154.249.sslip.io/admin/agent-analytics`. The existing nginx default production server remains unchanged; a separate hostname proxies only analytics, authentication and candidate assets to port 4797. The preview has a separate host-only session cookie and login rate limit, with no production credentials or metadata. Its enabled `scikeel-admin-analytics-preview.service` user unit is limited to 256 MiB memory and 64 MiB swap; the former transient developer unit was stopped. Startup without a user login after host reboot is not verified.
- Public HTTP verification passed login, HTML, all five read endpoint families, missing-auth denial and logout revocation. Candidate JS/CSS/icon/font hashes matched the built branch bundle; production health returned 200. The additional public-origin browser test remains blocked by an existing shared desktop-task lock and was not bypassed. Earlier exact-candidate local browser acceptance remains valid evidence, not a substitute claim that the public browser test ran. This is an empty-state branch preview, not a live analytics deployment or a frozen product release.
- Superseding the hostname preview on 2026-10-15: after the user reported an external security-policy block and rejected that access method, the current preview is `http://81.70.154.249/admin/agent-analytics`. The separate hostname/login proxy was removed, and the obsolete hostname returns 410. The preview service now verifies existing platform sessions through loopback `/api/me`; the old `preview-admin` credentials are no longer accepted. Nginx serves the exact candidate JS/CSS under a separate asset prefix, leaving the production bundle and normal root routes intact. Existing-admin JSON login, all five analytics read endpoint families, logout revocation and namespaced candidate asset hashes passed; production health stayed 200. The additional browser run was again refused by the shared task lock, not run unbounded. Metadata remains a separate empty preview database; the unchanged production browser login flow is not certified as a passive analytics login.
- Superseding all branch preview configurations at the authorized production attempt: the admin page/API/asset proxy overrides were removed and nginx configuration/reload passed. After automatic rollback, `scikeel-admin-analytics-preview.service` was stopped and disabled; its files and isolated state were retained. The old hostname still returns 410. There is no active branch preview and no claim that the former URL currently serves published analytics.
- All 107 analytics labels and the menu entry now have Simplified Chinese translations. Two new regression tests failed before translation and the focused suite then passed 23 tests. The frozen browser gate additionally checked Chinese headings, filters, all four views and the delivery drawer at 1440 px; existing release width/theme checks were retained without expanding phone acceptance. Screenshots remain captured evidence, not manually inspected images.
- The failed real publication attempt persisted one accepted conversation run with outcome `failed`, one usage fact, six unlinked broker attempts and two coverage facts. These metadata-only rows survived rollback; database folder/file modes were verified as 0700/0600. Successful tool/research and public live UI acceptance were not run, so this is not a successful real-runtime acceptance result. No historical conversations, workspace files or credentials were deleted, and no Claude endpoint was probed.
- The installed image `f28f552b` passed the source/runner identity checks and was reused because the selected policy found no scientific-image inputs changed. Source fingerprint was `55377cef1220f9113edb75546425d38e691ae8e721737dea74106a3b4905823e`; Web artifact fingerprint was `981e3b0a67f60cb3d5d71c3ccd216f51b75545b50dcdb5d2ca5b15f353b3b713`. Frozen preparation and recovery records remain under the candidate directory; private diagnostic scripts are ignored in `.deploy/verification/`.
- On the user's request to investigate other causes without adding design, the existing broker was checked against the restored baseline: both already forward the five bounded native-client metadata headers. An isolated instance of the same installed OpenCode 1.18.32 emitted its genuine user-agent, client `cli`, project/session/request attribution; forwarding that real request to the configured free upstream still returned 403. No synthetic client identity was invented, and no product code, default provider or architecture was changed for this diagnosis. This narrows the remaining issue to the existing provider integration/release gate, rather than demonstrating a defect in the new analytics UI; production health remains 200.

### Execution Tracking

The original steps below remain the acceptance checklist, not a claim that every planned stress/live scenario ran. Consolidated implementation commit: `aebfd39`.

| Task | Actual status | Evidence or remaining work |
| --- | --- | --- |
| 1 | Implemented; CI target pending | Fixed guarded lock/install modes, exact 12.9.0 lock and host native smoke passed; Node 20 CI execution not observed. |
| 2 | Implemented and tested | Trusted identity, allowlisted metadata and canary exclusion fixtures passed. |
| 3 | Implemented and tested | SQLite worker, private file modes, bounded queue/read/storage, replay, restart and failure fixtures passed; no broad host pressure test attempted. |
| 4 | Implemented and tested | Outcome denominator, union waits, unknown usage and linked-child/cohort regression fixtures passed. |
| 5 | Implemented and tested; real acceptance pending | Accepted-turn/research fixtures and canonical native research association regression passed; real tool/research collection remains pending. |
| 6 | Implemented and tested | Metadata-only SDK event observer, internal native Codex events, cancellation and registered-worker lifecycle hooks passed deterministic tests. |
| 7 | Implemented and tested | Broker terminal metadata and durable research delivery/action hooks passed; adapter compatibility tests are deterministic, not live Claude probes. |
| 8 | Implemented and tested | Admin page/API guards, strict filters, unavailable storage, login destination and revocation fixtures passed. |
| 9 | Implemented and tested | Admin-only account menu, independent account identity, typed client and stale-account response fencing passed. |
| 10 | Implemented and tested | Four views, five dimensions, definitions, gaps, detail drawer and pagination; frozen candidate browser passed existing themes/widths plus Chinese desktop acceptance. |
| 11 | Required gate added; partially verified | Full suites and explicit candidate analytics browser passed. B01-B09 are not blanket signed off: exhaustive filter/focus/second-device/stress scenarios remain release work. |
| 12 | Source-matched Codex candidate preparation pending | The published runtime and current Web interface are retained. Publication and real metadata/API/Chinese browser acceptance remain pending; live execution needs permission for the fixed tenant-local temporary directory. |

Verified merged-source command sequence: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm platform:test`, `pnpm release:test scripts/dev/web-release.test.mjs scripts/dev/analytics-dependency.test.mjs`, then `pnpm web:build`. The analytics browser command supplied `OSD_AGENT_ANALYTICS_ACCEPTANCE=1`, the installed Playwright/Chromium paths and `OSD_WEB_CANDIDATE` pointing to `web-build-Kc32He`; it was not an optional skipped test. Its synthetic metadata never came from production conversations.

---

## Execution Boundary and Checkpoints

- Checkpoint A: Tasks 1-7 deliver contracts, bounded storage, metrics and passive collection. Keep product routes unavailable until the read boundary is ready.
- Checkpoint B: Tasks 8-10 deliver authenticated APIs, the menu and all four views. All five dimensions must be present, with measured data or explicit gaps.
- Checkpoint C: Tasks 11-12 deliver required acceptance evidence and a release candidate. Publication occurs only within the user's implementation/deployment authorization.
- Use `superpowers:using-git-worktrees` at execution time. The main checkout contains extensive unrelated work. Never copy its entire dirty state into this feature or alter another worktree.
- Re-read `AGENTS.md`, the active release manifest and `osd-platform.service` WorkingDirectory before editing. On inspection, production was `2026-10-13T15-49-26-093Z-1ebde999`, with manifest base commit `5619e568d75bff6998b1880d04bb1919f17a4681`. These are dated evidence, not permanent constants.
- Some production platform files are absent from the main checkout. Materialize the effective published snapshot, not substitute implementations from an older checkout.
- Run builds, tests, lint, typecheck and dependency installation serially through the guarded package scripts. Do not invoke Vite, Vitest or native compilation directly on this host, increase the guard into the system reserve, or bypass task locks.
- The currently selected Codex runtime and approved model must pass the existing real execution release gate. Preserve deterministic compatibility with other adapters; do not probe Claude.
- All product text and code remain English; translations use existing locale files. Do not add a new design system, external telemetry service, queue, billing service, chart dependency or account quotas.
- The preview service is a separately published design reference. These tasks do not replace its protection with public demo access.

## File Ownership Map

All paths are relative to the isolated effective-source checkout. New files are marked explicitly.

| Files | Responsibility |
| --- | --- |
| `services/platform/src/agent-analytics-contract.mjs` (new) | Trusted scope, opaque identities, field whitelist, query validation and versioned wire rules. |
| `services/platform/src/agent-analytics-store.mjs` (new) | Bounded worker RPC, backpressure, read deadlines, unavailable state and shutdown. |
| `services/platform/src/agent-analytics-worker.mjs` (new) | Single SQLite connection, migrations, transactions, queries, retention and disk bounds. |
| `services/platform/src/agent-analytics-metrics.mjs` (new) | Replay-safe projection, wait unions, usage semantics and descriptive metrics. |
| `services/platform/src/agent-analytics-collector.mjs` (new) | Generation-scoped observation, lifecycle bindings, metadata routing and coverage gaps. |
| `services/platform/src/agent-analytics-routes.mjs` (new) | Read-only admin API dispatch; no worker access. |
| `services/platform/src/{main,platform-server,managed-worker-manager,model-broker,research-tasks}.mjs` | Inject small hooks into the effective published service without changing existing execution authority. |
| `services/platform/test/agent-analytics-{contract,store,metrics,collector,routes}.test.mjs` (new) | Synthetic privacy, replay, crash, resource, lifecycle and authorization tests. |
| `services/platform/test/{platform-server,managed-worker-manager,model-broker,research-tasks}.test.mjs` | Regressions in existing hooks, login, worker lifetime, streaming and research checks. |
| `packages/sdk/src/agent-analytics-observer.mjs` and `packages/sdk/test/agent-analytics-observer.test.mjs` (new) | Node-compatible, read-only OpenCode metadata observation; bounded SSE decoding without retaining content. |
| `packages/sdk/src/admin-analytics.ts` (new), `packages/sdk/src/index.ts`, `packages/sdk/package.json` | Typed platform read client, types/exports and Node observer subpath. |
| `apps/desktop/src/lib/adminAnalytics.ts` and `apps/desktop/src/lib/adminAnalytics.test.ts` (new) | Account-bound requests, cancellation, coalescing and invalidation. |
| `apps/desktop/src/app/layout/AdminAnalyticsLayout.tsx` and `apps/desktop/src/app/layout/AdminAnalyticsLayout.web.test.tsx` (new) | Independent admin identity/layout; no AppShell runtime bootstrap. |
| `apps/desktop/src/app/routes/AdminAnalyticsPage.tsx` and `apps/desktop/src/app/routes/AdminAnalyticsPage.web.test.tsx` (new) | Shared filters, selected view, data state and drill-down links. |
| `apps/desktop/src/components/admin/AgentAnalyticsOverview.tsx` (new) | Overview, activity trend, mix, metric definitions and inspection signals. |
| `apps/desktop/src/components/admin/AgentRunTable.tsx` and `apps/desktop/src/components/admin/AgentRunDrawer.tsx` (new) | Runs, bounded pagination and accessible detail drawer. |
| `apps/desktop/src/components/admin/AgentCapabilities.tsx` and `apps/desktop/src/components/admin/AgentInterventions.tsx` (new) | Tools/Skills/Models/Subagents tabs and collaboration records. |
| `apps/desktop/src/components/admin/AgentAnalyticsViews.web.test.tsx` (new) | Metric labels, missing data, drill-downs, drawer and collaboration semantics. |
| `apps/desktop/src/app/router.tsx`, `apps/desktop/src/components/sidebar/GatewayAccountMenu.tsx`, `apps/desktop/src/components/sidebar/GatewayAccountMenu.test.tsx` | Sibling route and admin-only menu entry. |
| `apps/desktop/src/{main.tsx,lib/loginPreparation.ts,lib/loginPreparation.test.ts,lib/runtime.ts,lib/gatewayAccount.ts,lib/gatewayAccount.test.ts}` | Expose independent account revalidation/availability; bypass worker-readiness preparation only for the exact analytics destination. |
| `apps/desktop/src/i18n/locales/{en,de,es,fr,ja,ko,zh-Hans}/{nav,pages}.json` | Entry labels and analytics copy; existing parity rules apply. |
| `apps/desktop/src/test/webAgentAnalytics.acceptance.test.mjs` (new) | Candidate browser authorization, interactions, themes, phone widths and no-bootstrap checks. |
| `scripts/dev/{safe-desktop-task,web-release-policy,web-release,web-release.test}.mjs` | Fixed guarded dependency commands and required analytics browser gate registration. |
| `services/platform/package.json`, `package.json`, `pnpm-lock.yaml` | One SQLite binding, SDK observer access and guarded install scripts. |
| `PROGRESS.md` | One newest-first English line per real completed checkpoint. |

`index.css`, existing theme providers, branding assets and UI primitives are reuse references, not a planned palette/font rewrite. No Rust/native runtime or science-image code change is required by this design; the existing source-matched image release gate still applies when selected.

## Contracts Used Across Tasks

### Identity and metadata

- `TrustedScope`: `{ accountId, runtime, instanceId, generation }`, supplied only by authenticated platform/worker registration. `generation` is a nonnegative safe integer. Runtime-provided account claims are ignored.
- `runType`: `research` or `conversation`; `executionId` is the task's execution number combined with its stable task identity, or an accepted turn's stable message/operation ID. A transport correlation ID alone is not a turn ID.
- Internal `sessionId`, `executionId` and entity IDs are validated at their source. Exposed run/event IDs are hashes, not titles, filenames or private content.
- `runId(scope, sessionId, executionId)` and `eventKey(scope, kind, entityId)` are SHA-256 of a JSON tuple. `unattributedAttemptKey(attemptId)` uses a separate platform-generated attempt namespace, with null account/run fields; never invent a tenant scope for an unauthenticated attempt. Entity IDs include the session and execution scope when the upstream identifier is not globally unique. Timestamp is never part of a replay identity.
- Run outcomes: `running`, `waiting_input`, `paused`, `completed`, `failed`, `cancelled`, `unknown`. The UI renders `unknown` as `Unknown / interrupted`.
- Event kinds: `run`, `tool`, `skill`, `usage`, `model_attempt`, `subagent`, `intervention`, `coverage`. Each entity occupies one upsertable row; asked/resolved and running/terminal updates retain their identity.
- `sanitizeFact(scope, fact, registry)` returns a new whitelist-only record or `null`. `registry` contains authenticated session/turn bindings and known capability/provider/model/skill/agent IDs. Regex validation alone does not make a free-form string safe.
- Fact fields: `kind`, `entityId`, `runId` (nullable), `sourceVersion` (nullable), `startedAt`/`endedAt` (nullable UTC epoch milliseconds), `outcome` (enumerated), `code` (enumerated), `capabilityId`/`providerId`/`modelId`/`agentId`/`parentRunId`/`childSessionId` (validated, nullable), `runType`/`category` (typed, nullable), `firstByteMs` (nullable nonnegative broker duration), `usage`/`delivery` (fixed numeric/enum objects, nullable). No arbitrary additional JSON is stored.
- `usage`: nullable `input`, `output`, `reasoning`, `cacheRead`, `cacheWrite`, plus `source`, `final`, `semantics`. `semantics` is `distinct`, `overlap`, or `unknown`; totals across ambiguous categories are unavailable. Zero reported cost is not proof of a zero charge. Initial product cost is unavailable.
- `delivery`: `outputs`, `evidence`, `inputsPreserved`, each `passed`, `failed`, `pending`, or `unknown`. No names, paths, check titles or scientific score.
- Intervention code: `approval`, `clarification`, `correction`, `takeover`; result: `pending`, `approved`, `rejected`, `answered`, `cancelled`, `unknown`. Correction/takeover require an explicit recorded action. Existing research decision confirmations map to clarification, without retaining their question/answer.
- Error codes are fixed metadata categories: `changed_inputs`, `missing_outputs`, `failed_checks`, `missing_progress`, `runtime_error`, `tool_failed`, `tool_rejected`, `tool_cancelled`, `tool_interrupted`, `model_capacity`, `model_grant_denied`, `model_grant_expired`, `model_first_byte_timeout`, `model_idle_timeout`, `model_total_timeout`, `model_client_cancelled`, `provider_rejected`, `safety_rejected`, `other_failure`. Unknown source errors map to `other_failure` without their text. State/result enums are validated per event kind, not interpreted as one global run outcome.
- Unknown category is `unclassified`. Initially it may be the only category because the current research schema does not have a trusted typed task-category field. Do not infer a category from objectives or add an NLP classifier.

### Storage and collector interface

`createAnalyticsStore({ path, now, limits })` has four methods:

- `offer(safeFact): boolean`: synchronously accept one validated fact, or return false without blocking execution.
- `read(operation, filters, { signal } = {}): Promise<AnalyticsEnvelope>`: execute a bounded stored-data query; operation is one of the six read API names below.
- `status(): { state, droppedEvents }`: return `starting`, `ready`, `degraded`, or `unavailable`, with a known count or null.
- `close(): Promise<void>`: reject pending reads, flush only a bounded pending batch and close the sole database worker.

`offer` is synchronous, bounded and nonthrowing to callers. Reads either resolve a versioned envelope or reject a safe error code. The stored file lives under the platform private state root, outside user workspaces and release-source directories.

`createAnalyticsCollector({ store, createObserver, now, registry })` returns `workerReady({ scope, access })`, `workerRevoked(scope)`, `bindRun({ scope, sessionId, executionId, runType, category })`, `record(scope, fact)`, `recordAttempt(scopeOrNull, fact)` and `close()`. Its registry is built from platform-registered capabilities and verified run/session bindings; absent registry fields yield unsupported/unlinked facts, not permissive string acceptance. The private `access` contains the existing internal endpoint/token in memory only. No hook waits on storage/observer I/O while starting, stopping or streaming execution.

`createOpenCodeMetadataObserver({ baseUrl, token, fetchImpl, onFact, onGap })` exposes `start()` and `close()`. It uses only the registered live worker's existing read-only event endpoint, with the current pinned runtime format. It has no prompt/start/install/recover method and does not call `ensureWorker`.

### Read API and frontend types

All APIs are GET-only under `/api/admin/agent-analytics`:

| Suffix | Data | Pagination |
| --- | --- | --- |
| `/overview` | `metrics`, `trend`, `mix`, `signals`, `recentRuns`, `unattributedModelAttempts` | Recent runs <=10; <=30 UTC trend buckets. |
| `/runs` | `rows` | <=50, stable `(startedAt, runId)` cursor. |
| `/runs/:runId` | `run`, `delivery`, `timeline`, `children`, `interventions`, `modelUsage` | Timeline <=50 per page; bounded child/call pages, with visible truncation. |
| `/capabilities` | `kind`, `rows` | `kind=tools|skills|models|subagents`, <=50 per page. |
| `/interventions` | `rows` | <=50 per page. |
| `/filter-options` | `accounts`, `categories`, `runTypes` | Accounts <=50 per page; include stored archived account IDs with safe generic labels. |

`AnalyticsFilter`: `window=24h|7d|30d`, `to` (UTC epoch milliseconds), optional `accountId`, `runType=all|research|conversation`, `category`, `outcome`, `q`, `cursor`, `limit`. Only route-relevant keys are accepted. Duplicate/unknown keys, invalid bounds, more than 50 rows and search >80 characters return 400. Search matches safe run identifiers and generic run labels only. Cursors are bounded encoded values, fully validated and parameterized, never raw SQL. Run detail also accepts a timeline cursor and is independent of an overview's outcome filter.

`from` is derived from `window` and `to`; `[from,to)` selects top-level runs by start time. Known linked children contribute to that parent once, not a second top-level run. Unlinked broker attempts use their own start time and remain a separate measured cohort; attempts without trusted account attribution appear only in the all-account unattributed count.

```ts
export type AnalyticsEnvelope<T> = {
  schema: 1;
  asOf: number;
  dataRevision: number;
  coverage: {
    collectionStartedAt: number | null;
    earliestRetainedAt: number | null;
    droppedEvents: number | null;
    gaps: Array<{ from: number; to: number | null; code: string }>;
    gapsTruncated: boolean;
    unknownUsageCalls: number;
    unattributedCalls: number;
  };
  data: T;
  nextCursor: string | null;
};
```

Gaps are bounded to 20 entries per response with `gapsTruncated=true` when needed. Enumerated gap codes are `uncollected`, `observer_disconnected`, `server_restart`, `queue_overflow`, `storage_limit`, `storage_unavailable`, `unsupported_adapter`, `conflicting_update`, `unlinked_activity`. Coverage is data, not a successful measurement of an absent capability.

`createAnalyticsRoutes({ store, authStore })` exposes `handle(request, response, { admin, url })`; it reads stored metadata and existing account display records only. Inject it through the PlatformServer constructor from `main.mjs`. Authorization remains the PlatformServer's authority.

`AdminAnalyticsClient` exposes `overview(filter, options)`, `runs(filter, options)`, `run(runId, options)`, `capabilities(kind, filter, options)`, `interventions(filter, options)`, `filterOptions(options)`, where options carry `signal` and, for detail, validated page cursors. It calls only the same-origin platform APIs with existing authentication. It never instantiates a runtime client. Response errors expose safe codes and HTTP status, without arbitrary backend text.

## Task 1: Establish the Effective Baseline and a Guarded SQLite Dependency

**Files:** `package.json`, `services/platform/package.json`, `packages/sdk/package.json`, `pnpm-lock.yaml`, `scripts/dev/safe-desktop-task.mjs`, `scripts/dev/web-release.test.mjs`; new `services/platform/test/agent-analytics-store.test.mjs`.

- [ ] Read the active manifest with a small script, printing only release ID, source root, base commit and file count. Confirm WorkingDirectory agrees. Create `.worktrees/admin-agent-analytics-20261014` from that base commit using the worktree skill, and materialize only the manifest's source files after checking hashes. Preserve docs/rules separately from the authoritative user instructions; do not copy credentials, dependency directories or deployed mutable state.

```bash
systemctl show osd-platform.service -p WorkingDirectory
node --input-type=module <<'JS'
import { readFile } from 'node:fs/promises';
const current = JSON.parse(await readFile('.deploy/web-releases/current.json', 'utf8'));
const manifest = JSON.parse(await readFile(`.deploy/web-releases/${current.id}/manifest.json`, 'utf8'));
console.log(JSON.stringify({ id: current.id, root: manifest.source.root,
  baseCommit: manifest.source.baseCommit, files: manifest.source.files.length }));
JS
```

Expected: current effective-source evidence, without environment/session secrets. Before feature edits, record an isolated baseline commit if the manifest differs from the base commit; review those differences as published baseline material, not analytics changes.

- [ ] Add fixed safe-task modes `platform-deps-lock` and `platform-deps-install` to the existing allowlist and root scripts. They use existing lock/cgroup verification; arbitrary arguments are rejected. Add a deterministic release test asserting the new modes cannot bypass the guard and cannot accept another shell command.

```js
// Branches inside the existing guarded mode dispatcher.
if (mode === "platform-deps-lock") {
  if (args.length) throw new Error("Dependency lock generation has fixed inputs");
  run("pnpm", ["install", "--lockfile-only", "--ignore-scripts"], root);
} else if (mode === "platform-deps-install") {
  if (args.length) throw new Error("Dependency installation has fixed inputs");
  process.env.MAKEFLAGS = "-j1";
  process.env.npm_config_jobs = "1";
  run("pnpm", ["install", "--frozen-lockfile"], root);
}
```

Root scripts: `platform:deps-lock` and `platform:deps-install` call `node scripts/dev/safe-desktop-task.mjs` with their matching fixed mode. Install into this isolated checkout's own dependency roots; do not mutate dependencies shared with the running release. Record the new installed-lock identity so release freezing validates it. Verify the SDK observer resolves from the frozen candidate source/dependency view, not from a mutable worktree symlink; add a release regression asserting the existing workspace dependency view resolves the new Node SDK subpath inside the frozen source.

- [ ] Pin `better-sqlite3` to the verified published `12.9.0` in the platform package and add `@ai4s/sdk: workspace:*` for the Node observer subpath. This is a Node-20/current-Node-24 compatibility baseline, not a claim of the newest available version. Check upstream advisories and engine support at execution; a changed compatible patch needs a reviewed lockfile and the same smoke tests. Never silently raise the project's Node floor.
- [ ] Run `pnpm platform:deps-lock`, then `pnpm platform:deps-install` serially. Expected: exact lock/install match and a native binding usable on the current host; failure does not change deployed dependencies or bundle. Verify minimum Node 20 and the actual deployment Node in existing CI with equivalent job resource limits; if a declared target is unsupported, report the incompatibility rather than silently dropping it.
- [ ] Add and run the database smoke test through `pnpm platform:test test/agent-analytics-store.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

test("the pinned binding opens and executes on the supported server Node", () => {
  const db = new Database(":memory:");
  try {
    assert.equal(db.prepare("SELECT 1 AS value").get().value, 1);
    assert.match(db.prepare("SELECT sqlite_version() AS version").get().version, /^3\./);
  } finally { db.close(); }
});
```

- [ ] Run `pnpm release:test scripts/dev/web-release.test.mjs`; expected existing guard/release checks and added fixed-mode cases pass. Commit only these feature-scoped files as `build: guard analytics database dependency installation`.

Primary implementation references: upstream versioned package metadata at `https://raw.githubusercontent.com/WiseLibs/better-sqlite3/v12.9.0/package.json`, binding API at `https://github.com/WiseLibs/better-sqlite3/blob/v12.9.0/docs/api.md`, and SQLite WAL guidance at `https://www.sqlite.org/wal.html`. These document compatibility and checkpoint behavior; they do not establish a security audit.

## Task 2: Freeze Safe Metadata, Identity and Validation

**Create:** `services/platform/src/agent-analytics-contract.mjs`, `services/platform/test/agent-analytics-contract.test.mjs`.

- [ ] Write failing tests for trusted account override, generation separation, replay keys, invalid timestamps/numbers, unknown enums, registered capability validation and raw-content exclusion. Include canaries in prompt, reasoning text, question/answer, tool arguments/output, filename, error text, token and path fields; verify none survive the returned object or serialized bytes. Numeric reasoning usage is allowed; reasoning text is not.
- [ ] Run `pnpm platform:test test/agent-analytics-contract.test.mjs`; expected missing module/functions before implementation.
- [ ] Implement the pure identity helper and sanitizer. The identity helper's complete core is:

```js
import { createHash } from "node:crypto";

export function scopedId(scope, namespace, parts) {
  if (!scope || typeof scope.accountId !== "string" || !scope.accountId ||
      typeof scope.runtime !== "string" || !scope.runtime ||
      typeof scope.instanceId !== "string" || !scope.instanceId ||
      !Number.isSafeInteger(scope.generation) || scope.generation < 0 ||
      typeof namespace !== "string" || !namespace || !Array.isArray(parts) ||
      parts.some((part) => typeof part !== "string" || !part || part.length > 256)) {
    throw new TypeError("invalid_analytics_identity");
  }
  return createHash("sha256").update(JSON.stringify([
    scope.accountId, scope.runtime, scope.instanceId, scope.generation, namespace, parts,
  ])).digest("hex");
}

export function runId(scope, sessionId, executionId) {
  return scopedId(scope, "run", [sessionId, executionId]);
}

export function eventKey(scope, kind, entityId) {
  return scopedId(scope, "event", [kind, entityId]);
}

export function unattributedAttemptKey(attemptId) {
  if (typeof attemptId !== "string" || !/^[a-f0-9]{32}$/.test(attemptId)) {
    throw new TypeError("invalid_analytics_attempt");
  }
  return createHash("sha256").update(JSON.stringify(["unattributed-model-attempt", attemptId])).digest("hex");
}
```

Construct stored identity fields from opaque hashes; the raw source entity/session/turn ID is used only in memory to establish those keys. Build fact objects explicitly field-by-field; never spread an event, context, error or task object into storage. Bound safe identifiers and allow only registry-verified capability IDs. Implement `sanitizeUnattributedAttempt(fact, registry)` for `recordAttempt(null, fact)` using the separate attempt key, null account/run fields and the same size/numeric/code whitelist. Unauthenticated rejection metadata is never attributed by its claimed account/session. Reject JSON above 4 KiB after normalization. Recheck schemas in the store boundary so a future adapter cannot bypass them.

- [ ] Add the replay test using the real helper, not a separate reimplementation:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { eventKey, runId } from "../src/agent-analytics-contract.mjs";

test("replay keeps identity while another account or generation cannot alias", () => {
  const scope = { accountId: "account-a", runtime: "opencode", instanceId: "instance-a", generation: 4 };
  assert.equal(eventKey(scope, "tool", "session-a:call-a"), eventKey(scope, "tool", "session-a:call-a"));
  assert.notEqual(runId(scope, "session-a", "turn-a"),
    runId({ ...scope, generation: 5 }, "session-a", "turn-a"));
  assert.notEqual(runId(scope, "session-a", "turn-a"),
    runId({ ...scope, accountId: "account-b" }, "session-a", "turn-a"));
});
```

- [ ] Implement `parseAnalyticsFilter(searchParams, allowedKeys, now)` with the specified window, range, cursor and limit rules. Define explicit safe error codes `invalid_filter`, `invalid_cursor`, `analytics_unavailable`, `query_timeout`, `not_found`, `unauthenticated`, `forbidden`. SQL callers receive typed values, never fragments from query text.
- [ ] Run the focused contract suite; expected all privacy/identity/validation cases pass. Commit `feat(platform): define safe agent analytics contracts`.

## Task 3: Persist Metadata Without Blocking Execution

**Create:** `services/platform/src/agent-analytics-store.mjs`, `services/platform/src/agent-analytics-worker.mjs`. **Extend:** `services/platform/test/agent-analytics-store.test.mjs`.

- [ ] Add temporary-directory tests for duplicate upsert, final usage replacement, unknown future schema, restart recovery, worker failure, read abort/timeout, queue overflow, retention/storage pressure and raw canaries absent from DB/journal. Include a real source-version conflict case, not just a mock successful write. Keep injected test limits small; never fill the real host disk. Assert `offer` returns promptly while the worker is stalled and model-proxy callbacks continue.
- [ ] Run `pnpm platform:test test/agent-analytics-store.test.mjs`; expected missing store behavior.
- [ ] Implement one `node:worker_threads` worker with `resourceLimits.maxOldGenerationSizeMb=64`, an independent SQLite connection, cache <=4 MiB, pending event cap 256, batches <=32, pending reads <=8, and a two-second read deadline. One batch is in flight; message-port buffering must not become a second unbounded queue. Limit collector fact callbacks per event-loop turn and discard excess metadata with a visible gap; database isolation alone does not make an unbounded parse/sanitize loop safe. Flush within 250 ms or when 32 events are available. `offer` catches analytics errors, increments bounded counters and returns false instead of throwing to execution.
- [ ] Create schema version 1 transactionally. Use this minimal schema shape; indexes may be extended only for measured queries:

```sql
CREATE TABLE analytics_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE analytics_runs (
  run_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  runtime TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  session_key TEXT NOT NULL,
  execution_key TEXT NOT NULL,
  run_type TEXT NOT NULL,
  parent_run_id TEXT,
  category TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  outcome TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  revision INTEGER NOT NULL
);
CREATE TABLE analytics_events (
  event_key TEXT PRIMARY KEY,
  run_id TEXT,
  account_id TEXT,
  kind TEXT NOT NULL,
  source_version INTEGER,
  started_at INTEGER,
  ended_at INTEGER,
  fact_json TEXT NOT NULL,
  revision INTEGER NOT NULL
);
CREATE INDEX analytics_runs_scope ON analytics_runs(account_id, run_type, started_at, run_id);
CREATE INDEX analytics_runs_time ON analytics_runs(started_at, run_id);
CREATE INDEX analytics_events_run ON analytics_events(run_id, kind, event_key);
CREATE INDEX analytics_events_time ON analytics_events(started_at, event_key);
```

Persist internal session/execution/entity/child identifiers as opaque keys. The sanitizer hashes identifiers even when a source permits client-chosen IDs; fact JSON must not retain the original strings. Use a 0700 platform-private directory and 0600 database/journal files, with regular-file/owned-path checks; no workspace path or release-source location is accepted. An event replacement and its run projection commit together, and one store-wide revision increments per committed batch. Preserve nonterminal records on restart with an `unknown` outcome or a still-authoritative research `paused` state; a restart is never a completion.

- [ ] Use WAL only in this local platform-private directory, bounded checkpoints and no external readers. Reserve storage: database max 100 MiB via `max_page_count`, combined DB/WAL/SHM budget 128 MiB, checkpoint at small batch boundaries, disable writes before the reserved journal headroom is exhausted. `journal_size_limit` alone is not a hard WAL cap. On disk/full/checkpoint failure, roll back the analytics batch, expose `storage_limit`/`storage_unavailable` and let agents proceed.
- [ ] Expire detail older than 30 days and, under pressure, the oldest retained cohort in batches <=1,000 rows. Bound deletion of a large run's events across passes, do not remove its summary before its events are reconciled, and expose the actual retained start time. No full VACUUM or transcript/file backfill in the streaming process. Schedule cleanup through the same bounded worker.
- [ ] Store collection start, last successful write, gap intervals and revision in `analytics_meta`. A crash adds a conservative `server_restart` gap; a counter that cannot be recovered is null rather than a fabricated exact zero. A read deadline rejects promptly, drains pending callbacks and terminates/reopens the faulty worker only after the old connection is closed. Analytics faults never fail platform startup or retain a runtime slot.
- [ ] Run the store suite and contract suite serially; expected bounded queues, replay/restart and disk-canary checks pass. Commit `feat(platform): persist bounded agent analytics metadata`.

## Task 4: Define Outcomes, Wait Time, Usage and Comparisons

**Create:** `services/platform/src/agent-analytics-metrics.mjs`, `services/platform/test/agent-analytics-metrics.test.mjs`. **Modify:** the analytics worker projection/query integration.

- [ ] Write failing metric tests using a fixed UTC clock and real normalized facts: completed/failed/cancelled denominator, unknown excluded, structured/conversation labels, cancel-then-idle, delivery pending, overlapping waits, child deduplication, repeated tool calls versus explicit retries, usage replacement and missing/ambiguous tokens. Include model comparisons with unequal sample/task mix and unknown cost.
- [ ] Run `pnpm platform:test test/agent-analytics-metrics.test.mjs`; expected missing helpers.
- [ ] Implement `completionCounts(runs)` and `unionDuration(intervals, startedAt, endedAt)`. These pure cores establish the denominator and overlap rule:

```js
export function completionCounts(runs) {
  const counts = { completed: 0, failed: 0, cancelled: 0, unknown: 0, active: 0 };
  for (const run of runs) {
    if (["completed", "failed", "cancelled", "unknown"].includes(run.outcome)) counts[run.outcome]++;
    else counts.active++;
  }
  const denominator = counts.completed + counts.failed + counts.cancelled;
  return { ...counts, denominator, rate: denominator ? counts.completed / denominator : null };
}

export function unionDuration(intervals, startedAt, endedAt) {
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt < startedAt ||
      intervals.some(([a, b]) => !Number.isFinite(a) || !Number.isFinite(b) || b < a)) return null;
  const spans = intervals.map(([a, b]) => [Math.max(a, startedAt), Math.min(b, endedAt)])
    .filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
  let total = 0;
  let active = null;
  for (const span of spans) {
    if (!active) active = [...span];
    else if (span[0] <= active[1]) active[1] = Math.max(active[1], span[1]);
    else { total += active[1] - active[0]; active = [...span]; }
  }
  return total + (active ? active[1] - active[0] : 0);
}
```

Use unknown timing when a wait start/end or run boundary is missing. A reconnect gap also invalidates an apparently complete timing sample that may have missed a wait. Active duration is measured elapsed minus the union of recorded human waits, with time-coverage indicated; child-only waits do not subtract from parent active time unless the parent itself has a recorded wait interval; a count is not a timing sample.

- [ ] Add the complete overlap test:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { unionDuration, completionCounts } from "../src/agent-analytics-metrics.mjs";

test("permission and clarification overlap once", () => {
  assert.equal(unionDuration([[10, 50], [30, 70]], 0, 100), 60);
  assert.equal(unionDuration([[10, null]], 0, 100), null);
});

test("unknown and active executions do not inflate completion", () => {
  const result = completionCounts(["completed", "failed", "cancelled", "unknown", "running"]
    .map((outcome) => ({ outcome })));
  assert.equal(result.denominator, 3);
  assert.equal(result.rate, 1 / 3);
  assert.equal(result.unknown, 1);
});
```

- [ ] Implement `mergeFact(previous, next)` and `projectRun(runFact, facts)`. Identical replay is a no-op; lower verified source versions cannot overwrite final state. When no verified ordering exists, terminal state must not regress to running; conflicting terminal/usage updates add `conflicting_update` and leave the disputed measurement unknown. Do not manufacture ordering from arrival time or take the largest usage value. A verified new execution is a new run.
- [ ] Use authoritative research delivery outcomes. An idle event alone cannot overwrite failed/cancelled/paused research state. For conversation turns, require a verified final assistant boundary linked to the accepted turn and no unresolved error; label only execution completion. Transport 204/200 remains separate metadata.
- [ ] Build stored queries with one common run cohort predicate and parameter array. Compute charts and counts in one transaction/revision; top-level parents and known children are disjoint accounting sets. Median uses measured terminal-run samples and shows its sample count. If a query/resource limit prevents complete calculation, return a coverage gap/unknown, not an unlabeled sampled total. No comparison leaderboard or scientific quality score.
- [ ] Run contract/store/metrics tests; expected exact denominator/wait/replay/usage cases pass. Commit `feat(platform): calculate evidence-aware agent analytics`.

## Task 5: Bind Authoritative Research Executions and Accepted Turns

**Create:** `services/platform/src/agent-analytics-collector.mjs`, `services/platform/test/agent-analytics-collector.test.mjs`. **Modify:** `services/platform/src/{research-tasks,platform-server,main}.mjs`, `services/platform/test/{research-tasks,platform-server}.test.mjs`.

- [ ] Add failing platform tests: an unexecuted ready brief creates no run; each research execution has a distinct ID; replay of one accepted prompt creates one conversation run; rejected prompt creates no accepted run; transport completion does not complete research; server shutdown produces paused/unknown rather than success; explicit abort is not a network disconnect takeover.
- [ ] Run `pnpm platform:test test/agent-analytics-collector.test.mjs test/research-tasks.test.mjs test/platform-server.test.mjs`; expected missing analytics hooks while current authority tests remain unchanged.
- [ ] Implement collector bindings keyed by trusted scope plus session/execution. Bound live binding state to 512 entries and remove finalized entries after a bounded grace period; keep incomplete/evicted binding coverage explicit. Use the durable store to resolve retained metadata after a process restart, without reading transcripts.
- [ ] Add optional `onAnalyticsFact` to the existing research service. Emit after the existing persisted lifecycle transition and existing completion checks, not before validation succeeds. Existing active-task refresh/timer processing emits the same safe hook without requiring an analytics browser; analytics itself never reads progress files. Build the snapshot explicitly:

```js
// The lifecycle hook receives the already-authorized task; it does not persist it.
const fact = {
  kind: "run",
  entityId: `${task.sessionId}:${task.execution}`,
  sourceVersion: task.analyticsRevision,
  runType: "research",
  category: "unclassified",
  outcome: task.status,
  code: ["changed_inputs", "missing_outputs", "failed_checks", "missing_progress"].includes(task.issue)
    ? task.issue : null,
};
try { this.onAnalyticsFact?.(fact); } catch { /* Analytics cannot change task authority. */ }
```

The existing task edit revision does not advance on every progress refresh, so it is not a telemetry ordering source. Add an optional private `analyticsRevision` counter to the durable task record, incrementing only when the safe lifecycle/delivery snapshot changes, in the same serialized save. Preserve the existing public edit revision and authorization rules. The caller supplies authenticated account/instance/generation, execution start/end timestamps captured by the existing execution transition and the fixed delivery booleans from the existing validation result. Do not derive scope from task-authored reports; no task object spread, objective, artifact name, evidence path, limitation text or question is retained. Map post-execution `ready` after a decision to paused/waiting, not a fresh unexecuted brief or a completed run.

- [ ] At the existing validated managed-runtime prompt path, bind an accepted turn to a verified user-message/operation ID. Reuse an existing stable ID from the prompt contract where available; if absent, generate the ID once at acceptance and keep it on that operation's replay receipt. Only create the run after runtime acceptance is confirmed. Async acceptance, response finish and response close are distinct; unresolved final-message linkage leaves unknown completion coverage.
- [ ] Emit metadata for existing decision/permission/question resolution and explicit user stop/handoff actions after the existing authenticated action is accepted. Record only ID, typed action/result and timestamp. A resolved runtime event without a decision result ends the known wait but leaves the result unknown; it cannot overwrite a verified platform approved/rejected/answered outcome. Failed/replayed reply requests do not become extra interventions. Browser release or transport disconnect is a lifecycle interruption, not an explicit correction or takeover. If the platform has no correction label action, show unavailable correction coverage; do not add a new conversation workflow to manufacture the metric.
- [ ] Add a collector test with an in-memory sink and no runtime traffic:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createAnalyticsCollector } from "../src/agent-analytics-collector.mjs";
import { runId } from "../src/agent-analytics-contract.mjs";

test("one trusted run binding survives duplicate acceptance", async () => {
  const offered = [];
  const store = {
    offer: (fact) => { offered.push(fact); return true; },
    read: async () => null,
    status: () => ({ state: "ready", droppedEvents: 0 }),
  };
  const createObserver = () => ({ start: async () => {}, close: async () => {} });
  const collector = createAnalyticsCollector({ store, createObserver, now: () => 100 });
  const scope = { accountId: "account-a", runtime: "opencode", instanceId: "instance-a", generation: 4 };
  const binding = { scope, sessionId: "session-a", executionId: "turn-a", runType: "conversation", category: "unclassified" };
  collector.bindRun(binding);
  collector.bindRun(binding);
  assert.equal(new Set(offered.filter((fact) => fact.kind === "run").map((fact) => fact.runId)).size, 1);
  assert.equal(offered.find((fact) => fact.kind === "run").runId, runId(scope, "session-a", "turn-a"));
  await collector.close();
});
```

A duplicate may enqueue an identical fact; the sink/store identity makes the observable count one. The test must also assert that runtime/start/model methods are never called.

- [ ] Run focused suites; expected existing research checks and accepted/replayed/rejected/interrupt cases pass. Commit `feat(platform): record authoritative agent run lifecycles`.

## Task 6: Observe Live Tools, Skills, Usage and Child Activity Passively

**Create:** `packages/sdk/src/agent-analytics-observer.mjs`, `packages/sdk/test/agent-analytics-observer.test.mjs`. **Modify:** SDK exports, analytics collector, `services/platform/src/managed-worker-manager.mjs`, corresponding collector/manager tests.

- [ ] Write SDK stream fixtures for tool pending/running/terminal updates, explicit skill load, usage revisions, child linkage, session errors/retries, permission/question lifecycle, split SSE frames and oversized frames. Put private-content canaries in every fixture body and assert callbacks contain only safe metadata. Assert no catalog item becomes a skill-load count without a load event.
- [ ] Run `pnpm release:test packages/sdk/test/agent-analytics-observer.test.mjs`; expected observer missing.
- [ ] Export `./agent-analytics-observer` from the SDK to the Node ESM module; do not rely on Node 24 TypeScript stripping or import the TypeScript SDK entry from a Node 20 service. Match the pinned OpenCode event format and existing `OpenCodeClient` behavior using the same recorded fixtures. Avoid rewriting the frontend client.
- [ ] Implement the observer over the registered managed worker's authenticated event route. Verify the effective endpoint mapping in the isolated published baseline; use the existing worker-proxy read route, not an arbitrary endpoint bypass. The allowed operations are event subscription and, only where required for a verified parent link, a bounded metadata-only session read. No message-history/transcript/file reads or model probes. A successful known `skill` load tool event may supply only its registry-verified skill ID; reading a file named SKILL.md is not an inferred skill-use event.
- [ ] Cap an incoming SSE frame at 256 KiB, the decoded metadata fact at 4 KiB and partial-frame buffering at the frame cap. Drop oversize/unknown facts with a coverage notification and continue reading to preserve transport behavior. Discard source text immediately; log neither the body nor parser exception messages. Deduplicate terminal identities downstream, not by retaining raw frames.
- [ ] Give each verified worker generation at most one observer. Add optional `onWorkerReady` after health succeeds and the registered worker becomes running, and `onWorkerRevoked` on stop/replacement/unavailability. The existing `configureWorker` occurs before health readiness and is therefore not the ready hook. Start observation asynchronously; close the old generation before accepting its replacement's callbacks.

```js
// Added to the existing manager after successful registration/health/state change.
try {
  this.onWorkerReady?.({ context,
    access: { url: record.url, token: record.token } });
} catch { /* Observation is not execution admission. */ }
```

`main.mjs` constructs scope from `context.userId`, runtime, instance and generation, then calls `collector.workerReady`. Tokens/endpoints stay in memory. Do not increment active-operation counters, establish keepalive activity, alter idle detection or acquire a nonpassive lease. Revocation aborts the stream even when the browser remains open.

- [ ] Reconnect only while the same generation is still registered/running, with bounded backoff 1/2/4/8/15 seconds and one pending timer. On disconnect/reconnect, emit a gap; never call ensure/start/recover/restart. Initially attach to already registered running workers without probing dormant accounts. An in-memory `listWorkers` is not a complete account inventory.
- [ ] Normalize tool outcomes and explicit retries separately. Load count requires a known skill ID from an actual load event. Parent/child linkage requires a verified parent ID or child call reference; unmatched child/usage records remain unlinked. Collect usage updates once by message/call identity even with several browser tabs. Associate replayed facts only with a verified binding for their original execution/generation; an old history update cannot become a new current-generation call. Facts arriving before acceptance may be linked later only by verified message/parent IDs, never by timestamp proximity or the latest active session. Never add final message usage to broker attempts without a verified link; never invent model-call timing from a message timestamp.
- [ ] Run observer, collector and worker-manager suites serially. Expected stream canaries absent, no runtime creation/keepalive, stale-generation callbacks rejected and duplicate usage replaced. Commit `feat(sdk): observe live agent metadata without worker activity`.

## Task 7: Record Model Attempts Without Changing Streaming or Attribution

**Modify:** `services/platform/src/{model-broker,main}.mjs`, analytics collector/metrics integration. **Test:** `services/platform/test/model-broker.test.mjs`, `services/platform/test/agent-analytics-collector.test.mjs`.

- [ ] Add tests for early capacity rejection, authentication/grant rejection, provider rejection, first-byte/idle/total timeout, downstream abort and a successful backpressured stream. Assert one terminal metadata record per attempt and unchanged forwarded bytes/timing behavior. Untrusted requests must not claim an account through a body/header field.
- [ ] Run `pnpm platform:test test/model-broker.test.mjs test/agent-analytics-collector.test.mjs`; expected missing early-attempt telemetry, existing proxy behavior passes.
- [ ] Add an optional nonthrowing `onAnalyticsAttempt` callback wired to `collector.recordAttempt`. Emit once from `finally` for relevant model-route attempts, including failures before `modelRequest=true`. Exclude health, collaboration and network helper routes from model-call counts. Emit only typed route/provider/model/outcome/timing metadata; for early denial, provider/model/account may be null. Do not read private payloads a second time to manufacture attribution.

```js
// Safe terminal shape, sent after releasing existing timers/slots.
const attempt = {
  kind: "model_attempt",
  entityId: correlationId,
  startedAt: operationStartedAt,
  endedAt: this.now(),
  outcome: analyticsOutcome,
  code: analyticsCode,
  providerId: verifiedProviderId,
  modelId: verifiedModelId,
  firstByteMs: firstDataAt === undefined ? null : Math.round(firstDataAt - startedAt),
};
try { this.onAnalyticsAttempt?.(trustedContext, attempt); } catch { /* Never block streaming. */ }
```

Define `operationStartedAt=this.now()` at entry. Set `analyticsOutcome`/`analyticsCode` by a fixed mapping from existing broker outcome/error codes; `verifiedProviderId`/`verifiedModelId` come from the registered provider/model configuration, and `trustedContext` is non-null only after capability/identity validation. Use the contract's nullable nonnegative `firstByteMs`; never persist arbitrary error messages, routes with query strings, auth headers or request fingerprints.

- [ ] Keep unsupported/unlinked attempt and usage counts separate. No verified session/message link means no per-run attribution or apparent token-per-call efficiency. Unknown-authority broker rejections are displayed separately as unattributed broker requests; they do not inflate trusted agent-call or selected-account denominators. If no safe correlation is available in the existing adapter, retain that visible gap; do not add an invasive runtime plugin just to join records. Client-supplied session labels without authority are insufficient proof.
- [ ] Label broker latency `First byte`. Show unknown tokens for early/unreported attempts, not zero. Cost stays unavailable and provider-reported zero is not treated as a billed zero. Valid safety rejections are descriptive outcomes, not automatic run failures.
- [ ] Run broker streaming regressions plus all analytics backend/SDK suites serially. Expected identical byte/backpressure/slot-release behavior and accurate rejection/gap counts. Commit `feat(platform): record bounded model attempt metadata`.
- [ ] Review Checkpoint A: inspect a synthetic persisted cohort after replay/restart, inspect serialized fields and verify idle workers stop with the observer attached. Record only actual completed results in PROGRESS; do not publish a half-connected dashboard.

## Task 8: Expose Read-Only APIs Behind Server Admin Authority

**Create:** `services/platform/src/agent-analytics-routes.mjs`, `services/platform/test/agent-analytics-routes.test.mjs`. **Modify:** `services/platform/src/{platform-server,main}.mjs`, platform-server tests and analytics worker read queries.

- [ ] Add request-boundary tests for all six routes: anonymous 401, ordinary user 403, admin 200, disabled/expired/revoked session denial, identity error fail-closed, unknown run 404, strict filter/cursor errors and GET-only methods. A second ordinary account cannot bypass permission by supplying an admin's account/run ID. No response may contain canaries or paths.
- [ ] Run `pnpm platform:test test/agent-analytics-routes.test.mjs test/platform-server.test.mjs`; expected routes absent/denied until implementation.
- [ ] Dispatch exact analytics paths before worker bootstrap/proxy handling. Use the existing server administrator helper on every request, including detail. Authenticate before revealing validation, lookup or storage state. Do not infer administrator permission from runtime role/body/query data.

```js
// Inside the existing platform request handler, before #ensureWorker.
if (url.pathname === "/api/admin/agent-analytics" ||
    url.pathname.startsWith("/api/admin/agent-analytics/")) {
  response.setHeader("Cache-Control", "private, no-store");
  const admin = await this.#requireAdmin(request, response);
  if (!admin) return;
  await this.analyticsRoutes.handle(request, response, { admin, url });
  return;
}
```

The inspected helper is asynchronous and accepts both request and response; recheck that contract at execution and ensure its existing denial response completes the request. The policy is invariant: no store access without verified admin, no worker initialization on this path. Include `private, no-store` on denial responses as well.

- [ ] Implement exact route/method parsing and `parseAnalyticsFilter`. Use prepared parameterized queries; reject duplicate params, unknown keys, invalid IDs and body-bearing GETs. Return safe JSON error codes and 503 for storage/query unavailability; never serve simulated fallback data. Paginate events/children/model records as well as run rows. Return explicit truncation/cursors so detail is not silently incomplete.
- [ ] Build filter options from platform account metadata and retained event account IDs, without enumerating/probing workspaces. Current usernames follow the existing identity display contract; archived IDs get generic labels. Retention/capability/intervention queries share the same parent cohort predicate. Unknown account attribution never leaks into a selected account's totals.
- [ ] Each query obtains its metrics/rows/coverage/revision in one SQLite read transaction. The frontend can show later live revisions on subsequent refresh; do not pretend independent HTTP queries are one frozen historical snapshot. Stable run sorting/cursor prevents newly inserted later runs from duplicating prior pages; changing scope resets pagination.
- [ ] Run request and store/metric suites; expected authority, no-worker and scope parity pass. Commit `feat(platform): serve administrator agent analytics reads`.

## Task 9: Add the Typed Client and a Runtime-Independent Admin Menu Route

**Create:** SDK admin client; frontend analytics state/layout and their tests. **Modify:** SDK export, router, account menu/tests, `main.tsx`, `lib/{gatewayAccount,gatewayAccount.test,runtime}.ts`, login preparation/tests, targeted platform page/login handling and existing locale JSON files.

- [ ] Write failing SDK/state/layout/menu tests: admin entry appears while workspace unavailable; ordinary/standalone/desktop mode has no entry; direct route validates identity; logout/401/403 clears old data; stale responses cannot republish; query changes abort old work; mounting/focusing the layout produces no runtime requests; normal workbench login preparation still works.
- [ ] Run `pnpm test src/lib/adminAnalytics.test.ts src/app/layout/AdminAnalyticsLayout.web.test.tsx src/components/sidebar/GatewayAccountMenu.test.tsx src/lib/loginPreparation.test.ts src/lib/gatewayAccount.test.ts`; expected missing analytics state/layout and entry. Exercise SDK methods through injected fetch in `adminAnalytics.test.ts`, so URLs, credentials, safe errors and abort behavior are verified against the actual client.
- [ ] Implement and export `AnalyticsFilter`, `AnalyticsEnvelope`, `RunSummary`, `OverviewData`, `RunDetailData`, `CapabilityData`, `InterventionData`, `FilterOptionsData` and `AdminAnalyticsClient`. Keep HTTP/response-shape validation in this client. `RunSummary` includes safe ID/label, account ID, run type/category/outcome, recorded start/end, active/human wait/elapsed milliseconds, usage categories, coverage and delivery states; unknowns are null, not zeros.

```ts
export type AnalyticsRequestOptions = { signal?: AbortSignal };

export class AnalyticsApiError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(code);
  }
}

export class AdminAnalyticsClient {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  private async get<T>(path: string, query: URLSearchParams,
    decodeData: (value: unknown) => T,
    options: AnalyticsRequestOptions = {}): Promise<AnalyticsEnvelope<T>> {
    const suffix = query.size ? `?${query}` : "";
    const response = await this.fetchImpl(`/api/admin/agent-analytics${path}${suffix}`, {
      method: "GET", credentials: "same-origin", cache: "no-store", signal: options.signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new AnalyticsApiError(response.status,
      response.status === 401 ? "unauthenticated" : response.status === 403 ? "forbidden" : "analytics_unavailable");
    const envelope: unknown = await response.json();
    return validateAnalyticsEnvelope(envelope, decodeData);
  }
}
```

Define `validateAnalyticsEnvelope(value, decodeData)` in this file and pass an endpoint-specific `decodeData` function from each public method through `get`: schema 1, finite `asOf`/revision, typed bounded coverage and endpoint-specific bounded data validation. Add the public methods from the shared contract, serializing only route-approved filters; use typed endpoint validators, not an unchecked `as` cast of arbitrary JSON. Paths and error/status names must match Task 8.

- [ ] Implement `useAdminAnalyticsIdentity()` and `useAdminAnalyticsQuery()` in `lib/adminAnalytics.ts` around `createGatewayAccountLifecycle` in the effective source's `lib/gatewayAccount.ts`, not worker readiness. Extend that lifecycle with an optional `onIdentityState` callback and expose `refreshPlatformAccountIdentity()` in `runtime.ts`. Publish `gatewayIdentityState=unknown|ready|unavailable`; invalid identity JSON and request failure become unavailable for analytics while preserving existing independent sign-out behavior. Existing `load()` coalesces revalidation; it must not be blocked forever by the one-time runtime bootstrap flag. Do not create another login store. Maintain an identity epoch plus AbortController; role loss, logout/auth events and unmount clear cached data and cancel timers/requests. Revalidate identity on focus and every 30 seconds while visible; API denial clears immediately. An identity-service error hides analytics and clears it, rather than retaining previously authorized content.
- [ ] Coalesce reads by identity epoch, endpoint and normalized filters. Refresh visible data no faster than 30 seconds, stop polling in hidden tabs, cancel on scope change, and retain successful same-scope data during ordinary network errors with a visible stale time. On 401/403 or identity failure, clear it instead. No localStorage/IndexedDB/service-worker persistence of analytics payloads.
- [ ] Add a sibling `/admin/agent-analytics` route outside `AppShell`, wrapped in `AdminAnalyticsLayout`. Reuse app-level theme/locale providers and existing menu/logout form. Add a `passive` option to `GatewayAccountMenu` (default false) to omit its runtime-catalog refresh effect on this layout. The menu item appears only when platform Web identity confirms `admin` and `gatewayIdentityState` is ready; direct desktop/standalone gateway access renders an unavailable/not-found view without API calls.

```tsx
// Router entry, before the workbench route; AdminAnalyticsPage is Task 10.
{
  path: "/admin/agent-analytics",
  element: <AdminAnalyticsLayout />,
  children: [{ index: true, element: <AdminAnalyticsPage /> }],
}
```

Add this explicit independent runtime hook, then test it with a worker client that throws on use:

```ts
export async function refreshPlatformAccountIdentity(): Promise<void> {
  if (!isPlatformWeb || platformBrowserSuspended) return;
  if (!platformAccount) installPlatformAccountLifecycle();
  await platformAccount?.load();
}
```

In the account menu use existing Radix item classes, a lucide chart icon and `t("sidebar.agentAnalytics")`, linking to the exact route. Keep existing settings and sign-out behavior. The layout displays current logo/brand, back-to-workbench navigation, safe identity status and an Outlet only after admin validation; it never invokes runtime bootstrap, model catalog or recovery.

- [ ] Protect the exact server page route before generic SPA roots. For anonymous page navigation use the existing login with a safe local return path; for ordinary users return 403 before serving protected navigation. Do not simply whitelist every `/admin/*` route. On HTML login whose validated destination is exactly `/admin/agent-analytics`, create the normal login session and redirect there without tenant worker prewarming or a worker-readiness overlay. Preserve ordinary login behavior.
- [ ] In `main.tsx`/`loginPreparation.ts`, skip worker-ready preparation only for that exact route; independent identity validation remains required. Reuse existing recovery-era account publication from the effective source through the exported independent refresh hook and identity-state callback. Do not cause module import side effects to start a runtime.
- [ ] Add English UI copy and matching keys to the seven existing `nav.json`/`pages.json` locales. Run focused tests, locale parity, `pnpm typecheck` and `pnpm lint` serially; expected no bootstrap requests, no stale-role content, unchanged normal login and translated menu. Commit `feat(web): add the protected agent analytics entry`.

## Task 10: Build All Four Views and Accessible Run Detail in the Platform Style

**Create:** `AdminAnalyticsPage.tsx`, five admin components, page/view tests. **Reuse:** accepted prototype interactions, current theme/brand/fonts and existing UI primitives.

- [ ] Write failing UI tests against typed fixtures for all four views and every analysis dimension. Cover 24h/7d/30d and account/category/run-type filters, outcome/search paging, signals opening the corresponding run filter, metric definitions, delivery versus completion, capability subtabs and intervention reasons. Assert unknown values render `Unavailable`/coverage, never invented zero/token/cost/quality scores.
- [ ] Run `pnpm test src/app/routes/AdminAnalyticsPage.web.test.tsx src/components/admin/AgentAnalyticsViews.web.test.tsx`; expected components missing.
- [ ] Implement URL-backed selected view and global filters. Use safe navigation state with these view IDs:

```ts
export type AnalyticsView = "overview" | "runs" | "capabilities" | "interventions";
export type CapabilityKind = "tools" | "skills" | "models" | "subagents";

export const ANALYTICS_VIEWS: AnalyticsView[] = ["overview", "runs", "capabilities", "interventions"];
export const CAPABILITY_KINDS: CapabilityKind[] = ["tools", "skills", "models", "subagents"];
```

Keep a fixed `to` anchor while paging a selected cohort. Overview auto-refresh and explicit Refresh advance it and refresh the whole view; a paged list or open detail preserves its cohort anchor until Refresh, rather than resetting the user's position every 30 seconds. Display the pinned range and last observation time explicitly. Scope changes reset cursors and drawer selection. Use server counts/charts, not recomputed counts from the current 50-row page. Show `Last updated`, timezone, sample counts and coverage. A mixed selection says `Execution completion`; research-only selection says `Task completion`.

- [ ] Build `AgentAnalyticsOverview` with the accepted metric-card rhythm, activity trend, task mix, recent runs and inspection signals. Use lightweight accessible SVG/CSS charts with textual values, theme tokens and a shared metric-definition dialog. Hide a comparative interpretation when the sample/coverage is absent; show a precise reason. No new chart library or decorative research score.
- [ ] Build `AgentRunTable` with safe generic labels, account, run type, outcome, recorded timings, tools and reported usage. Use Task 8 stable cursors and visibly bounded pages. Search only the safe labels/IDs supported by the API. Keyboard focus and phone actions remain reachable; table overflow stays inside its container.
- [ ] Build `AgentRunDrawer` using existing Radix dialog primitives: accessible title/description, focus trap, Escape close and trigger focus restoration. Show safe timeline, delivery checks, linked children, interventions and reported usage with their coverage. Page/truncate details visibly; opening the drawer never calls runtime/session/file APIs or reveals private research objectives, reasoning, tool outputs or paths.
- [ ] Build `AgentCapabilities` with Tools/Skills/Models/Subagents. Display samples, observed counts, explicit failures/retries and timing/usage gaps. Available-but-unused skills have no fabricated use count. Child wall times are not summed into parent elapsed time; repeated tool use is an inspection signal, not declared waste. Model comparisons disclose task mix and sample size.
- [ ] Build `AgentInterventions` with approvals, clarification, explicitly recorded correction/takeover and union wait time. Pending/rejected/answered remain separate; valid rejection is not automatically a defect. Missing correction labels show coverage unavailable. The page remains read-only; there are no stop/restart/disable/delete controls.
- [ ] Add loading, empty, stale, unavailable, forbidden and not-found states using existing page components/copy. Empty collected results differ from an uncollected historical window. Reuse `--surface`, `--surface-2`, `--border`, `--text`, `--muted`, `--accent` tokens, existing Inter/serif treatments, light/warm/dark settings and legacy theme fallback; do not bring the standalone preview CSS into the production bundle.
- [ ] Run focused page/view/layout tests and guarded typecheck/lint serially. Expected all interactions, definitions, authorization transitions and missing-data labels pass. Commit `feat(web): render complete agent analytics views`.
- [ ] Review Checkpoint B with synthetic data in the protected candidate: all five dimensions, normal account menu, direct URL, failed identity, empty coverage and drawer. Record evidence, not a claim of live collection acceptance.

## Task 11: Register Required Browser Gates and Verify Resource/Privacy Boundaries

**Create:** `apps/desktop/src/test/webAgentAnalytics.acceptance.test.mjs`. **Modify:** `scripts/dev/{web-release-policy,web-release,web-release.test}.mjs`; analytics/frontend tests where a boundary is missing.

- [ ] Add a release-selection regression asserting changes to analytics backend/SDK/UI/menu files require the `agent-analytics` browser group. Register that group in the existing browser runner, set `OSD_AGENT_ANALYTICS_ACCEPTANCE=1`, and include the exact new test path. Full candidates include it. Unknown group, missing browser prerequisites, skipped required cases or a mismatched candidate bundle fail preparation.
- [ ] Run `pnpm release:test scripts/dev/web-release.test.mjs`; expected missing group before implementation. Make the selection/runner patch, then rerun; expected analytics files cannot publish without the required browser evidence. Preserve current image-input and live-runtime gates; do not weaken them to accommodate this feature.
- [ ] Implement the new acceptance test in the existing Vitest Node-environment/browser pattern. Use `OSD_PLAYWRIGHT_PATH`, `OSD_CHROMIUM_PATH` and `OSD_WEB_CANDIDATE` from the release runner. Start a temporary real PlatformServer/AuthStore plus the real analytics store with safe fixture facts, serving the exact candidate bundle. A fake worker manager throws/counts any ensure/start/recover/model access. The analytics service stays real; do not mock authorization as a successful JSON fixture.
- [ ] Add browser cases B01-B09 below. In each relevant case, record forbidden runtime requests and assert the set is empty; read-only analytics requests and `/api/me` are allowed. For a menu mounted on an already-open normal workbench, compare request deltas after navigating into analytics rather than claiming the workbench never opened its runtime.

```js
// @vitest-environment node
import { expect } from "vitest";

export async function assertNoAnalyticsOverflow(page, width) {
  await page.setViewportSize({ width, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const metrics = await page.locator("main").evaluate((element) => {
    const style = getComputedStyle(element);
    return { width: element.getBoundingClientRect().width,
      text: style.getPropertyValue("--text").trim(),
      surface: style.getPropertyValue("--surface").trim() };
  });
  expect(metrics.width).toBeLessThanOrEqual(width);
  expect(metrics.text).not.toBe("");
  expect(metrics.surface).not.toBe("");
}
```

The helper belongs in the acceptance file and is used after filters, menus and drawers are opened; checking only the initial page is insufficient. Capture screenshot artifacts for the accepted themes and verify computed fonts/colors/radii against existing same-theme workbench controls. Do not claim a manual visual review if only DOM/style assertions were available.

| ID | Required candidate browser behavior |
| --- | --- |
| B01 | Admin entry in the existing menu; ordinary account entry absent; direct ordinary page/API/detail denied. |
| B02 | Anonymous HTML login to the exact analytics destination creates no worker; expired/disabled/logout identity clears content; authentication outage fails closed. |
| B03 | Admin with unavailable/dormant workspace can open/reload/focus/filter analytics with zero ensure/start/recover/model calls. |
| B04 | Overview, runs, capability subtabs and interventions agree with the fixture cohort, not just the current page; all five dimensions are reachable. |
| B05 | Range/account/category/run-type/search/outcome changes reset paging; signal drill-down opens the correct scope; run drawer detail remains scoped. |
| B06 | Duplicate events and usage revisions produce one count; missing usage/cost/correction/timing appear unknown; checks do not claim scientific correctness. |
| B07 | Light/warm/dark at 1440/390/320 widths: reachable controls, internal table scroll, no page overflow, drawer focus/Escape/restore and readable definitions. |
| B08 | Two browser contexts do not double collection/counts; role revocation and delayed responses cannot restore old admin content or leak caches. |
| B09 | Canary prompts/reasoning/tool fields/paths/credentials are absent from UI responses, logs produced by analytics, DB and journal; no control/mutation action appears. |

- [ ] Exercise overload with small fixture limits: suspended worker, 256 queued events, dropped-fact counter, query deadline, 30-day expiration and disk ceiling. Assert a streaming broker fixture still releases slots, honors backpressure and forwards identical bytes while analytics is stalled. Do not use broad host OOM or fill real user storage as a test.
- [ ] Run the following commands sequentially from the isolated checkout; expected focused suites, full existing suites, typecheck/lint and bounded Web build pass. Required browser flags/prerequisites are supplied by the release runner rather than marking skipped optional tests as acceptance.

```bash
pnpm platform:test test/agent-analytics-contract.test.mjs test/agent-analytics-store.test.mjs test/agent-analytics-collector.test.mjs test/agent-analytics-routes.test.mjs test/research-tasks.test.mjs test/model-broker.test.mjs test/managed-worker-manager.test.mjs
pnpm release:test scripts/dev/web-release.test.mjs scripts/dev/analytics-dependency.test.mjs
pnpm test src/lib/adminAnalytics.test.ts src/app/layout/AdminAnalyticsLayout.web.test.tsx src/app/routes/AdminAnalyticsPage.web.test.tsx src/components/sidebar/GatewayAccountMenu.test.tsx src/lib/loginPreparation.test.ts src/lib/gatewayAccount.test.ts src/i18n/parity.test.ts
pnpm platform:test
pnpm test
pnpm typecheck
pnpm lint
pnpm web:build
```

Repeat only after new changes/failures justify it. A failed build leaves the deployed bundle untouched. Commit `test(web): gate admin analytics authorization and collection`.

## Task 12: Validate Real Collection and Prepare a Reviewable Product Release

**Files:** required browser/live acceptance cases, release evidence and `PROGRESS.md`; feature fixes only if verification exposes a concrete defect.

- [ ] Inspect the candidate through the existing release tool and review its source delta against the current effective published source. Confirm only the feature and approved baseline are present, dependency lock/install identities match, and no other worktree's files are included.

```bash
pnpm web:release inspect --source "$PWD"
pnpm web:release prepare --source "$PWD" --full
```

Expected: a frozen candidate with passing selected gates and a concrete release ID, or a precise reported blocker. Use the prepared manifest/ID returned by the tool, not the former prototype or an arbitrary `dist` directory. If lock-held production activity requires maintenance, use the existing authorized maintenance path; do not bypass the host locks.

- [ ] Run real acceptance against the exact candidate backend/bundle and enabled OpenCode using a new synthetic acceptance workspace. Authentication secrets stay in memory, never command output/screenshots/provenance. Establish one accepted conversation turn and one structured research execution with existing completion checks. A user-visible runtime event and persisted analytic fact must share verified identity where supported; unlinked broker activity remains visibly unlinked.
- [ ] For the conversation turn, use a benign synthetic file-read task and its real tool event. Verify reported usage replacement and final boundary. Open a second browser, reload, close the original tab and confirm collection continues independently without duplicate counts. Do not change existing research page-release/stop policy to force that research run to continue; that policy has its own recorded pause/interruption outcome.
- [ ] Exercise an explicit approval/clarification and a stop/cancellation through existing product actions if those actions are available in the test scenario. Verify union wait duration and explicit action semantics. For correction labels or adapter fields that do not exist, acceptance is an honest unavailable coverage state, not a fabricated live event. Preserve deterministic failure/rejection/retry fixtures for paths that would be disruptive to force in production.
- [ ] Check a model rejection/timeout through the isolated broker fixture and real success through OpenCode. Verify no analytics query starts dormant workers, keeps them active, or issues additional provider traffic. Confirm the candidate's owner/instance/generation boundaries, safe metadata, final tool count and token coverage after a controlled service restart; terminal and interrupted states must remain distinguishable.
- [ ] If the selected release policy requires a source-matched CI-attested science image, satisfy that existing requirement before publication. Updating release-policy code may itself be an image input under current rules even though analytics adds no native runtime code. Do not reuse an unmatched artifact, modify the fingerprint scope to make one match, or call the feature deployed while this gate is blocked.
- [ ] Review Checkpoint C evidence: B01-B09, real runtime identity/completion, bounded overload, safe fields, preserved existing conversations/workspaces and compatible rollback. Keep the schema additive and analytics failure optional for older backend versions; old releases may hide analytics but must not fail ordinary account traffic. Retain the analytics state file on rollback and never delete user data.
- [ ] When the user has authorized product deployment, publish through `pnpm web:release deploy --release` using the actual prepared release ID. Verify public admin route/menu, anonymous/ordinary denial, login destination, served asset/source identity, persistence and absence of runtime traffic from analytics. If a deployment fails, use the release tool's rollback with the failed current transaction ID; retain existing protected preview and recoverable data.
- [ ] Add a newest-first English PROGRESS milestone with exact test/candidate/release evidence and any remaining coverage limits. Commit feature verification as `test(web): verify live agent analytics and release boundaries`. Report measured dimensions and known gaps separately; prototype acceptance is not the product release result.

## Spec Coverage and Self-Review

| Spec requirement | Implementation tasks | Acceptance evidence |
| --- | --- | --- |
| AA01: admin menu, direct/API/detail authority and revocation | 2, 8, 9, 11 | Request boundary tests, B01/B02/B08. |
| AA02: identity independent of workspace; no bootstrap or provider calls | 5, 6, 8, 9, 11, 12 | Throwing/counting worker fixture, B02/B03, real traffic delta. |
| AA03: current platform visuals and desktop/phone usability | 9, 10, 11 | Existing tokens/fonts/brand, B07 at 1440/390/320 in all three themes. |
| AA04: all five dimensions and research/conversation meaning | 4, 5, 6, 7, 10, 12 | Typed facts, B04/B06, real research/turn records and explicit unsupported gaps. |
| AA05: replay, retries, children, multiple devices and restart | 2, 3, 4, 5, 6, 7, 11, 12 | Identity/upsert/ordering tests, B06/B08, real second browser/restart. |
| AA06: common cohort, UTC range, filters, denominator, pagination | 2, 4, 8, 10, 11 | Single predicate/read transaction and data revision, B04/B05. |
| AA07: delivery versus science; descriptive comparisons and unknown usage | 4, 7, 10, 11 | Metric tests, B06, definitions/coverage labels. |
| AA08: intervention semantics and nonadditive wait/child timing | 4, 5, 6, 10, 12 | Wait-union fixtures, typed decisions, explicit stop/clarification or coverage gap. |
| AA09: bounded collection/queries, streaming and metadata privacy | 1, 2, 3, 6, 7, 8, 9, 11 | Guard/native smoke, queue/disk/read limits, stream parity and B09 canaries. |
| AA10: bounded existing release gates; failed stage preserves production/data | 1, 11, 12 | Guarded build, required browser registry, source/image identity and rollback evidence. |

Self-review checklist for the implementing engineer:

- [ ] Reconcile the effective published baseline at execution, not just the dirty main checkout.
- [ ] Keep endpoint/filter/enum/client names identical across contracts, routes, SDK and UI.
- [ ] Never trust runtime-authored account identity, private text or a syntactically valid but unregistered capability name.
- [ ] No transport-accepted event, server exit, missing usage or catalog availability is silently upgraded into completion, zero usage or skill use.
- [ ] Shared run cohort and explicit response revision are used by all metrics; counts do not come from a page subset.
- [ ] Opening/login/refresh/focus on analytics and passive observation preserve runtime admission/idle behavior.
- [ ] Unsupported or unattributed data remains visible as coverage, and correction/takeover are explicit actions only.
- [ ] No science-quality score, account quotas, hidden destructive controls, transcript backfill or replacement design system is introduced.
- [ ] Each checkpoint is reviewed and measured before its PROGRESS completion line or deployment claim.

This document provides the requested implementation handoff. It does not authorize execution or delegation on its own.

Document self-review completed on 2026-10-14: all ten spec acceptance IDs map to implementation tasks and concrete evidence; API/method names and missing-data semantics were reconciled; the async admin helper, independent identity failure signal, private research telemetry revision, unattributed attempt identity and frozen SDK source boundary are explicit. No implementation checklist is marked complete by this document review.
