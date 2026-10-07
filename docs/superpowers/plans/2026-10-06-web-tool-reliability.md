# Web Tool Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make authorized Web network tools execute with scoped egress, preserve actionable failures, and recover without duplicate mutations or false cancellation claims.

**Architecture:** The gateway owns approval and network-operation state; the pinned OpenCode tools obtain a capability only after their existing permission check and use per-request proxy transport. Collaboration and network errors share a bounded safe outcome contract, which the gateway adds to SDK events/history without rewriting runtime evidence. Existing tool rows and publication/image workflows are extended rather than replaced.

**Tech Stack:** Node.js ESM and node:test; pinned OpenCode 1.18.32 / Bun 1.3.14 / Effect; React, TypeScript, Vitest, Playwright; gVisor tenant image and existing guarded pnpm tasks.

---

## Approval and execution rules

The user approved the spec and requested this plan. Implementation, live fault injection, image production, and publication require subsequent user authorization. None of this plan's execution checkboxes has been completed by writing the document. Execute inline using `superpowers:executing-plans` unless the user separately authorizes agent delegation. Do not ask for that choice during this plan-only task.

Approved spec: `docs/superpowers/specs/2026-10-07-web-tool-reliability-design.md`. Plan date: October 6, 2026 (UTC). Capture actual timestamps with the project-local timezone when execution milestones occur.

Run heavy checks sequentially through package scripts. Never call Vite, Vitest, Cargo, upstream Bun build/test/typecheck, or parallel heavy jobs directly on this production host. Never set `CI=true` to bypass the managed runtime build restriction. Dedicated CI performs the full upstream runtime build. Use the existing image attestation and resumable Web publication workflow; do not introduce deployment shell scripts or copy candidate files over production by hand. Preserve user data and unrelated checkout modifications.

## Execution evidence (October 7, 2026)

The implementation checkout is `.worktrees/web-tool-reliability-2026-10-06`, branch `feat/web-tool-reliability`, with effective production baseline committed as `87695fd`. The baseline platform source is `.deploy/web-releases/2026-10-06T20-14-35-561Z-a8b6bfe7/source`; its served Web bundle remains `.deploy/web-releases/2026-10-06T19-33-59-757Z-4974f3fc/web`. Baseline fingerprints and red/green logs are in the ignored `.deploy/verification/web-tool-reliability/` directory.

The pinned native acceptance reproduced zero scoped authorizations after permission allow before the patch. The patched source passes deny/allow ordering, explicit HTTP proxy credentials, certificate-verified HTTPS CONNECT, two additional read attempts, and no retries for upstream 403. Browser acceptance passes at 1280px and 360px using the built candidate, including live failure details, Stop, invalid-tool status and history reload. Full CI compilation, attested-image installation and live installed-stack acceptance remain required; these results do not constitute deployment acceptance.

There is no administrator-selected search backend in the current deployed configuration. The initial candidate at `7d80e0a` hid the managed V1 search advertisement and rejected direct search invocations with `search_unavailable`. The authorized follow-up adds the optional administrator field `"searchProvider": "parallel"` to `/etc/scikeel/model-brokers.json`, reusing the pinned tool's existing key-free backend. Without this field, search remains unavailable; the server never takes backend URLs from model arguments, rotates providers, or shares new credentials. The managed runner passes the selected provider only through trusted child environment variables and removes the SciKeel-only field before writing the OpenCode config. Manual search approval uses the owned call/query request and the administrator-derived origin rather than trying to parse a query as a URL. Unmanaged search behavior remains compatible. A linked sparse pinned source checkout reuses existing dependency bytes; full runtime builds stay CI-only. Low free disk space and incomplete full-checkout fetching were investigated using existing sparse-source and build/cache patterns; no deployed bundle, historical release or user data was deleted.

## Planning evidence and implementation decisions

The inspected production service source is `.deploy/web-releases/2026-10-06T10-00-57-668Z-78253dd5/source`; re-inspect it before execution. The approved spec distinguishes verified code paths from historical diagnostic leads.

A local source checkout contains upstream commit `545f51d26cc39a907d2867492d498d9607ea5fa4`, tree `b443aa2f11f402603d7911040fc9067ad65cf475`, corresponding to the existing managed-runtime lock. Its V1 `packages/opencode/src/tool/webfetch.ts` and `websearch.ts` call `ctx.ask(...)` immediately before transport; the native harness must confirm that the installed managed entry uses this path. This is the selected insertion point, not `tool.execute.before`. The V2 equivalents under `packages/core/src/tool/` call `permission.assert(...)`; use the same shared helper after that assertion and retain unmanaged behavior in both paths. Verify installed binary/manifest identity and demonstrate the ordering in Task 1 before patching.

Use Bun's explicit per-request `proxy` option, never shared environment mutation. Its current official documentation describes proxy credentials and manual redirects, but pinned-version compatibility must pass a Bun 1.3.14 transport test, including HTTP and HTTPS CONNECT. Primary references are recorded here as research references, not proof that the installed runtime works:

```text
https://bun.sh/docs/runtime/networking/fetch
https://raw.githubusercontent.com/oven-sh/bun/bun-v1.3.14/packages/bun-types/globals.d.ts
```

Select the existing administrator-enabled search backend and verify that its server-side origin matches the pinned tool's selection. Do not accept a backend URL from a query or returned link, and do not add a provider fallback. A shared search credential, if required, stays outside the tenant: mark that search path unavailable until its configured gateway adapter can use it safely; do not copy it into runtime configuration.

Deliver one connected feature in two slices: Tasks 1–8 complete network authorization and error transmission; Tasks 9–10 finish recovery/presentation; Tasks 11–12 verify the installed stack and publish only when authorized. Intermediate commits are reviewable, not independently deployable with mismatched image/backend/frontend.

## File map

Canonical paths below refer to an isolated checkout based on the effective deployed source, not the dirty main checkout.

| Files | Responsibility |
| --- | --- |
| `packages/sdk/src/tool-outcome.mjs`, `tool-outcome.d.mts` (new), `packages/shared/src/toolOutcome.ts` (new) | Safe closed outcome contract, size bounds, shared public type |
| `services/platform/src/collaboration.mjs`, `model-broker.mjs`; `runtime/sandbox/collaboration.mjs` | Business errors and route-specific safe serialization |
| `services/platform/src/egress-broker.mjs` | Granular grant revocation and connection ownership |
| `services/platform/src/network-operations.mjs` (new) | Bounded operation/approval bookkeeping and policy-to-grant authorization |
| `services/platform/src/tool-outcomes.mjs` (new) | Bounded safe outcome history and explicit Stop records, with no bearer storage |
| `services/platform/src/platform-server.mjs`, `sandbox-control-plane.mjs`, `tenant-policy.mjs`, `main.mjs` | Authenticated approval observation, `/network` dispatch, lifecycle hooks and history enrichment |
| `runtime/opencode-patches/network-transport.ts`, `network.patch`, `network.lock.json` (new) | Shared post-permission adapter, patches to V1/V2 tools, immutable patch identity |
| `runtime/sandbox/runner.mjs`, `cli-jobs.mjs` | Managed adapter activation with the existing restricted bridge token |
| `scripts/dev/build-opencode-title-runtime.mjs`, `safe-desktop-task.mjs`, `package.json` | Preserve title patch while checking/building combined runtime through guarded scripts |
| `scripts/dev/prepare-science-image.mjs`, `stage-sandbox-image.mjs`, `web-release.mjs`, `web-release-policy.mjs`, `.github/workflows/sandbox-image.yml` | Combined runtime attestation, image identity and registered acceptance |
| `packages/sdk/src/OpenCodeClient.ts`, `types.ts`; `packages/shared/src/index.ts`; `apps/desktop/src/lib/runtime.ts` | Same outcome normalization for live events and reopened history |
| `apps/desktop/src/components/thread/ToolCallRow.tsx`, existing locale `session.json` files | Reason, next action, cancellation/interruption and accessible details |
| Existing affected tests plus new tests named under each task | Deterministic reproductions and actual browser/runtime coverage |
| `PROGRESS.md` | Actual completed milestone or blocker, newest first |

Export the canonical ESM outcome contract through `@ai4s/sdk/tool-outcome`, pointing at `./src/tool-outcome.mjs` with `./src/tool-outcome.d.mts` declarations. The Node platform imports that source directly; browser code uses the package export. Copy the same bytes into the image as `/opt/scikeel/tools/tool-outcome.mjs` for the collaboration plugin, and attest the source and resource digests. Task 6 adds that exact SDK module to `imageInputPath` and updates image-context/runnerFiles allowlists. Keep one parser implementation, with pure browser-compatible code and no Node-only imports.

## Contract used by all tasks

The safe error response is `{error: outcome}`. `outcome` contains `version: 1`, `code`, `category`, `source`, optional HTTP `status`, `message`, `nextAction`, `retry`, `correlationId`, and optional allowlisted `details`. Use the spec's closed code table; no runtime exception can create a new code. Serialize at most 8 KiB. Never put prompts, search query text, proxy URLs, authorization headers, tokens, arbitrary exception text, or host paths in this object.

Define these production interfaces in their named tasks:

```ts
type RuntimeContext = { userId: string; instanceId: string; generation: number };
type NetworkCall = {
  sessionId: string; ownerSessionId: string; callId: string; execution: number;
  tool: "webfetch" | "websearch"; origins: string[]; budgetMs: number;
};
type Authorization = {
  allowed: boolean; expiresAt: number;
  permissionRequestId?: string; kind: "automatic" | "once" | "always";
};
type OperationGrant = {
  operationId: string; grant: string; expiresAt: number; deadline: number;
};
```

