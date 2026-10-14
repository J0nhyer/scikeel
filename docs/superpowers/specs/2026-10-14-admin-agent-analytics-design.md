# Administrator Agent Analytics

Date: 2026-10-14
Status: Interactive prototype accepted by the user; product design finalized.
Scope: The public multi-user gateway Web client.

## 1. Goal and approval

Give administrators a dedicated menu entry for understanding agent execution:
what work was attempted, how it proceeded, what capabilities it used, where
people intervened, and which outcomes have recorded evidence.

The user requested all five analysis dimensions, corrected the entry to a normal
menu item, required the existing platform visual style, and accepted the deployed
interactive prototype on October 14, 2026. This approval finalizes the design;
it does not represent approval to start product implementation or a release.

The prototype at `/preview/agent-analytics` remains a design preview with explicitly
simulated data. Its source is `examples/agent-analytics-preview/`. Its administrator
access checks use the real platform identity endpoint. No live model calls or
production analytics collection were added by publishing the prototype.

## 2. Entry and visual integration

- Add `Agent analytics` to the existing account menu, visible only to an
  authenticated administrator in the multi-user gateway Web client.
- The product route is `/admin/agent-analytics`. Direct access receives the same
  authorization checks as access through the menu.
- Resolve account identity independently of worker readiness. An unavailable
  workspace must not hide the menu or prevent analytics from loading.
- Use a layout that does not bootstrap the user's research runtime. Opening,
  refreshing or filtering analytics must not start, recover or restart workers.
  Signing in with the analytics route as the destination must retain this rule.
- Reuse platform theme variables, Inter typography, the current platform logo,
  Source Serif brand treatment, control radii, line icons and account-menu styles.
  Follow the persisted `ai4s.theme.v2` setting and existing legacy fallback.
- Preserve the platform's inherited branding while its migration is in progress.
- Support desktop and 390/320-pixel phone layouts. Navigation and wide tables can
  scroll within their own containers; the page must not overflow horizontally.
- The deployed prototype demonstrates the menu inside its own preview. The
  production workbench account menu has not been changed.

## 3. Information architecture

Use one analytics destination with four views and one run-detail drawer.

| View | Purpose | Contents |
| --- | --- | --- |
| Overview | Identify patterns and choose what to inspect | Outcome counts, completion denominator, active time, reported tokens and coverage, human involvement, activity trend, task mix, recent runs and inspection signals |
| Task runs | Inspect results and execution | Searchable and paginated runs, explicit outcomes, failure categories, recorded time and tool counts; each row opens the run detail |
| Tools & models | Understand capability use | Four tabs: Tools, Skills, Models and Subagents; show counts, samples, timing, explicit failures/retries and usage coverage |
| Human interventions | Understand collaboration | Approvals, clarifications, explicitly labeled corrections and recorded takeovers; separate human wait time and decision results |

The run drawer shows safe run metadata, an execution timeline, delivery-check
outcomes, linked child activity, interventions, model calls and usage coverage.
Passing delivery checks must not be described as establishing scientific accuracy.

Global filters: 24 hours, 7 days or 30 days; account; task category. Task runs also
have search, outcome filtering and pagination. Inspection signals open the run
list with the relevant filter applied. UTC defines time windows, and the displayed
timezone is explicit. The run cohort is selected by execution start time in the
half-open interval `[from, to)`. Linked child activity contributes to its selected
parent once; independent, unattributed model attempts use their own start time
and are displayed separately. Counts and charts use the same selected dataset.
Each response includes its observation time and data revision; live updates must
not silently mix revisions within a summary.

The prototype contains only structured research runs. Real data must distinguish
structured research executions from ordinary conversation turns. Add a small
`Run type` filter when both are present. A mixed selection uses `Execution
completion`; `Task completion` is reserved for structured research executions.
Unknown task categories remain `Unclassified`; do not classify private text.

## 4. Analysis units and outcome meaning

An agent run is one top-level work execution, not an entire conversation and not
an individual model call. A structured research task has a separate run for each
execution. An ordinary conversation turn can produce an execution record with a
clearly labeled run type and a weaker completion meaning.

Stable identity includes the authenticated account, runtime, instance, generation,
session and execution/turn identifier. A restart or resumed execution cannot
silently overwrite another run. Child sessions link to their parent execution;
model and tool calls each have their own stable identities.

Run outcomes are completed, failed, cancelled, paused, waiting for input, running,
and unknown/interrupted. `Ready` research briefs that have never executed are not
agent runs. A process exit or server restart alone cannot establish completion.

For structured research tasks, retain the existing output/evidence/input checks
as the authoritative completion rules. For ordinary turns, a verified final turn
boundary means only that agent execution finished. HTTP acceptance and transport
completion are recorded separately from either outcome.

## 5. Metric definitions