`NetworkOperations` receives `{egress, resolveCall, authorizeCall, outcomes, now, randomId}`. Its constructor stores these fields, initializes `operations`, `usedCalls` and `queues` Maps/Sets, and uses `crypto.randomUUID`/`Date.now` defaults; its owned grant reverse index receives only EgressBroker-observed failure metadata. `resolveCall(context, proposal)` returns the gateway-validated `NetworkCall` from the owned runtime tool part plus current execution, never merely echoing caller arguments. Its `ownerSessionId` is the validated root execution owner (the same ID for a root call), allowing root Stop to match owned descendants without cancelling unrelated conversations. Its `budgetMs` is derived from that tool's validated timeout/default and is at most 120000; it is an internal field, not accepted from `/network` callers. Grant expiry must honor that shorter budget as well as the lease. `authorizeCall(context, call)` returns `Authorization` from current gateway policy or authenticated approval records. Manual permission request identifiers are resolved by the gateway from the recorded call/request association; the runtime does not invent them. If supplied in a request, an identifier is only a consistency check.

Public methods are `authorize(context, proposal)`, `continueOrigin(context, operationId, origin)`, `finish(context, operationId, detail)`, `cancelExecution(context, sessionId, execution, reason)`, and `revokeContext(context)`. Only `authorize`, `complete`, and `cancel` are allowed `/network` actions; a cross-origin continuation uses `authorize` with its existing `operationId`. A caller cannot choose identity, proxy address, arbitrary callback, HTTP headers or shared credentials through this route.

`ToolOutcomes` receives `{rootDir, now}` and exposes `record(owner, callId, outcome)`, `recordStop(owner, callIds)`, and `list(owner)`; `owner` includes authenticated user/session and execution. Runtime completion may report safe upstream/runtime results but may not assert a gateway denial, user Stop, or verification of scientific outputs. Grant bytes are never persisted.

Final local checks: 1,883 frontend tests passed (27 existing conditional skips), 363 platform tests passed (6 conditional skips), and all 41 release/cache checks passed. Typecheck, lint and the guarded Web build passed. Both pinned native source gates passed without skips, and the final built Web bundle passed two consecutive browser runs at 1280px and 360px, including keyboard-operated details, Stop and reload. Browser startup now follows the existing session fixture by awaiting history hydration and SSE readiness before publishing tool events. Compiled-image and production acceptance have not run.

The follow-up native search test uses a query-only invocation. It reproduced HTTP 400 from the pinned runtime's permission-list endpoint when absent optional parameters were included as `undefined` metadata. Passing every optional parameter made the same test pass; the pinned patch now omits absent optional fields from permission metadata while preserving provider defaults. The regression requires the pending permission to be readable, denial to issue no grant/request, and allowance to return source references.

Follow-up verification: the query-only native search passed with readable manual approval and zero requests after rejection. The optional public acceptance passed against the real Parallel MCP endpoint and fetched the real Python `pathlib` documentation using a distinct scoped grant, with certificate verification and no API key. The affected full platform suite passed 366 tests (6 conditional skips); the local runtime check and both native title/network gates passed. The deployed administrator configuration and release identities remain unchanged. Enable `searchProvider` only when publishing the matching gateway and attested runner/runtime image together; the currently deployed parser does not accept this new field. CI access is not available in this session (`gh` is absent and no `GH_TOKEN`/`GITHUB_TOKEN` is set), so the attested image and installed-stack acceptance remain outstanding.

Local implementation status: Tasks 1–5 and 7–10 have a reviewable implementation and deterministic coverage. Task 6 has the combined runtime recipe, exact source/resource hashes and image validation, but no CI artifact has been produced here. Task 11 registers the staged-browser and native-runtime gates; installed-stack acceptance is still pending. Task 12 remains gated on publication authorization and the exact CI-attested image. Unchecked publication and installed-runtime steps below must not be interpreted as completed.

The tool browser scenario reuses the existing `session` release group instead of introducing a separate group or live-test command. Tool adapter, operation/store, SDK and row changes select that group, and a source containing the network lock requires the scenario to exist and execute. This follows the current release pattern while keeping one browser pipeline. Native coverage also verifies deadline-bound body reads, runtime abort, and a rejected cross-origin redirect; authority revocation precedes diagnostic writes even when storage fails.

## Task 1: Freeze the effective baseline and prove the permission insertion point

**Read:** effective service source and image/runtime manifests; approved spec; current release tools; pinned upstream V1/V2 networking tools.
**Future files:** isolated linked worktree `.worktrees/web-tool-reliability-2026-10-06`; `runtime/opencode-patches/network-native.acceptance.mjs` (new); bounded baseline evidence in ignored `.deploy/verification/web-tool-reliability/`.

- [ ] **1. Inspect identity without printing credentials.**

```bash
systemctl show osd-platform -p WorkingDirectory -p ExecStart
pnpm web:release inspect --source /opt/open-science-desktop
git status --short
```

Expected: actual source, image/bundle identity, pending changes and baseline state are recorded. Read only selected manifest/version/digest fields, not environment files, profile tokens, auth stores or browser storage state.

- [ ] **2. Create a linked isolated worktree at execution time using `superpowers:using-git-worktrees`.** Freeze the deployed allowlisted source with the existing `inventorySource`, `fingerprintFiles`, `dependencyIdentity` and `freezeSource` helpers in `scripts/dev/web-release-source.mjs`. Reuse verified pinned dependency references from the release manifest. Verify the same absolute Git common directory as the main checkout so guarded tasks share the host lock. Copy only these approved spec/plan documents into the candidate, and commit its verified baseline. No remote or push. Do not overlay unrelated dirty main-checkout files or initialize a separate Git repository.

- [ ] **3. Read the immutable upstream source and installed runtime metadata.** Verify commit/tree/Bun version and the title patch/binary identities. Capture the call sequence from V1 `ctx.ask` and V2 `permission.assert` to their HTTP calls. Pin the exact managed branch for both. The approved decision is a shared adapter invoked after these existing checks; do not substitute a pre-execution plugin hook.

- [ ] **4. Add a failing native acceptance case in the new file, reusing the existing native acceptance harness and fixed source/dependency environment names.** Exercise a tool call with permission pending, count broker authorization/outbound calls, deny, then repeat with an actual allow decision. Assert the concrete order:

```js
assert.deepEqual(trace.slice(0, 2), ["permission:asked", "permission:pending"]);
assert.equal(authorizations.length, 0);
assert.equal(outbound.length, 0);
await permissionReply("allow-once");
await toolDone;
assert.deepEqual(trace.filter(x => /^(permission:allowed|network:authorize|network:request)$/.test(x)),
  ["permission:allowed", "network:authorize", "network:request"]);
```

`trace`, `authorizations`, `outbound`, `permissionReply`, and `toolDone` are local variables of this native harness case, using the actual runtime HTTP permission reply endpoint and counted fixture servers. They are not new production APIs. Add a pinned Bun proxy case for HTTP and CONNECT, and a credential-leak sentinel case before using the transport API.

- [ ] **5. Run the failing reproduction through the existing guard.**

```bash
pnpm platform:test ../../runtime/opencode-patches/network-native.acceptance.mjs
```

Expected: the current runtime fails the missing post-permission grant/transport assertion, not an import or missing executable error. Existing harness source/binary prerequisite validation must give an explicit prerequisite result; do not label that a reproduced feature failure. Commit only the baseline/reproduction files once the observed boundary is recorded.

## Task 2: Define the bounded outcome contract and fix collaboration errors

**Create:** `packages/sdk/src/tool-outcome.mjs`, `tool-outcome.d.mts`, `packages/shared/src/toolOutcome.ts`, `services/platform/test/tool-outcome.test.mjs`.
**Modify:** SDK/shared exports, `services/platform/src/collaboration.mjs`, `model-broker.mjs`, `runtime/sandbox/collaboration.mjs`.
**Test:** existing `collaboration-delivery.test.mjs`, `collaboration-runtime.test.mjs`, `model-broker.test.mjs`, `collaboration-opencode.test.mjs`.

- [ ] **1. Add this missing-input reproduction to the existing delivery fixture.**

```js
test("missing input keeps its safe code and captures no delivery scope", async t => {
  const f = await fixture(t);
  await assert.rejects(f.store.delivery(f.owner, {
    operation: "prepare", execution: (await f.store.get(f.owner)).execution,
    inputs: ["workspace/input.csv"], deliverables: ["result.csv"]
  }), error => error.code === "delivery_missing_input" && error.status === 400);
  assert.equal((await f.store.get(f.owner)).delivery, null);
  assert.equal(await readFile(join(f.owner.directory, "input.csv"), "utf8"), "value\n1\n2\n3\n");
});
```

Use the existing fixture unchanged and add `readFile` to its fs import. Also create a real nested `workspace/input.csv` case that succeeds; reject absolute, parent, symlink-escape and cross-account inputs through the existing file resolver. Do not auto-strip a prefix or remove an original input.

- [ ] **2. Run the new assertions red.**

```bash
pnpm platform:test test/collaboration-delivery.test.mjs test/model-broker.test.mjs test/collaboration-runtime.test.mjs
```

Expected: missing typed codes/route preservation, with existing setup passing.

- [ ] **3. Implement the closed descriptor table and constructor.** Every code from the spec gets fixed category/message/nextAction/retry, with trusted source/status supplied at the producing boundary. `tool_internal_error` is the fallback. The constructor rejects unknown codes, non-identifier correlations, secret-bearing/unknown details, invalid status and payloads exceeding 8 KiB. The canonical descriptor module implementation is:

```js
const rows = [
  ["tool_permission_denied", "permission", "Execution was not allowed.", "Review the current tool permission.", "never"],
  ["network_admission_denied", "configuration", "Network authorization could not be established.", "Check the managed network connection.", "never"],
  ["network_destination_denied", "permission", "The destination is outside the allowed scope.", "Choose an allowed public destination.", "never"],
  ["network_grant_expired", "permission", "Network authorization expired.", "Start a new authorized call if still needed.", "never"],
  ["network_grant_revoked", "permission", "Network authorization was revoked.", "Check whether the execution was stopped.", "never"],
  ["network_busy", "transient", "Network capacity is temporarily busy.", "Retry within the current call budget.", "transient_read"],
  ["network_timeout", "transient", "The network request timed out.", "Retry within the current call budget.", "transient_read"],
  ["network_upstream_refused", "upstream", "The remote service rejected the request.", "Check its known status and availability.", "never"],
  ["search_unavailable", "configuration", "The configured search service is unavailable.", "Check its configuration or use an available capability.", "never"],
  ["delivery_missing_input", "input", "An original input is missing.", "Correct its workspace-relative path.", "repair_input"],
  ["delivery_mode_mismatch", "input", "Delivery is incompatible with the current mode.", "Review the current research mode.", "never"],
  ["delivery_execution_paused", "input", "Research execution is paused.", "Resume the authorized execution if needed.", "never"],
  ["edit_ambiguous_match", "input", "The replacement matches more than one location.", "Read the file and supply unique surrounding text.", "repair_input"],
  ["edit_no_change", "input", "The replacement would make no change.", "Verify whether the requested content already exists.", "repair_input"],
  ["tool_unavailable", "input", "The selected tool is unavailable.", "Use the current available-tool list.", "never"],
  ["execution_cancelled", "cancelled", "The execution was cancelled.", "Review any partial effects before continuing.", "never"],
  ["execution_interrupted", "interrupted", "The execution was interrupted.", "Check its effect before starting another call.", "never"],
  ["tool_internal_error", "internal", "The tool could not complete.", "Use its correlation identifier to inspect the failure.", "never"]
];
export const OUTCOME_DESCRIPTORS = Object.freeze(Object.fromEntries(rows.map(
  ([code, category, message, nextAction, retry]) => [code, Object.freeze({category,message,nextAction,retry})]
)));
const sources = new Set(["gateway", "egress", "collaboration", "runtime", "upstream"]);
export function makeToolOutcome(code, {source, status, correlationId, details} = {}) {
  const descriptor = Object.hasOwn(OUTCOME_DESCRIPTORS, code) ? OUTCOME_DESCRIPTORS[code] : null;
  if (!descriptor || !sources.has(source) || typeof correlationId !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(correlationId) ||
      (status !== undefined && (!Number.isInteger(status) || status < 100 || status > 599)))
    throw new TypeError("Invalid tool outcome");
  const safe = {};
  if (details !== undefined) {
    if (!details || typeof details !== "object" || Array.isArray(details)) throw new TypeError("Invalid outcome details");
    for (const [key, value] of Object.entries(details)) {
      if (key === "path" && typeof value === "string" && value.length <= 1024 &&
          !value.startsWith("/") && !value.includes("\\") && !value.includes("\0") &&
          value.split("/").every(part => part && part !== "." && part !== "..")) safe.path = value;
      else if (key === "origin" && typeof value === "string") {
        const url = new URL(value);
        if (!["http:","https:"].includes(url.protocol) || url.origin !== value || url.username || url.password)
          throw new TypeError("Invalid outcome origin");
        safe.origin = value;
      } else if (["attempts","elapsedMs"].includes(key) && Number.isSafeInteger(value) && value >= 0) safe[key] = value;
      else if (key === "effectUnknown" && typeof value === "boolean") safe.effectUnknown = value;
      else if (key === "verifiedNoChange" && code === "edit_no_change" && typeof value === "boolean") safe.verifiedNoChange = value;
      else throw new TypeError("Invalid outcome detail field");
    }
  }
  const outcome = {version:1, code, ...descriptor, source, correlationId,
    ...(status === undefined ? {} : {status}), ...(Object.keys(safe).length ? {details:safe} : {})};
  if (new TextEncoder().encode(JSON.stringify({error:outcome})).byteLength > 8192)
    throw new TypeError("Tool outcome exceeds limit");
  return outcome;
}
export class ToolOutcomeError extends Error {
  constructor(outcome) { super(outcome.message); this.code=outcome.code; this.status=outcome.status; this.outcome=outcome; }
}
export const serializeToolError = outcome => ({error:outcome});
export function readToolError(text) {
  if (typeof text !== "string" || new TextEncoder().encode(text).byteLength > 8192) return null;
  try {
    const body=JSON.parse(text), value=body?.error;
    if (!value || value.version !== 1 || Object.keys(body).some(key=>key!=="error") ||
        Object.keys(value).some(key=>!["version","code","category","source","status","message","nextAction","retry","correlationId","details"].includes(key))) return null;
    const safe=makeToolOutcome(value.code,value);
    return ["category","message","nextAction","retry"].every(key=>safe[key]===value[key]) ? safe : null;
  } catch { return null; }
}
```

The `makeToolOutcome(code, {source, status, correlationId, details})` implementation above returns only allowlisted fields. `serializeToolError` returns `{error: outcome}`; `readToolError` validates bounded JSON and returns a recognized outcome or null. Tests exercise every spec code, prototype/unknown fields, over-size details, secret sentinels and malformed/legacy input. Do not infer a trusted source from a raw error string.

- [ ] **4. Emit a typed business rejection at the actual preflight point.** Keep `fail(message, status)` for existing callers and add a typed option carrying safe outcome data. Replace only identified delivery/mode/execution errors; no broad exception-to-message passthrough. For missing originals:

```js
const missingIndex = versions.findIndex(value => !value.exists);
if (missingIndex !== -1) {
  const error = fail("An original input is missing", 400);
  error.code = "delivery_missing_input";
  error.details = {path: inputs[missingIndex]};
  throw error;
}
```

Validate all inputs before saving `s.delivery`. Keep existing version-1 report and scope/version checks. Correlation comes from the authenticated route operation, not this raw message.

- [ ] **5. Preserve the typed envelope only on `/collaboration`, and decode it in the plugin.** Add an allowlisted collaboration error branch to ModelBroker's existing catch; keep default inference error masking unchanged. The plugin's non-success path must read the bounded envelope, throw a coded error retaining the safe outcome, and use a service/transport error only when no valid business envelope is available. Include the actual hook `callID` for delivery/checkpoint proposals as a bounded optional `callId`; extend only the collaboration route's field allowlist, validate it against the owned running tool part, and use it to record the gateway-produced outcome under that call before serialization. A guard/capability check without a real tool call gets a route correlation but cannot create a fake terminal tool record. Add end-to-end fixture responses for missing input, mode mismatch, paused execution, 503, invalid JSON and timeout. Unknown exceptions remain sanitized.

- [ ] **6. Run the affected cases green and commit.**

```bash
pnpm platform:test test/tool-outcome.test.mjs test/collaboration-delivery.test.mjs test/model-broker.test.mjs test/collaboration-runtime.test.mjs test/collaboration-opencode.test.mjs
```

Expected: the same distinct safe code reaches the plugin, inputs stay unchanged, and no inference upstream secret/error body becomes public. Commit: `fix: preserve safe research tool failure reasons`.

## Task 3: Make EgressBroker revocation granular

**Modify:** `services/platform/src/egress-broker.mjs`.
**Test:** `services/platform/test/egress-broker.test.mjs`.

- [ ] **1. Add a real broker fixture test with two grants for the same context.** Revoke one, use the second through `fetchThrough`, and assert no upstream request for the first. Add a held CONNECT case proving only the matching active grant is aborted. Reuse the existing fixture/DNS/TLS assertions; keep private and IPv6 checks.

```js
const second = broker.grant({context, destinations:["https://science.example"], expiresAt:Date.now()+10000});
assert.equal(broker.revokeGrant(context, grant.id), true);
assert.equal((await fetchThrough(broker, grant)).status, 403);
assert.equal((await fetchThrough(broker, second)).status, 200);
assert.equal(broker.revokeGrant(context, grant.id), false);
```

- [ ] **2. Run red with `pnpm platform:test test/egress-broker.test.mjs`.** Expected: no `revokeGrant` implementation, while the existing transport fixture starts normally.

- [ ] **3. Add owned per-grant revocation.** Store active leases as `{grantId, controller}` rather than just controller. Implement the method and update context revocation and admission/release consistently:

```js
revokeGrant(context, grantId) {
  const owner = identity(context);
  const grant = this.#grants.get(grantId);
  if (!grant || grant.owner !== owner) return false;
  this.#grants.delete(grantId);
  const lease = this.#active.get(owner);
  if (lease?.grantId === grantId) lease.controller.abort(failure("egress_grant_revoked"));
  return true;
}
```

In `#admit`, set one lease object; `release()` deletes it only if the map still contains that exact object. Whole-context revoke aborts its lease controller. Retain existing connection/byte/time limits; do not expand capacity to make concurrent tests pass. Foreign-owner revocation returns false and changes nothing. Add an optional `onFailure({context,grantId,code,status})` constructor callback for recognized egress failures; call it at the HTTP/CONNECT catch boundary only when the identified context and parsed grant are available. Never pass the request body, query, proxy header or arbitrary exception. The network-operation ledger correlates it by its in-memory grant index, while diagnostics contain only call correlation and safe fields. These are attempt observations, not terminal failures: a successful later retry must not retain a stale failed outcome. Observer failure cannot change transport cleanup.

- [ ] **4. Run green, including expiry, stale-release and close races, then commit.**