| Metric | Definition and limits |
| --- | --- |
| Completion | Completed divided by completed + failed + cancelled runs within the same run type; show numerator and denominator. Active, paused, waiting and unknown runs are separate. |
| Delivery checks | Recorded output existence, validation evidence and input-preservation results. Preserve pending/unknown separately from failure; do not rate scientific correctness. |
| Typical agent time | Median measured run-active time for terminal runs, excluding recorded human-wait intervals. Missing start/end coverage makes the duration unknown. |
| Human wait | Measured union of wait intervals within a run. Overlapping permission/question waits must not be counted twice. Elapsed time includes these intervals. |
| Tool calls | Upsert by stable call ID. Count each terminal call once; separate completed, failed, rejected, cancelled and interrupted outcomes when the runtime supplies them. |
| Tool retries | Explicit retry events or linked attempts. Repeated use of the same tool is an inspection signal, not evidence of wasted work. |
| Skill loads | Explicit load events with a known skill identifier. Catalog availability alone is not use. Completion counts are descriptive and do not prove causal effectiveness. |
| Model calls | Individual attempts, with provider/model IDs and results. Retries count as attempts and remain linked to the logical operation where known. |
| Reported tokens | Sum known reported usage, upserting updates by stable message/call identity. Keep input, output, reasoning and cache categories distinct. Do not add categories with unknown overlap semantics into a fabricated grand total. Missing usage is not zero. |
| Usage coverage | Calls with usable usage divided by observed calls; disclose unattributed and incomplete calls. Avoid presenting a partial total as complete. |
| Response timing | Broker first-byte time is labeled as first-byte time. Do not call it first-token time without observing a token boundary. |
| Cost | Initially unavailable. Display estimates only with reliable usage and identified, dated pricing; keep provider-reported charges separate from estimates. |
| Delegation | Distinct linked child sessions and parent runs that delegated. Count child usage once; overlapping parent/child durations are not additive wall time. |
| Human involvement | Runs with an explicit intervention divided by observed runs. This is collaboration frequency, not a quality score. |
| Corrections | Explicit user labels or recorded correction actions. Follow-up messages alone do not demonstrate a correction. Missing labels mean unknown coverage. |
| Takeovers | A recorded handoff/stop action and its reason where explicitly known. A disconnect is not automatically a takeover. |

Model/agent comparisons show sample counts and task mix. They are descriptive,
not causal rankings. Account filters support investigation, not a user leaderboard.
Approvals, clarifications and valid safety rejections are not automatically defects.

## 6. Existing evidence and collection gaps

Verified repository contracts that can inform adapters:

- `services/platform/src/auth-store.mjs`: authenticated administrator/user roles.
- `services/platform/src/platform-server.mjs`: administrator authorization helpers.
- `services/platform/src/research-tasks.mjs`: execution identity, recorded task
  status, intervention decisions and delivery/evidence/input-preservation checks.
- `packages/sdk/src/types.ts`: normalized steps, tool lifecycle timestamps and
  child links, usage updates, session retry/error and permission/question events.
- `packages/sdk/src/OpenCodeClient.ts`: normalization and history contracts.
- The inspected production release's `services/platform/src/model-broker.mjs`:
  account/model/provider/outcome/duration/first-byte/byte-count operation logs.

These contracts are evidence of available fields, not proof of a complete durable
analytics feed. Browser event consumption alone is insufficient: closing a tab,
opening multiple devices or reloading must not lose or duplicate collection.

Add a platform-side, passive metadata collector for active runtimes and existing
lifecycle hooks. It must never start dormant runtimes or keep workers active just
to observe them. Use adapters that sanitize events before storage, retaining no
raw event bodies. Existing events must be replay-safe and usage updates must
replace prior values instead of being added again.

Broker collection must include rejection/timeout/cancellation paths that occur
before the current operation log is emitted. Keep model metadata and finalized
runtime usage separate until a verified identity links them. Unlinked activity
stays unattributed and its coverage remains visible.

No historical backfill from private transcripts or workspace file contents is part
of this design. Any unavailable historical period is labeled uncollected. A
collector disconnect or restart creates a visible coverage gap; never fabricate
terminal results or task classification to fill it.

## 7. Small implementation boundary

Reuse the platform service and current login. Do not introduce an independent
product backend, tracing platform, message queue, billing system or automated
scientific evaluator.

Use one platform-owned SQLite analytics file behind a small storage interface:
run summaries and normalized metadata events, with indexes for timestamp,
account, run identity and event/call identity. Account/auth storage is unchanged. Synchronous database work runs in one bounded
worker thread so it cannot block the platform streaming loop.
The SQLite adapter must support the repository's declared Node 20 minimum and
the selected deployment Node version; a deployment-specific Node upgrade is not
an implicit requirement of this design.