```bash
pnpm platform:test test/egress-broker.test.mjs
```

Expected: one revocation cannot kill a different grant, context shutdown still aborts owned active work, and DNS/TLS/credential stripping regressions pass. Commit: `fix: revoke network grants by operation`.

## Task 4: Add owned operation state and bounded safe outcome storage

**Create:** `services/platform/src/network-operations.mjs`, `tool-outcomes.mjs`; `services/platform/test/network-operations.test.mjs`, `tool-outcomes.test.mjs`.
**Reuse:** `TenantPolicy`, EgressBroker and the canonical outcome constructor.

- [ ] **1. Write the authorization tests before issuing real grants.** Use this complete injected fixture for the operation tests; its methods define the injected production contract, not a replacement production gateway.

```js
function operationFixture() {
  let clock=1000, allowed=false;
  const grants=[], revoked=[], records=[];
  const context={userId:"a",instanceId:"user-a",generation:1};
  const call={sessionId:"ses_a",callId:"call_a",execution:1,tool:"webfetch",origins:["https://science.example"]};
  const egress={
    grant(value) { grants.push(value); return {id:String(grants.length).padStart(64,"0"),expiresAt:value.expiresAt}; },
    revokeGrant(_context,id) { revoked.push(id); return true; }
  };
  const operations=new NetworkOperations({egress,
    resolveCall:async (_context,proposal)=>{
      assert.deepEqual(proposal,call); return {...call,ownerSessionId:call.sessionId,budgetMs:120000};
    },
    authorizeCall:async ()=>({allowed,expiresAt:clock+120000,kind:"automatic"}),
    outcomes:{record:async (...values)=>records.push(values)},
    now:()=>clock,randomId:()=>`op_${grants.length+1}`
  });
  return {context,call,operations,grants,revoked,records,
    allow:()=>{allowed=true;},advance:ms=>{clock+=ms;}};
}
test("denied policy issues no grant, allowed call cannot issue twice", async () => {
  const f=operationFixture();
  await assert.rejects(f.operations.authorize(f.context,f.call),{code:"tool_permission_denied"});
  assert.equal(f.grants.length,0);
  f.allow(); const first=await f.operations.authorize(f.context,f.call);
  assert.equal(first.expiresAt,121000);
  await assert.rejects(f.operations.authorize(f.context,f.call));
  assert.equal(f.grants.length,1);
  await f.operations.finish(f.context,first.operationId,null);
  assert.deepEqual(f.revoked,[first.grant]);
});
```

Add separate tests for foreign context, same-call races, expiry, a failed policy lookup, cross-origin continuation, lost adapter cleanup, generation restart, stopped execution and independent sessions. For the store, use a fresh `mkdtemp` root and verify restart reads, atomic concurrent updates, bounds, no grants, and foreign-session request denial at its authenticated API boundary.

- [ ] **2. Run red.**

```bash
pnpm platform:test test/network-operations.test.mjs test/tool-outcomes.test.mjs
```

Expected: missing operation/store implementation; fixture imports and package contract resolve.

- [ ] **3. Implement the operation lifecycle with a per-call serialized queue.** Use context tuples validated by `TenantPolicy.account`, a call key including session/execution/call, and an owned operation map. The core issuance body is:

```js
async authorize(context, proposal) {
  const call=await this.resolveCall(context,proposal);
  const key=JSON.stringify([context.userId,context.instanceId,context.generation,call.sessionId,call.execution,call.callId]);
  return this.locked(key,async ()=>{
    const decision=await this.authorizeCall(context,call);
    if (!decision.allowed) throw new ToolOutcomeError(makeToolOutcome("tool_permission_denied",
      {source:"gateway",status:403,correlationId:call.callId}));
    if (this.usedCalls.has(key)) throw new ToolOutcomeError(makeToolOutcome("network_admission_denied",
      {source:"gateway",status:403,correlationId:call.callId}));
    if (this.operations.size>=1000) throw new ToolOutcomeError(makeToolOutcome("network_busy",
      {source:"gateway",status:429,correlationId:call.callId}));
    const deadline=Math.min(this.now()+Math.min(120000,call.budgetMs),decision.expiresAt);
    if (!Number.isSafeInteger(deadline) || deadline<=this.now()) throw new ToolOutcomeError(
      makeToolOutcome("network_grant_expired",{source:"gateway",status:403,correlationId:call.callId}));
    const operationId=this.randomId();
    const issued=this.egress.grant({context,destinations:call.origins,expiresAt:deadline});
    const operation={context,call,key,operationId,deadline,grantIds:new Set([issued.id]),redirects:0,attempts:0};
    this.operations.set(operationId,operation); this.usedCalls.add(key);
    const timer=setTimeout(()=>void this.finish(context,operationId,null),deadline-this.now());
    timer.unref?.(); operation.timer=timer;
    return {operationId,grant:issued.id,expiresAt:issued.expiresAt,deadline};
  });
}
```

`locked(key, fn)` uses the same settle-safe promise-queue pattern as `CollaborationStore.locked`: await the prior promise, execute `fn`, and remove only the current queued promise in finally. Constructor stores the injected functions, initializes `operations`, `usedCalls` and queues, and supplies cryptographic `randomId` plus `Date.now` in production.

`finish` first verifies the same owned context tuple, clears the timer, revokes every operation grant, records only the terminal validated safe detail, and removes active state. Successful completion clears prior attempt-error enrichment; expiry/unknown cleanup does not claim a successful call, and final status is reconciled against actual runtime evidence. It is idempotent. Never delete a different context's operation. `cancelExecution` matches `call.sessionId` or the gateway-derived `call.ownerSessionId`, plus the same execution and context; `revokeContext` matches account/instance/generation. `continueOrigin` uses the same locked state, unchanged deadline, at most five redirects, and a fresh effective destination-policy decision; revoke the replaced grant before issuing the continuation. It cannot reuse a denied/expired/stopped operation.

Keep used-call tombstones for the active execution, capped with existing operation capacity; clean them when its execution settles. Before later issuance, `resolveCall` rejects completed runtime parts, so tombstone eviction cannot revive a completed call. If the bounded registry is full, return busy rather than discard active authorization state. No caller header or claimed mode can short-circuit `authorizeCall`.

- [ ] **4. Implement safe storage using owned platform paths, not workspace files.** The store has one version-1 JSON snapshot per account/session under platform `tool-outcomes/`, with at most 256 terminal records and 256 KiB per snapshot. Validate identifier components and all outcomes with the canonical constructor, serialize writes per session, write a mode-0600 temporary file and rename atomically. Keep the newest terminal records, preserve the current execution's stop record, and refuse an oversized current record rather than truncate it into invalid JSON. Expired old details may disappear; absence must render unknown, never a fabricated reason. Reuse existing platform quota/retention policy and avoid exporting this private bookkeeping automatically.

```js
const snapshot={version:1,records:records.slice(-256),stops:currentStops};
const bytes=JSON.stringify(snapshot)+"\n";
if (Buffer.byteLength(bytes)>256*1024) throw new Error("Tool outcome snapshot exceeds limit");
await fs.mkdir(dirname(path),{recursive:true,mode:0o700});
const temporary=`${path}.${randomUUID()}.tmp`;
try { await fs.writeFile(temporary,bytes,{flag:"wx",mode:0o600}); await fs.rename(temporary,path); }
finally { await fs.rm(temporary,{force:true}); }
```

The `path` is derived only from validated `rootDir`, authenticated `userId` and owned `sessionId`. Temporary removal is scoped to this newly created file. Do not serialize operation grant sets, runtime arguments, queries, messages or headers. `recordStop` is called only by authenticated gateway Stop handling; a runtime-reported outcome cannot create it.

- [ ] **5. Run green and commit.**

```bash
pnpm platform:test test/network-operations.test.mjs test/tool-outcomes.test.mjs test/egress-broker.test.mjs
```

Expected: zero grants before policy allow, one grant under races, cleanup after every terminal path, and safe restart-readable metadata. Commit: `feat: bind network grants to owned tool operations`.

## Task 5: Connect authenticated decisions, `/network`, and lifecycle cleanup

**Modify:** `services/platform/src/platform-server.mjs`, `sandbox-control-plane.mjs`, `model-broker.mjs`, `tenant-policy.mjs`, `main.mjs`.
**Test:** `platform-server.test.mjs`, `runtime-route-policy.test.mjs`, `tenant-policy.test.mjs`, `model-broker.test.mjs`, `network-operations.test.mjs`.

- [ ] **1. Add gateway cases to the existing authenticated platform fixture.** Authenticate as account A, recover a real pending permission request, answer allow-once, and call the internal network handler from the matching runtime context. Count `egress.grant` calls. Reject deny, guessed request IDs, forged call inputs, account B, stale generation, stopped execution, manual user headers without a real decision, and missing request recovery. Test duplicate reply and the reply-forwarding/authorize race.

The critical assertions are:

```js
assert.equal(grants.length,0);                 // pending or denied
await authenticatedPermissionReply(requestId,"once");
const authorized=await runtimeNetwork(context,{version:1,action:"authorize",...call});
assert.equal(grants.length,1);
assert.equal(authorized.operationId.startsWith("op_"),true);
await assert.rejects(runtimeNetwork(context,{version:1,action:"authorize",...call}));
```

These harness functions call the existing platform fixture's authenticated routes and the new `PlatformServer.runtimeNetwork` method defined in Step 3; they must not write directly to the approval registry to simulate a user.

- [ ] **2. Run red with guarded platform tests.**

```bash
pnpm platform:test test/platform-server.test.mjs test/runtime-route-policy.test.mjs test/tenant-policy.test.mjs test/model-broker.test.mjs test/network-operations.test.mjs
```

- [ ] **3. Add trusted decision bookkeeping at the existing permission reply boundary.** Extend `TenantPolicy.registerRequest` to retain bounded permission/tool-call association fields from the owned runtime event or pending-request response. Preserve its existing account/generation checks. Recover pending requests with the existing GET `/permission` route so a missed SSE event does not prevent valid approval. For a reply:

1. Resolve the recorded request and owned session/call; check authenticated same-origin rules already used by `#managedRuntimeProxy`.
2. Create a pending decision bound to request/action/resource/session/generation and the actual user reply.
3. Forward the reply using the existing private runtime request.
4. Confirm the decision only after a successful runtime response. An adapter arriving meanwhile awaits that decision's bounded settlement instead of failing spuriously or receiving a grant early. Failure/timeout rejects it and gives an actionable non-approved result.
5. Consume once decisions at issuance; always decisions remain confined to their existing tool/resource/session scope. A pause/restart revokes outstanding decisions. Never treat `x-scikeel-manual-approval` by itself as proof.

Automatic authorization evaluates the gateway-owned current mode and effective tool rules, including parent/root ownership and explicit overrides, with the same precedence as the pinned runtime. Copy the small documented rule evaluation into a named `effectiveNetworkPermission` helper in `network-operations.mjs` and test each supported mode and override; do not infer allow from research text or just a returned `ctx.ask`.

- [ ] **4. Implement `PlatformServer.runtimeNetwork(context, body)` as a bounded internal dispatcher.** Reuse `runtimeCollaboration`'s worker/generation, descendant-registration and root-owner checks. Look up the actual running tool part, tool name and canonical argument destinations; reject a proposal that disagrees. Derive the search origin from configured backend policy, not supplied query URLs. Validate fixed fields and version before delegation:

```js
const actions=new Set(["authorize","complete","cancel"]);
const fields=new Set(["version","action","sessionId","callId","execution","tool","origins",
  "permissionRequestId","operationId","outcome"]);
if (body?.version!==1 || !actions.has(body.action) || Object.keys(body).some(key=>!fields.has(key)))
  throw new ToolOutcomeError(makeToolOutcome("network_admission_denied",
    {source:"gateway",status:400,correlationId:"network_request"}));
```

Authorization rejects arbitrary identity, proxy, URL callback, headers and credentials. A continuation uses the existing operation identifier with one new canonical origin and reuses the original call/budget. Runtime completion only accepts known upstream/runtime outcomes associated with that operation; it cannot assert a user Stop or gateway permission error. Cleanup actions are idempotent and return no grant bytes. Store initialization is in the platform's existing dependency wiring, with injected callbacks assigned after PlatformServer construction as with collaboration; avoid a circular module import.

- [ ] **5. Route `/network` through the existing scoped runtime bridge.** ModelBroker recognizes this internal route separately from inference, authenticates context as already implemented, and invokes `networkHandler(context, body)` with a maximum 16 KiB body. Emit the safe 8 KiB error envelope on this route, never apply model request/token validation to network operations, and keep inference routes unchanged. `sandbox-control-plane.mjs` constructs the operation object with the actual `egress`, binds the server handler and adds operation revocation to existing worker cleanup. The restricted model/bridge token authenticates this internal control request; it is never itself the egress token.

- [ ] **6. Hook pause, Stop, execution settlement, account shutdown and worker-generation replacement.** Revoke only incompatible owned operations/decisions. Refresh transport reconnect is not a Stop; preserve the existing execution lease behavior. Trace root and child cancellation with explicit owned calls rather than account-wide egress revoke. On platform restart no capability is recovered from disk; existing broker maps are empty and fresh operations require fresh authorization.

- [ ] **7. Run the Step 2 suite green and commit.** Expected: a Web decision produces a scoped grant through the actual platform wiring, and no pre-approved, replayed or forged proposal does. Commit: `feat: connect Web tool permissions to scoped egress`.

## Task 6: Extend guarded runtime preparation and immutable image verification

**Modify:** `scripts/dev/build-opencode-title-runtime.mjs`, `safe-desktop-task.mjs`, `prepare-science-image.mjs`, `stage-sandbox-image.mjs`, `web-release.mjs`, `web-release-policy.mjs`, `package.json`, `.github/workflows/sandbox-image.yml`.
**Create:** `scripts/dev/build-opencode-network-runtime.mjs` as a fixed wrapper around the existing runtime preparer; `scripts/dev/build-opencode-network-runtime.test.mjs`.
**Test:** existing image/release tests plus the new build identity test.

This task's guard/recipe support precedes runtime execution checks in Tasks 7–8. It may be prepared while network policy files are still being authored; no image can be built, attested or advertised until the actual locked patch and its tests exist.

- [ ] **1. Add fixture artifact tests before changing builders.** Reuse existing manifest fixtures and test that a title-only binary is rejected when network capability is required, a changed network/helper digest cannot retain the old image identity, unknown image files are rejected, the canonical outcome module is a required measured input, and title metadata still validates. Use real SHA-256 digests of fixture buffers, not placeholder release identities.

```js
const artifact={...titleArtifact,network:{schema:1,capability:"scoped-network-v1",
  patchSha256:networkLock.patchSha256,combinedDiffSha256:networkLock.combinedDiffSha256}};
assert.equal(validateNetworkRuntimeArtifact(artifact,titleLock,networkLock,binarySha256),artifact);
assert.throws(()=>validateNetworkRuntimeArtifact(titleArtifact,titleLock,networkLock,binarySha256));
assert.throws(()=>validateNetworkRuntimeArtifact({...artifact,network:{...artifact.network,
  patchSha256:createHash("sha256").update("changed").digest("hex")}},titleLock,networkLock,binarySha256));
```

`titleArtifact`, `titleLock`, `networkLock` and `binarySha256` are the existing fixture object plus the new network-lock fixture generated from the test patch/diff bytes. `validateNetworkRuntimeArtifact` is exported by the fixed wrapper in Step 3.

- [ ] **2. Run red through the guard.**

```bash
pnpm release:test scripts/dev/build-opencode-network-runtime.test.mjs scripts/dev/web-release.test.mjs
pnpm platform:test test/science-image.test.mjs test/sandbox-runner.test.mjs
```

Both `test/science-image.test.mjs` and `test/sandbox-runner.test.mjs` exist in the inspected deployed baseline. Re-inspection detects later drift; never silently run an empty test selection.

- [ ] **3. Preserve the title lock and add immutable ordered network inputs.** The new `network.lock.json` contains schema 1, the same upstream commit/tree/Bun version, `patchSha256` for `network.patch`, `helperSha256` for the canonical helper, `combinedDiffSha256` for the final normalized Git diff after applying title then network, and capability `scoped-network-v1`. `validateNetworkRuntimeArtifact` first calls the existing title artifact validator, then compares each network field and the binary SHA. Keep its schema-1 title metadata and add the `network` object; do not weaken old validation.

Extend the existing prep function with an explicit fixed network mode and a fresh staging source under `.superpowers/sdd/web-tool-reliability/source-git`. Validate untouched upstream commit/tree, then apply the title patch and the network patch in order. Store the combined stamp; retries verify reverse-applicability of both patches and the exact combined diff against HEAD. Unexpected staged source, changed dependency lock, changed patch bytes or version mismatch fail before build. No reuse of an unlocked prior source tree.

The wrapper accepts only `prepare`, `test`, `check`, `acceptance`, or `build` with no arbitrary command/args. `test` runs exactly `packages/opencode/test/tool/scikeel-network.test.ts`, `packages/core/test/tool/scikeel-network.test.ts`, and the existing title regression files in the locked upstream source; `check` uses a bounded targeted host project and the full upstream checker in dedicated CI. `acceptance` runs the fixed native harness. `build` retains the dedicated-CI-only restriction and outputs `.deploy/network-runtime/opencode` plus its measured runtime manifest. All upstream commands run within the guard; dependency install/build stays in dedicated CI with the pinned lock/toolchain.

- [ ] **4. Register the fixed guarded modes and package scripts.**

```json
{
  "runtime:network:prepare":"node scripts/dev/safe-desktop-task.mjs opencode-network-prepare",
  "runtime:network:test":"node scripts/dev/safe-desktop-task.mjs opencode-network-test",
  "runtime:network:check":"node scripts/dev/safe-desktop-task.mjs opencode-network-check",
  "runtime:network:acceptance":"node scripts/dev/safe-desktop-task.mjs opencode-network-acceptance",
  "runtime:network:build":"node scripts/dev/safe-desktop-task.mjs opencode-network-build"
}
```

Add those exact modes to the guard allowlist and dispatch to the fixed wrapper, preserving `verifyLimits`, common Git task locks, memory/swap limits and serialization. Never spawn a heavyweight subprocess from an unguarded plan helper. Tests assert raw mode names/unsupported extra args are rejected and resource limits remain enforced.

- [ ] **5. Update the image and release identity checks atomically.** Add the exact canonical outcome-module source to `imageInputPath`; copy it as `tools/tool-outcome.mjs`, and add only that exact resource to build-context and runnerFiles allowlists. Keep title artifact metadata plus the required network object in the image manifest. The CI workflow builds/tests the combined runtime, copies the measured network binary/manifest into the existing scientific context, runs the production runner probe, and attests the full rootfs and manifest. Release verification compares installed runtime/resource bytes and combined metadata with the candidate inputs. A title-only image cannot claim managed network capability.

Do not expand image allowlists to arbitrary `.mjs` files or omit measured source inputs. Deployment needs a new installed CI-attested image whenever runner, plugin, helper or runtime patch inputs change. No hand-patching the installed rootfs, changing resource reserve, or faking an attestation.