Expose read-only, administrator-guarded overview, runs, run-detail, capability and
intervention queries under `/api/admin/agent-analytics`. UI requests use a typed
platform/SDK interface; the frontend never calls OpenCode directly.

Bound event size, pending writes, query time and result size. Run lists use pages
of at most 50 rows; filters are validated and queries parameterized. Retain up to 30 days
of details with a storage ceiling and bounded cleanup; earlier eviction under
pressure reduces the advertised coverage window. Initial limits are 4 KiB per
normalized event, 256 pending events, batches of 32, at most eight pending reads,
a two-second read deadline, a 64 MiB database-worker JavaScript heap and a
128 MiB combined database/journal budget. Queue overflow, storage exhaustion or
a database-worker fault suspends or drops analytics work with a visible gap;
agent execution continues. These are analytics resource limits, not account usage
quotas. Cleanup runs incrementally rather than scanning private workspaces. Do not add a separate
long-term aggregate tier before there is a demonstrated retention need.

Refresh visible summaries at most once per 30 seconds and coalesce identical
queries. Analytics queries read stored metadata and lightweight platform state;
they do not recursively scan user files or probe every worker. Collection overload
must not delay model streaming or defeat backpressure; expose dropped events and
incomplete coverage instead of silently losing them.

## 8. Authorization and privacy

Only the server-authenticated `admin` role may access analytics data. Check every
API request, run detail and any future export; do not trust hidden menus, browser
state, query account IDs or runtime-provided account claims.

Unauthenticated API calls return 401 and ordinary accounts return 403. Protected
page navigation can direct an unauthenticated user to login with a safe return
path. Identity-service errors fail closed. Responses use private, no-store caching,
and analytics are cleared on logout, expiry or an observed role change.

Whitelist safe metadata: platform identifiers, known capability IDs, enumerated
results/error categories, counts, timestamps and durations. Use safe category/run
labels; do not collect free-form prompts, reasoning, messages, tool arguments,
outputs, diffs, private research objectives, filenames, file contents or arbitrary
error text. Do not expose absolute host paths, tokens, credentials or cookie/session
values. Administrator analytics do not bypass tenant workspace access policy.

The first product version is read-only. It has no stop/restart/disable/delete or
configuration actions. It does not introduce cumulative account quotas, credits
or usage limits; instantaneous resource protections remain intact.

## 9. Availability and unsupported measurements

Initially validate real collection with the currently available OpenCode runtime.
Preserve model/provider and runtime adapter boundaries. Other adapters expose
only supported measurements and explicit gaps; unsupported fields are not zero.

Claude remains excluded from live tests and release gates unless the user confirms
service restoration. Do not probe alternate Claude models/endpoints as part of
this work. Disabled or unavailable runtimes are not counted as observed failed runs.

## 10. Acceptance conditions

1. **AA01:** Only admin sees the workbench menu item; direct page/API/detail access is
   protected, including expiry, logout, ordinary users and identity outages.
2. **AA02:** Analytics loads when the administrator workspace is unavailable; navigation,
   login-to-analytics and refresh create no worker/model activity.
3. **AA03:** The page follows the same logo/fonts/theme setting and remains usable at
   desktop, 390 and 320 widths, including menus, filters, tables and the drawer.
4. **AA04:** All five requested dimensions have views, records or explicit coverage gaps.
   Structured tasks and conversation turns have visible, separate outcome meaning.
5. **AA05:** Each call and child is counted once across updates, retries, reconnects,
   multiple browsers and restarts; interrupted data stays unknown where necessary.
6. **AA06:** Charts, filters, summaries and paginated details agree on their selected scope,
   UTC window, sample count and metric definition.
7. **AA07:** Delivery checks and completion are distinguishable from scientific correctness;
   model comparisons remain descriptive and expose unknown usage.
8. **AA08:** Interventions separate approvals, clarifications, explicit corrections and
   takeovers; human waits and concurrent child durations are not double-counted.
9. **AA09:** Collection and reads are bounded, preserve streaming backpressure, reveal gaps,
   and do not persist or return private content, paths or credentials.
10. **AA10:** Publication uses the existing bounded Web build/release gates. A failed stage
    leaves the production bundle and recoverable user data intact.

## 11. Validation already completed

The published prototype passed four guarded fixture/browser checks covering metric
calculation, authorization, authentication outages and interactive views, including
light/warm/dark themes and 1440/390/320 widths. Public-origin verification used an
actual admin login, exercised the menu and analysis views, verified logout
revocation, and confirmed the preview's browser traffic stayed within its own
protected route. Its persistent preview service has a 128 MiB memory ceiling.

These checks validate the prototype and its access boundary. Real collection,
persistence, adapter coverage and production product integration remain future
implementation work; prototype acceptance does not certify those capabilities.