- [ ] **6. Run the guarded build-identity cases green and commit.** Use Step 2's commands with the recorded real test file. Full upstream checks/build follow the locked helper's CI modes after the runtime patch task. Commit: `build: attest managed network runtime and image inputs`.

## Task 7: Patch the pinned runtime with operation-specific transport

**Create:** `runtime/opencode-patches/network-transport.ts`, `network.patch`, `network.lock.json`.
**Modify:** upstream paths captured in the patch: `packages/core/src/scikeel/network.ts`, `tool-outcome.mjs`, `tool-outcome.d.mts`, `toolOutcome.ts`, V1/V2 `tool/webfetch.ts` and `tool/websearch.ts`; managed runner activation in `runtime/sandbox/runner.mjs`, `cli-jobs.mjs`.
**Test:** `runtime/opencode-patches/network-native.acceptance.mjs`; new pinned upstream `packages/opencode/test/tool/scikeel-network.test.ts` and `packages/core/test/tool/scikeel-network.test.ts` in the same patch.

- [ ] **1. Extend the failing native test with two simultaneous owned calls, a denied call and credential sentinels.** Assert separate explicit proxy credentials, no mutation of `process.env`, no direct network request, and no credential in model output/errors. Include HTTP and HTTPS CONNECT against counted fixture endpoints. Run through `pnpm platform:test ../../runtime/opencode-patches/network-native.acceptance.mjs`; it stays red until the combined runtime exists.

- [ ] **2. Implement the managed shared helper.** `managedNetworkRequest({sessionId,callId,execution,tool,request,signal})` validates managed activation, reads only the runner-provided restricted bridge token, and uses the fixed internal `/network` URL. Derive execution from a gateway-owned guard response; do not trust caller-created execution claims. Call authorization after the tool's existing permission check, then use the returned capability only in this fetch's proxy option:

```ts
const response=await fetch(request.url,{
  method:request.method,
  headers:request.headers,
  ...(request.body===undefined ? {} : {body:request.body}),
  redirect:"manual",
  signal,
  proxy:`http://scikeel:${authorized.grant}@172.31.240.1:4794`
});
```

`request` is constructed by the pinned fetch/search tool, not arbitrary bridge arguments. Its method/header/body allowlist remains local to those tools. Authorization traffic itself goes only to the fixed private bridge using the existing internal exception; never send its token to an origin. The helper checks the same overall deadline while reading a stream with a byte-counting reader, always cancels the reader on error, returns `{url,status,headers,body}` with body as `Uint8Array`, and calls owned `complete`/`cancel` cleanup in finally using a separate short cleanup signal. Expiry is the backstop if cleanup fails. Do not log the transient proxy string or return it as result metadata.

The runtime helper may read `SCIKEEL_MANAGED_NETWORK=1` and `SCIKEEL_NETWORK_TOKEN`, populated by the trusted runner from the existing scoped profile capability. Token validation requires 64 hexadecimal characters and the bridge URL is a code constant. No shared upstream/search credential enters these variables. In managed mode, a missing/invalid token fails explicitly; it never falls back to direct transport. In unmanaged mode, the old paths are unchanged. Validate these flags actually reach the OpenCode child; do not assume osd forwards them.

- [ ] **3. Insert the V1 fetch branch immediately after `yield* ctx.ask(...)`.** Import the shared helper through the existing core wildcard export. The patch copies the canonical outcome ESM bytes and pure shared type into `packages/core/src/scikeel/`; its local declaration changes only the shared type import to `./toolOutcome`. Verify that parser/helper/type bytes match the locked source references, so runtime validation does not become a second parser implementation. Project `{sessionID,callID,abort}` into the helper and keep the existing conversion, image attachment handling, body-size cap, titles and returned output shape. The managed branch returns a buffered bounded response, avoiding a dangling proxy connection after success. The unmanaged branch retains its current HttpClient behavior. A failed permission does not enter the branch.

- [ ] **4. Insert the V1 search branch after `ctx.ask`, inside the existing provider call construction.** Preserve Exa/Parallel payload/schema/SSE parsing and real references. Send only the server-validated selected backend origin. Do not put credential-bearing URL/query parameters in diagnostics. A configured shared credential needing a trusted upstream adapter cannot be passed to the tenant helper; expose unavailable until that authorized configuration is supported, and test the unconfigured backend state.

- [ ] **5. Apply the same shared helper after V2 `permission.assert`.** Use the V2 context's `assistantMessageID`/`toolCallID` projection and Effect's supplied cancellation signal rather than assuming V1 `ctx.abort` exists. Preserve the respective input/output schemas and typed ToolFailure behavior. Make safe messages available to the assistant without parsing them as authorization. Do not change the generic tool framework or all runtime error schemas to add this branch.

- [ ] **6. Activate the adapter only in managed runner startup.** Retain the unauthenticated default proxy for unrelated/unapproved commands so they remain blocked. Pass per-tool capabilities in explicit fetch options rather than altering that process-wide proxy. Tests prove stock desktop/unmanaged runtime still uses its existing configuration. Add capability-handshake metadata indicating this installed runtime supports the adapter, allowing the platform to refuse an advertised managed networking path with a mismatched image.

- [ ] **7. Generate the network patch relative to the title-patched index and pin its SHA-256, affected paths and upstream/Bun identity. Apply title to the immutable source, stage only its changed files as the baseline index, add networking source/tests with intent-to-add, then capture `git diff --binary` as the incremental network patch and `git diff HEAD --binary` as the combined source identity. Applying title then network to a fresh pinned source must reproduce both hashes; never generate network.patch as a second copy of the full title diff.** Do not hand-copy the candidate binary to production. Task 6 teaches the existing preparation/build guard to apply both title and network patches and validate their final combined diff. Commit source patch/helper/activation only: `feat: adapt managed OpenCode network tools after approval`.

## Task 8: Implement bounded retries and redirect authorization

**Modify:** `runtime/opencode-patches/network-transport.ts`, its patch and lock.
**Test:** the pinned upstream network tests and `services/platform/test/network-operations.test.mjs`.

- [ ] **1. Add counted attempt/deadline cases before changing the adapter.** Use fake clocks and an injected transport that returns 503 twice then 200, 403, a stalled body, a cross-origin 302, and a cancelled delay. Counts include every attempted transport, body cancellation and grant continuation. A fixed search POST is eligible only when the known search adapter declares it read-only; arbitrary POST is not.

```js
assert.equal(await retryRead({run,wait,now,deadline:120000,signal,eligible:true}),result);
assert.equal(attempts,3);
assert.deepEqual(delays,[1000,2000]);
assert.equal(now()<=120000,true);
```

`run` is the counted transport closure, `wait` advances the fake clock, `now` reads it, and `signal` is a test AbortController signal. The complete production retry policy below defines `retryRead`; tests must also assert one attempt for 401/403, unsupported mutations and revoked grants.

- [ ] **2. Implement a single retry owner with an abortable delay.** Export these pure helpers from the canonical transport source for the patched upstream tests:

```ts
export function abortableDelay(ms:number,signal:AbortSignal):Promise<void> {
  return new Promise((resolve,reject)=>{
    if(signal.aborted){reject(signal.reason);return;}
    const abort=()=>{clearTimeout(timer);signal.removeEventListener("abort",abort);reject(signal.reason);};
    const timer=setTimeout(()=>{signal.removeEventListener("abort",abort);resolve();},ms);
    signal.addEventListener("abort",abort,{once:true});
  });
}
export async function retryRead<T>({run,wait,now,deadline,signal,eligible}:{
  run:(attempt:number,remainingMs:number)=>Promise<T>;
  wait:(ms:number,signal:AbortSignal)=>Promise<void>;
  now:()=>number;deadline:number;signal:AbortSignal;eligible:boolean;
}):Promise<T> {
  for(let attempt=0;attempt<3;attempt++){
    signal.throwIfAborted();
    const remaining=deadline-now();
    if(remaining<=0)throw Object.assign(new Error("Network deadline exceeded"),{code:"network_timeout"});
    try{return await run(attempt+1,remaining);}
    catch(error){
      signal.throwIfAborted();
      const failure=error as {status?:number;retryAfterMs?:number;transportTransient?:boolean;revoked?:boolean};
      const transient=[429,502,503,504].includes(failure.status??0)||failure.transportTransient===true;
      if(!eligible || failure.revoked || !transient || attempt===2)throw error;
      const requested=failure.retryAfterMs??(attempt+1)*1000;
      const delay=Math.max(0,Math.min(requested,10000));
      if(delay>=deadline-now())throw error;
      await wait(delay,signal);
    }
  }
  throw new Error("Network attempts exhausted");
}
```

Validate Retry-After as seconds or an HTTP date in a separate pure decoder; NaN/malformed/negative values use the default delay. A date in the past yields zero. Use the gateway deadline, or the validated shorter tool deadline when applicable; do not reset it when entering this helper. Set `transportTransient` only for the pinned transport's verified temporary connection errors, not arbitrary model text or any caught exception. Check the body inside each attempt's deadline; timeout cancellation covers reader and transport. Final serialization uses the canonical safe descriptor, not the raw error. Attempts for this logical call cannot reset on duplicate authorize or cleanup retransmission.

- [ ] **3. Follow redirects explicitly inside `run`, with at most five redirects total across attempts.** Cancel the previous body before another request. Resolve Location relative to the actual URL, reject credentials/hash/unsupported ports/protocols, retain address checks, and call gateway authorization continuation for a changed origin. A denied continuation makes no request to its target. Do not reset byte/time/redirect counters across retry. Search JSON-RPC is a fixed read-only POST; do not replay its body to a different origin or convert an arbitrary POST into GET. Fetch GET keeps GET. Redirects requiring a new manual decision remain inside the already-started operation deadline and existing execution lease.

- [ ] **4. Classify failure provenance from observed transport and broker evidence.** A successfully established HTTPS request returning 403 is an upstream refusal; failed proxy admission is a platform network error. Add a bounded EgressBroker failure observer keyed by owned grant to the operation ledger so the adapter's completion can preserve egress codes even when CONNECT hides a response body. Unknown/missing transport details remain unknown. Never assume a 403 is Cloudflare and silently trigger the stock fallback in managed mode. Preserve the old fallback only for unmanaged behavior.

- [ ] **5. Run the fixed network tests and operation tests green using guarded tasks, then commit.**

```bash
pnpm platform:test test/network-operations.test.mjs test/egress-broker.test.mjs
pnpm runtime:network:test
```

`runtime:network:test` is the guarded fixed task added in Task 6 and prepared before this runtime task. Expected: at most three attempts, no retry for denial/mutation, no extra origin request before authorization, and all cancellation signals terminate waits. Commit: `fix: bound managed network retries and redirects`.

## Task 9: Enrich live/history outcomes and reconcile Stop

**Modify:** `services/platform/src/platform-server.mjs`, `tool-outcomes.mjs`; `packages/sdk/src/OpenCodeClient.ts`, `types.ts`; `packages/shared/src/toolOutcome.ts`, `index.ts`; `apps/desktop/src/lib/runtime.ts`.
**Test:** `platform-server.test.mjs`, `tool-outcomes.test.mjs`; `apps/desktop/src/test/opencode-client.sessions.test.ts`, `opencode-client.node.test.ts`, `apps/desktop/src/lib/runtime.test.ts`, `runtime.store.test.ts`.

- [ ] **1. Add shared live/reopen status assertions before changing normalization.** For each case, send a live tool part and reload it through the existing message-history path. Both must produce the same status/reason: completed `invalid` is failed; error with raw `Tool execution aborted` and no Stop is warning/interrupted; matching Stop plus an affected abort is warning/cancelled; late completed success after Stop stays success; unsupported metadata stays unknown.

```ts
expect(live.blocks.find(b=>b.kind==="tool-call")?.status).toBe("failed");
expect(reopened.blocks.find(b=>b.kind==="tool-call")?.status).toBe("failed");
expect(cancelled.outcome?.code).toBe("execution_cancelled");
expect(unknownAbort.outcome?.code).toBe("execution_interrupted");
expect(lateSuccess.status).toBe("success");
```

These are local outputs of the existing SDK/store fixtures; compare their safe optional outcome field as well as status. Add a spoofed JSON outcome embedded in model text: it must not create a trusted cancellation reason.

- [ ] **2. Add optional `outcome?: ToolOutcome` to ToolCallBlock, SDK tool events and parsed history parts.** Keep `ToolCallStatus` unchanged and export the shared type. Centralize normalization in the SDK so events and reopened messages cannot diverge. Always preserve `state.error` as a capped readable fallback; it is currently absent from the live tool update's output mapping. In runtime folding carry the optional field forward just like existing start/end/child-session fields:

```ts
const outcome=event.outcome??prevTool?.outcome;
const output=event.output??prevTool?.output;
```

A nonterminal update cannot erase known terminal reason/detail. Do not interpret raw tool JSON as an authoritative outcome. Recognize `invalid` semantically by its built-in tool name even when runtime status is completed. Narrow legacy mappings for the pinned edit errors may explain input repair, but cannot authorize actions or invent Stop.

- [ ] **3. Record explicit Stop before forwarding the existing owned session abort request.** Register call IDs actually pending/running in the target execution and owned descendants, plus execution/user/generation/time. Revoke their network operations and decisions. Reconcile subsequent runtime parts: an affected abort with this matched Stop can be cancelled; completed calls stay successful; unrelated sessions and old executions are unaffected. If forwarding fails, retain its truthful requested-versus-observed distinction. A reconnect, lost SSE, missing heartbeat or process exit is not an explicit user Stop.

- [ ] **4. Overlay safe metadata in the managed gateway's existing event and message responses.** Fetch outcomes only through owned authenticated context. Strip any runtime-supplied `_scikeelToolOutcome` field before adding the gateway's validated journal result. Use the same bounded helper for live tool events and message lists, and retain all original runtime fields. Persist only safe outcomes and Stop bookkeeping. Do not introduce a new frontend endpoint, rewrite runtime parts, or amend exported scientific report/provenance schemas.

Runtime completion reports are limited to recognized `runtime`/`upstream` observations for an issued operation. Platform permission, egress and collaboration outcomes come from their actual producing handlers; cancellation comes only from Stop reconciliation. If a wrapper reports a nonexistent tool as completed, normalization still marks it failed. Empty/malformed legacy errors preserve unknown cause rather than falsely assigning success.

- [ ] **5. Keep no-op edits truthful.** An identical replacement remains failed/no-change unless the existing workspace-safe read verifies the requested text is already present. Add `details.verifiedNoChange` as an allowlisted boolean valid only for `edit_no_change`, set by that verified check. Only then use warning with an explicit unchanged label; never say edited. Do not make the verification read or corrected edit after Stop. One targeted input repair is a new visible tool call within the existing scope, not an automatic replay.

- [ ] **6. Run green and commit.**

```bash
pnpm platform:test test/platform-server.test.mjs test/tool-outcomes.test.mjs
pnpm --filter @ai4s/desktop test src/test/opencode-client.sessions.test.ts src/test/opencode-client.node.test.ts src/lib/runtime.test.ts src/lib/runtime.store.test.ts
```

Expected: same live/reopened reason, original evidence preserved, and no mutated file replay. Commit: `fix: preserve truthful tool outcomes across refresh`.

## Task 10: Present a localized reason and next action in existing tool rows

**Modify:** `apps/desktop/src/components/thread/ToolCallRow.tsx`; existing English and all supported locale `session.json` catalogs.
**Test:** `ToolCallRow.test.tsx`, `ToolGroup.i18n.test.tsx`, `apps/desktop/src/i18n/parity.test.ts`; registered browser scenario from Task 11.

- [ ] **1. Add component cases for safe reason/action, legacy error, cancellation, interruption and keyboard-operable details.** Use `render`/`screen` and the existing tool block fixture. A raw error fallback remains visible for unknown older records, but credential-scrubbed display does not turn it into a classified trusted outcome. Test long relative paths and narrow container sizing in the browser.

```tsx
render(<ToolCallRow block={{kind:"tool-call",title:"Fetch source",tool:"webfetch",
  status:"failed",outcome:outcomeFixture("network_admission_denied")}}/>);
expect(screen.getByText(/network authorization/i)).toBeVisible();
expect(screen.getByText(/check the managed network connection/i)).toBeVisible();
```

`outcomeFixture` in this test calls the canonical descriptor constructor with a safe fixed correlation ID; English test messages match the actual locale strings. Add an accessibility assertion that the details summary is focusable and its content opens by keyboard.

- [ ] **2. Run the component cases red through the guarded desktop test script.**

```bash
pnpm --filter @ai4s/desktop test src/components/thread/ToolCallRow.test.tsx src/components/thread/ToolGroup.i18n.test.tsx src/i18n/parity.test.ts
```

- [ ] **3. Render localized closed-code strings and disclosure details.** Add `tool.outcome.<code>.reason` and `.action` plus explicit cancelled/interrupted/unchanged labels. Use trusted code lookup for localization, keeping safe descriptor prose for model-facing English. Add translations to every existing supported locale, without creating a new language/configuration surface. Reuse the current row and its preformatted detail area; no modal or retry button that blindly repeats denied/mutating calls.

```tsx
{block.outcome && (
  <div className="ml-2 min-w-0 break-words rounded-input bg-surface-2 px-3 py-2 text-sm">
    <p>{t(`tool.outcome.${block.outcome.code}.reason`)}</p>
    <p className="mt-1 text-muted">{t(`tool.outcome.${block.outcome.code}.action`)}</p>
    <details className="mt-2 min-w-0">
      <summary>{t("tool.outcome.details")}</summary>
      <pre className="whitespace-pre-wrap break-all text-xs">{block.outcome.correlationId}</pre>
    </details>
  </div>
)}
```

Details may also show safe HTTP status, approved origin, relative path and attempt count. Do not show tokens, internal URLs/paths, prompts or queries. Explicit warning labels come from the outcome rather than changing the shared status enum. Confirm no success-icon claim is shown for `invalid`.

- [ ] **4. Run green and commit.** `pnpm --filter @ai4s/desktop test src/components/thread/ToolCallRow.test.tsx src/components/thread/ToolGroup.i18n.test.tsx src/i18n/parity.test.ts`. Expected: locale parity, safe actionable output and accessible disclosure pass. The real 360-pixel overflow check belongs to Task 11. Commit: `feat: explain tool failures and interruptions in Web`.

## Task 11: Register browser/runtime acceptance and run the affected checks

**Create:** `apps/desktop/src/test/webToolReliability.acceptance.test.mjs`.
**Modify:** `scripts/dev/web-release-policy.mjs`, `web-release.mjs`, `safe-desktop-task.mjs`, `package.json`; existing release/browser test helpers only where necessary.
**Test:** `scripts/dev/web-release.test.mjs`, actual native network harness, affected frontend/platform suites.

- [ ] **1. Add a required `tools` browser group for this feature's affected source paths.** Follow existing session/attachments registration. The release selector includes `tools` for network adapter/runner, operation/error handlers, SDK outcome normalization, and tool row changes. When selected, the browser scenario file is mandatory and skipped/prerequisite-only results fail verification. Point the browser at the exact staged candidate bundle with the existing authenticated test helper, never a development Vite server.

```js
if(groups.includes("tools")) {
  tests.push("src/test/webToolReliability.acceptance.test.mjs");
  environment.OSD_TOOLS_ACCEPTANCE="1";
  environment.OSD_TOOLS_WEB_ROOT=candidate.artifacts.web.directory;
}
```

Keep the current release check for pending/skipped tests. Add a fixed `web-tool-live` mode plus `web:tools:acceptance` package script using the existing guarded browser path and private settings convention, with no credentials in CLI arguments or reports. No user data or original conversations are deleted for cleanup.

- [ ] **2. Write deterministic browser scenarios for the approved acceptance table.** Reuse the existing auth/browser fixture, and use controlled broker/runtime fixtures for counted failure injection. Include:

| Scenario | Exact result to assert |
| --- | --- |
| Manual public fetch | No grant/outbound request while waiting; one valid granted operation after allow; actual source content returned |
| Denied fetch | No outbound request or automatic retry; permission reason shown |
| Already-authorized mode | Existing policy allows without an extra dialog; origin/generation still checked |
| Search | Real configured backend references, or intentionally disabled/unconfigured state; advertised failure does not pass |
| Platform admission versus remote 403 | Different producing source/reason; neither triggers blind repeated requests |
| Transient read | At most three attempts, same deadline and safe attempt count |
| Cross-origin redirect | New destination waits for policy decision; refused target receives no request |
| Delivery input | Missing relative path survives all layers; no scope capture or input mutation |
| Bad model/tool input | Unknown tool is failed; ambiguous edit can repair once; no-op does not claim edited |
| Stop/reload | Explicit affected abort is cancelled; missing Stop is interrupted; late success remains success |
| Mutation interruption | No automatic command/write/edit replay before or after reload |
| Concurrent sessions | Credentials/operations stay separate; one Stop does not cancel the other; busy response is truthful |
| Phone width | At 360 px, reason/action wrap, disclosure works, no horizontal overflow |
| Privacy | Sentinel credentials absent from browser console/events, public outcomes, provenance/export and retained test artifacts |

A phone assertion in the actual browser is:

```js
await page.setViewportSize({width:360,height:780});
await page.getByText(expectedReason,{exact:true}).waitFor();
assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
const summary=page.locator("summary").filter({hasText:detailsLabel});
await summary.press("Enter");
assert.equal(await summary.locator("..").getAttribute("open")!==null,true);
```

The native HTML `summary` locator above avoids assuming a browser-specific button role; it verifies keyboard activation and expanded content. `expectedReason` and `detailsLabel` come from the actual active locale fixture, not raw server prose. Capture only safe statuses/timings/correlation IDs and redact screenshots containing private user content.

- [ ] **3. Run focused deterministic checks, then the affected full guarded suites exactly once.**

```bash
pnpm platform:test
pnpm --filter @ai4s/desktop test
pnpm --filter @ai4s/desktop typecheck
pnpm --filter @ai4s/desktop lint
pnpm release:test scripts/dev/web-release.test.mjs scripts/dev/build-opencode-network-runtime.test.mjs
```

The release preparation owns the bounded Web build and staged browser pass; avoid a second unregistered/manual bundle build. Run the native harness with the measured source/binary via `pnpm runtime:network:acceptance` and the actual installed image's probe in its existing guarded workflow. Record effective image/tool versions, not just source success. No Claude call or alternate Claude endpoint is permitted.

- [ ] **4. Perform real Web acceptance with an available non-Claude model and a permitted public origin.** Use the authenticated verification browser against the candidate stack and then published entry when authorized. A real OpenCode tool invocation must succeed; model prose claiming success is not evidence. Use a known current enabled model from the live catalog; do not change the administrator allowlist to get a pass. Prove allowed fetch, actual denial, delivery error, Stop plus reload, and both viewport widths. Keep the original files/history untouched and retain the verification conversation and sanitized evidence.

A temporarily unavailable model/search provider leaves its corresponding live gate incomplete. Do not turn outage into a feature pass, probe Claude, or silently choose another search service. If a capability is intentionally unavailable, prove the advertised state is accurate and scope the final result accordingly; an advertised broken capability remains a defect.

- [ ] **5. Commit only accepted scenario/registration changes.** Expected: deterministic cases pass and the release workflow cannot omit/skip this required group. Commit: `test: verify Web tool reliability through the installed runtime`.

## Task 12: Prepare a reviewable release and publish only within authorized scope

**Use:** existing `scripts/dev/web-release*.mjs` and attested image installer; no new deployment mechanism.
**Modify:** only `PROGRESS.md` for real milestones and the existing release manifest/evidence through workflow tools.

- [ ] **1. Confirm all previous tasks, current source drift and publication authorization.** Spec/plan approval alone is not publication authorization. If implementation is later authorized without publication, finish the tested candidate and review evidence; stop before deployment. If the user authorizes implementation and publication together, continue without another redundant permission request.

- [ ] **2. Obtain the exact CI-attested artifact for the candidate source and verify it before installation.** Use a fixed ignored artifact directory, `.deploy/verification/web-tool-reliability/science-artifacts`, and the measured manifest emitted by CI. Download/CI dispatch follows the then-authorized release scope. Do not create a remote or push local session/workspace repositories. From the isolated candidate checkout:

```bash
pnpm sandbox:image:stage --manifest .deploy/verification/web-tool-reliability/science-artifacts/image-manifest.json --dry-run
pnpm sandbox:image:stage --manifest .deploy/verification/web-tool-reliability/science-artifacts/image-manifest.json --install
```

Expected: exact signed workflow/source identity, binary/resource digests, unchanged scientific dependency lock and newly installed immutable image. Installation preserves tenant data; selecting it for running workers belongs to the coherent Web release. Never install an unsigned substitute or change limits to work around a failed build.

- [ ] **3. Prepare, verify and publish using captured identifiers, not guessed release IDs.**

```bash
pnpm web:release inspect --source /opt/open-science-desktop/.worktrees/web-tool-reliability-2026-10-06
```

Read `imageDigest` from the already validated artifact manifest. Invoke the existing release command using an argv array from an authorized automation wrapper, so no shell interpolation exposes secrets:

```js
const image=JSON.parse(await readFile(".deploy/verification/web-tool-reliability/science-artifacts/image-manifest.json","utf8"));
if(!/^sha256:[a-f0-9]{64}$/.test(image.imageDigest))throw new Error("Invalid installed image digest");
execFileSync("pnpm",["web:release","prepare","--source",process.cwd(),"--image-digest",image.imageDigest,"--maintenance"],
  {stdio:"inherit"});
```

After the `prepare` command returns successfully, read the recorded candidate manifest under the common Web release store to obtain its validated ID. Capture it as `releaseId`, verify `/^[A-Za-z0-9_-]{1,100}$/`, and invoke `execFileSync("pnpm",["web:release","deploy","--release",releaseId],{stdio:"inherit"})` only within publication authorization. Use that same recorded identifier for `resume` or `rollback`; the exact identifier is runtime output and cannot be prewritten as a constant in this plan. Validate it against the workflow's identifier grammar before use. The workflow owns bounded build, selected tests, staged browser scenarios, frozen source and recovery metadata. Preserve its registered stages rather than running a detached copy of the candidate bundle.

- [ ] **4. Prove installed identities and online behavior.** Verify platform source, runtime combined-patch manifest, scientific image, plugin/helper hashes, served Web assets and required browser/live-tool results agree with the prepared candidate. Check that original input versions, workspace files and conversations are unchanged except for explicitly owned verification outputs. Retain sanitized evidence and write a timestamped conclusion to `PROGRESS.md`, newest first.

- [ ] **5. Exercise the existing rollback path on publication failure.** Restore the recorded platform source, image selection and served bundle coherently; recover project services without deleting tenant files/history/credentials. A failed guarded build leaves the current deployed bundle untouched. Record failed checks and remaining blocker honestly, and resume only through the stored release metadata once corrected.

## Dependency order and self-review checklist

Execute Tasks 1–12 in numeric order. Task 6 establishes the guard and immutable recipe before Tasks 7–8 execute upstream runtime checks. Do not start publication or change a production image until its complete candidate source and acceptance evidence are ready.

| Approved spec requirement | Plan coverage |
| --- | --- |
| Verified evidence; no historical inference treated as fact | Task 1 and planning evidence |
| Post-permission destination-scoped authorization | Tasks 4–7 |
| Manual/automatic policy, replay and account/child ownership | Tasks 4–5 |
| No permanent process-wide capability or direct fallback | Task 7 |
| TLS, CONNECT, private/DNS/redirect boundaries and lifecycle | Tasks 1, 3, 7–8 |
| Safe 8 KiB contract and two-layer collaboration errors | Task 2 |
| Missing input, original versions, no prefix stripping/report migration | Task 2 |
| Limited read-only retry and explicit input repair | Tasks 8–9 |
| Semantic invalid status, Stop/interruption and reopened history | Task 9 |
| Localized reason/action and phone/accessibility behavior | Task 10 |
| Pinned runtime, bounded host tasks and immutable image | Task 6 |
| Actual staged browser and installed OpenCode acceptance | Task 11 |
| Coherent publication, preservation and recoverable failure | Task 12 |

Self-review before committing this plan: validate every listed file and guarded script against the effective baseline; replace no prerequisites with imaginary passes; check fixture variable names and method signatures; scan for incomplete instructions; ensure every spec requirement maps to a task; and confirm that this authoring turn has changed only the approved spec status, this plan and the milestone line. No implementation checkbox is checked during plan authoring.
