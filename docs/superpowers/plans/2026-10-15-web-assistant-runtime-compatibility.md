# Web Assistant Runtime Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The October 15, 2026 execution instruction authorizes this single owner to implement, run necessary selected-Codex live acceptance, and publish after all gates pass. Do not delegate further or create tasks. Historical plan-only/publication caveats below are superseded; verification requirements are not.

**Goal:** Let only the administrator select one deployment-wide assistant, initially host-profile-backed Codex with `gpt-6.1-sol`, while preserving common Web workflows, security boundaries, and existing conversations through lazy context handover.

**Architecture:** Keep platform conversation and research state independent from native runtime sessions. Reuse the existing gateway, SDK, tenant runner, model/network brokers and persistence, with one revisioned selection and admission authority; adapters translate native protocols but cannot decide platform permissions. Prove native feasibility before broad integration and activate no assistant until required workflow gates pass.

**Existing Product Surface:** `ManagedAgentsCard`, Admin runtime APIs, `CliProfileResolver`, model configuration and `RuntimePicker`/per-user selection already exist. Extend those entry points to deploy the missing Codex runtime and isolated service profile, and migrate existing per-user selection to Admin global single selection. Do not report these features as wholly absent, create duplicate settings, or treat broad unrelated rewriting as necessary.

**Tech Stack:** Node.js ESM, React/TypeScript/Zustand, existing SDK, `smol-toml`, Node test runner and Vitest through guarded package scripts, existing sandbox file RPC/Rust core, CI-attested immutable Linux images.

---

## 1. Approved Boundary and Execution Rules

Specification: `docs/superpowers/specs/2026-10-15-web-assistant-runtime-compatibility-design.md`. The user approved exclusive administrator selection, no user assistant picker, and same-conversation continuation after administrator switching. The earlier exclusion of cross-runtime continuation is superseded.

- Web only. Retain desktop manual-approval defaults and shared build compatibility.
- Preserve approved Web automatic tool authorization, workspace isolation, explicit denies, research barriers, scoped networking, and browser-independent execution.
- Only one assistant may admit user execution/inference. A workspace helper process can remain without permission to invoke its disabled assistant.
- Never copy host keys into tenants or run a host CLI as a fallback. Do not change `/home/ubuntu/.codex` or expose all its models.
- No live Claude requests until the user confirms restoration. Keep deterministic Claude adapter tests and an explicit unavailable activation status.
- OpenCode free-tier refusal is a separate upstream issue. Do not mislabel an outage as an adapter permission error or weaken release gates to publish.
- All tests/builds/typechecks/lint use package scripts and the existing cgroup guard, sequentially. Do not run Vitest, Vite, Cargo or Docker builds directly on this host. Native image builds belong on dedicated CI.
- Do not patch frozen releases or installed image contents. Do not revert unrelated worktree changes. Preserve conversations, files, credentials, and recoverable state.

Execution authorization was received on October 15, 2026 (Asia/Shanghai). No further routine implementation/publication approval is required. A successful feasibility test, a model HTTP 200, or a persisted Admin selection is not product completion.

## 2. Baseline and File Ownership

Use the existing isolated branch `fix/web-prompt-send-recovery-20261015` at `/opt/open-science-desktop/.worktrees/web-prompt-send-recovery-20261015`. Its existing recovery fixes are not all deployed; retain them and test their integration. Production was inspected at release `2026-10-14T13-10-17-696Z-cd4c7c5e`, image `f28f552b`; recheck both at execution time. The dirty main checkout is not a deployment source.

| Responsibility | Existing integration points | Focused additions |
| --- | --- | --- |
| Exclusive selection and admission | `cli-runtime.mjs`, `platform-server.mjs`, `workspace-admission.mjs`, `workspace-state.mjs` | `assistant-policy.mjs` |
| Host profile and broker routing | `cli-profile.mjs`, `sandbox-control-plane.mjs`, `model-broker.mjs`, `main.mjs` | No new Admin/provider subsystem |
| Public conversation and binding metadata | `cli-runtime.mjs`, `session-authority.mjs`, `tenant-policy.mjs`, `workspace-management.mjs` | `conversation-state.mjs`, `conversation-router.mjs` |
| Bounded history handover | `cli-runtime.mjs:handoverText`, attachment and collaboration stores | `conversation-handover.mjs` |
| Runtime-independent tool authority | `automatic-tool-permissions.mjs`, `sandbox-native-jobs.mjs`, collaboration/network stores | `execution-permissions.mjs` |
| Native task transport and platform tools | `runtime/sandbox/cli-jobs.mjs`, `runner.mjs`, `collaboration.mjs` | `runtime/sandbox/native-tools.mjs` only after Task 1 proves its protocol |
| Revert semantics and file evidence | Existing file RPC, Rust file policy, snapshot implementation | `conversation-revert.mjs` only for verified missing adapter semantics |
| Web contract and Admin UI | Runtime store, SDK, `ManagedAgentsCard`, `RuntimePicker`, model settings | Existing components and localized strings |
| Image and release acceptance | Existing image workflow, measurement/staging/install, frozen release workflow | Focused contract/browser/live tests |

All paths below are repository-relative unless absolute. New modules need a corresponding focused test. Do not split unrelated sections of large existing files or create an alternative workflow scheduler.

### Contract Names Used Below

These names are planned interfaces, not claims that they already exist:

```ts
type Assistant = "opencode" | "codex" | "claude";
type ActivePolicy = { revision: number; activeRuntime: Assistant };
type AdminSelection = {
  runtime: Assistant; expectedRevision: number; operationId: string;
};
type TurnIdentity = {
  userId: string; instanceId: string; generation: number;
  conversationId: string; execution: number; requestId: string;
  policyRevision: number; runtime: Assistant;
};
type NativeBinding = {
  runtime: Assistant; nativeSessionId: string; identityRevision: string;
  representedSequence: number; // Last canonical event represented natively.
};
```

`AssistantPolicy` serializes brief policy/admission transitions, not entire turns. `admit(identity, reserve)` validates policy and registers an execution lease before releasing its serial section. Its idempotent `lease.settle({cleanupVerified})` releases authority only after verified cleanup; an unknown effect retains a durable recovery fence. `select(input)` uses the same serial section and rejects while any authoritative execution/mutation state is busy or unknown. Do not nest this global lock inside user-workspace locks; lock order is policy then workspace, with no reverse acquisition.

## 3. Verification Procedure

Use the exact focused package-script commands listed in each task: for example, `pnpm platform:test test/assistant-policy.test.mjs` for policy tests and `pnpm test src/components/settings/ManagedAgentsCard.test.tsx` for the Admin component. Use `pnpm release:test` for workflow tests and `pnpm sandbox:core:test` for changed Rust primitives. Run RED before each implementation and GREEN afterward. A RED result must be the intended assertion, not missing dependencies, a task-lock error, or an unrelated failure.

When the running project worker holds the shared task lock, run bounded checks through the existing maintenance wrapper. Example for Task 2 after its test exists:

```bash
node --input-type=module <<'NODE'
import { spawnSync } from 'node:child_process';
import { withProjectMaintenance } from './scripts/dev/web-release-maintenance.mjs';
const run = (command, args) => {
  const result = spawnSync(command, args, {stdio:'inherit'});
  if (result.error || result.status !== 0) throw new Error('Maintenance command failed');
};
await withProjectMaintenance({
  inspect: async () => null,
  stop: () => run('sudo', ['-n','systemctl','stop','osd-platform.service']),
  start: () => run('sudo', ['-n','systemctl','start','osd-platform.service']),
}, () => run('pnpm', ['platform:test','test/assistant-policy.test.mjs']));
NODE
```

Change only the package-script arguments for another test. Never remove a lock or terminate an unrelated process. Check service restoration after maintenance. Private fixtures, not real user conversations, supply destructive and fault-injection tests. Each task commits only its own verified paths with an explicit `git add`; never stage the whole dirty tree.

## 4. Tasks

### Task 0: Reconcile the Baseline and Record Readiness Without Mutations

**Read:** `AGENTS.md`, the approved spec, `PROGRESS.md`, `services/platform/src/main.mjs`, deployed image manifest, `package.json`, `.github/workflows/sandbox-image.yml`.

- [x] Record `git status --short`, branch/HEAD, `systemctl show osd-platform.service -p WorkingDirectory -p ActiveState`, public health, `df -h /`, and sanitized image tool/runtime metadata. Read no raw credential file into terminal output.
- [x] Inventory all durable account/session roots, including accounts not loaded in memory, historical OpenCode sessions, CLI histories and existing workspace mutation fences. Use trusted registry/path sources; do not guess directories from browser input.
- [x] Verify selected package scripts, CI authentication/artifact availability without printing tokens, disk headroom, and the existing rollback compatibility boundary. If an image cannot be built or staged safely, record that blocker before promising activation.
- [x] Run the guarded existing `session-authority`, `automatic-tool-permissions`, `sandbox-native-jobs`, `cli-runtime-sandbox`, `prompt-admission`, and `platform-server` suites. Confirm actual test filenames with `rg --files services/platform/test` before invocation. Preserve baseline failures as separate evidence.

Execution evidence (October 15): production remains `2026-10-14T13-10-17-696Z-cd4c7c5e`, image `sha256:f28f552b1beb7850fc4504eb5098ed07c11f177b60e3d37d1fdddfb2a7aca267`, health 200. The image contains only OpenCode, not Codex. Authenticated Admin reads still select OpenCode; the legacy persisted Codex enabled flag does not make it available or give it a catalog. Baseline six-suite verification passed 73 tests; the latest focused verification passed 99 platform and 52 release tests, all guarded, no skips. CI source publication and sanitized artifact access work through the existing credential helper without exposing credentials. Git transport timeout was worked around with the official Git data API while preserving the exact local commit identity, not by disabling TLS. Root disk has only 1.4 GiB free: final image installation headroom is not yet established. The existing rollback reader checks workspace lifecycle schema 1, not the planned conversation/policy schemas.

Completed read-only durable inventory: 18 auth accounts (11 disabled); the root-owned launcher registry has 24 bindings (21 existing instance/native roots, three absent roots), including ten owners absent from the current auth list that must not be deleted or ignored during migration. Its 21 OpenCode databases contain 119 sessions and 24 distinct directories, all under their workspace roots, with no unreadable database or unknown session schema. Four legacy worker records retain two databases with eight historical sessions. Two legacy CLI history files contain four owned sessions; no managed CLI sessions or orphan CLI account roots were found. One workspace lifecycle state file has zero pending runtime-mutation fences, pending operations or unsettled uploads at inspection time. Counts describe stored records, not deduplicated conversations or proof of idle native jobs; admission must still reconcile running/uncertain work at cutover. No history was printed or modified.

**Exit:** Effective source/image, retained recovery fixes, resource limits, and actual feasibility prerequisites are explicit. No service policy, profile or model has changed.

### Task 1: Prove the Pinned Native Capability Boundary First

**Read:** `scripts/dev/fetch-sandbox-codex.mjs`, `runtime/sandbox/cli-jobs.mjs`, installed pinned Codex protocol schemas and official protocol documentation.
**Create:** `services/platform/test/native-runtime-capabilities.test.mjs`, `services/platform/fixtures/native-protocol.mjs`.
**Modify for isolated CI probes:** `.github/workflows/sandbox-image.yml`, `scripts/dev/probe-production-runner.mjs`.

- [ ] Add schema/fixture assertions for native identity, ordered tool start/result events, questions, command/edit approvals, custom platform tools, cancellation, reasoning settings and attachment transport. Malformed/foreign frames must fail before dispatch.
- [x] Stage the existing integrity-pinned Codex download on dedicated CI and generate/read that exact binary's protocol there, not by substituting the interactive host Codex version. Extend the existing bounded production-runner CI probe to run it in a disposable sandbox image without installing or selecting that image in production. Task 12 later measures and attests the final integrated resources. Store only sanitized protocol facts in fixture assertions, not a giant generated schema or user configuration.
- [ ] Demonstrate a real pre-effect authorization boundary for command/edit and custom tool calls, including a required research checkpoint before any write. Demonstrate a permitted synthetic-file write inside the outer sandbox without host access, unsafe sandbox downgrade, or merely accepting an approval frame.
- [ ] Determine whether dynamic tools or a fixed private stdio MCP bridge supplies the required tools and guards. Prefer the existing native protocol; do not create both transports. If built-in effects cannot be guarded, reject activation and revise this task with a narrowly pinned native integration before continuing. Do not silently disable core workflows.
- [ ] Regress the actual pinned Rust parser and handler: explicit allow without `updatedInput` preserves the authorized original input; any input rewrite, extra tenant/project hook, malformed response, missing guard or concurrent Stop must fail closed. A hook receipt or successful process exit is not authorization evidence. Check all effect dispatch paths and deny precedence, not only the fixture's expected tools.
- [ ] Run `pnpm platform:test test/native-runtime-capabilities.test.mjs` RED/GREEN and commit the verified fixture/tests as `test(platform): pin native assistant capability contracts`.

**Gate:** Missing pre-effect guards, unsupported safe execution, or unverified native tool APIs are architecture blockers, not reasons to skip permissions. Claude receives deterministic compatibility fixtures only; no live probe.

Verified negative native evidence: dedicated CI run `38720316872`, source `786b0bbe2c334cb1d9d8d101293ec6a575566f70`, artifact `11964399127`, ran actual Codex `0.157.1` (SHA-256 `3e2584f3f3829a43a0495011a1cecb2facbe64a2403e2b682351fd9c2983f970`) and its bundled bubblewrap (SHA-256 `77360cb751ccedc5971391444ac86a8a33c15b04d6b4a6fe45f5d25496e62c4c`). All seven schema facts were present. Explicit denials blocked commands, edits and custom tools; positive controls verified actual command/edit bytes and a custom-tool effect. Crashing the hook nevertheless produced the same real command/edit writes: `crashed-command` and `crashed-edit` failed, so `activationEligible` is false. This is an offline synthetic tool-dispatch test, not live model evidence. Earlier runs `38717222272`, `38717705254` and `38718642387` exposed fixture staging/catalog/container differences and are not the authority for the fail-open conclusion.

Required narrow native integration: keep upstream source commit `36650394c5b38c2990ccf2a3457165ca3e9d9726`, lock the Web-only `runtime/codex-patches/required-effect-guard.patch`, and compile only on dedicated CI through `runtime:codex:build`. This separate Web binary must require a nonempty, complete managed guard run and an explicit valid allow response; crash, timeout, missing configuration, malformed/empty output and serialization failure must not authorize effects. Keep native workspace-write isolation, zero outer capabilities, no-new-privileges, private synthetic configuration and no egress. Rerun the actual native probe with all negative cases plus real permitted writes, recording compiled binary/resource/patch identities. Do not replace the host CLI or claim this integration is ready before that CI evidence and the remaining Task 1 protocol/identity/Stop/question checks pass. Tasks 2-15 remain unstarted behind this gate.

Native integration build investigation: run `38723095557` correctly rejected the release tag's unreconciled Cargo workspace lock (155 local packages still `0.0.0` while Cargo.toml says `0.157.1`). The builder now checks both original and workspace-version-only reconciled TOML SHA-256 identities and retains external package versions, checksums and `--locked`. Run `38724232797` then exposed a pre-existing pnpm importer/override specifier mismatch; `e078b2e` aligns only the specifier while retaining exact `js-yaml` 4.3.1 bytes. Run `38725249812` at that source is compiling on dedicated CI; no compiled native integration or successful effect gate is claimed yet. The current public HTTP model endpoint remains an explicit pre-activation security decision, requested from the parent/user without changing the endpoint or issuing a live request.

Independent review reproduced 13/13 guarded fixture tests with maintenance stop/restart, restored the production service and verified health; these tests did not execute the patched native binary. Review then identified a real parser/handler contract defect: upstream `permissionDecision:allow` without `updatedInput` is invalid, so the first fail-closed patch rejects the positive control. The revised integration must explicitly parse no-rewrite allow, reject every input rewrite and mixed legacy/structured decision, admit exactly one immutable system guard and reject all extra hooks before dispatch. Run seven actual Rust parser/handler regressions against upstream for RED, then those plus immutable-handler validation for GREEN before compiling the executable. Local string/fixture tests are not native authorization evidence. A payload-less registry dispatch is also an unguarded path and must fail closed. Stop races and remaining native protocol checks remain incomplete.

Resolved transport decision (October 15, Asia/Shanghai): after explicit disclosure of API-key and research-content exposure over the current public HTTP upstream, the user authorized using that existing endpoint unchanged. No further approval is required for this transport choice. Selected-Codex real acceptance and final publication no longer wait on it; native authority, workflow, conversation, measured image, provenance and compatible rollback gates remain mandatory. Do not print credentials, modify the endpoint or describe this transport as encrypted. Earlier unresolved-transport notes above are historical, not a current blocker.

Actual patched native evidence: run `38733364413` at `7b702d9e11f6dbfdfb42299eaa8620e5c2d1fcc4`, artifact `11975173974` (`native-capabilities-7b702d9e11f6dbfdfb42299eaa8620e5c2d1fcc4`), reproduced four failures in seven actual Rust parser/handler tests against upstream, then passed all eight tests after applying the pinned integration. The resulting Codex binary SHA-256 is `a87990338b067f2c5870d295ef2547d78e5e7c1942fe031f9d2952efd1c18309`. Native allowed command/edit cases verified actual bytes, and the allowed custom case recorded exactly one effect. All eighteen negative cases (explicit denial, crash, malformed/empty output, timeout and missing guard across command/edit/custom) recorded zero effects or custom dispatches. The run still failed because its old predicate required tool execution start/result events even when the guard prevented dispatch. Source `72263ef29e36cc4f09b9ca229b15b7010847ce72` instead requires a real native denial result with zero effects for those negatives and adds complete original-argument binding, Stop races, native questions and serialized reasoning/image evidence. Its dedicated run `38742084373` is in progress; Task 1 remains incomplete, and no production image or activation is inferred from these feasibility artifacts. Local guarded verification reached 104 platform tests and 52 release tests with zero skips. The service-only profile contract is approved but not implemented.

Independent review confirmed those artifact results and the denial-predicate root cause. `9458361` then tightened event evidence to the exact expected call ID and tool type, with guarded RED/GREEN tests; its superseded run `38747652250` was cancelled only while pending, not during compilation. The final feasibility source must run its own fixture and identity-checked native binary; the `72263ef` result cannot certify later fixtures. CI compilation caches must use exact upstream commit, original/reconciled lock, guard/test patch, builder, dependency lock, compiler, target and runner identity, with no fuzzy fallback. Cache hits still execute actual Rust RED/GREEN, Cargo build and binary/resource measurement, and never cache a passing probe result.

Stop evidence is layered: the initial stopped cases interrupt while guard authorization is pending, not after shell/child execution. Final native feasibility adds allowed and interrupted long-command controls: first observe the owned command item and parent/child start files, then interrupt the same native turn, await process cleanup, observe beyond the controlled delayed-write deadline and verify actual bytes or absence. Local real-process regressions reproduced a late write after parent-only termination and another after an already-exited parent with a surviving SIGTERM-resistant child. The fixture now uses detached process groups, observes close, escalates termination and does not forget remaining children when the parent exits. This is not yet native CI evidence or proof that the production adapter has complete cleanup parity; Tasks 8 and 14 must carry the same running-child and uncertain-cleanup tests through the actual adapter and final image.

### Task 2: One Durable Assistant Policy With Migration and Recovery

**Create:** `services/platform/src/assistant-policy.mjs`, `services/platform/test/assistant-policy.test.mjs`.
**Modify:** `services/platform/src/cli-runtime.mjs`, `services/platform/test/cli-runtime.test.mjs`.

- [ ] Write tests seeding runtime formats 1-4, conflicting per-user choices, independent enabled flags, and missing profiles. Migration preserves historical choices as data but derives one authoritative selection from the existing configured default, initially OpenCode; it must not activate Codex just because its legacy flag is true.
- [ ] Assert atomic policy writes, revision conflicts, identical operation receipt replay, changed-payload operation rejection, persistence failure, startup during an unfinished cutover, unknown durable execution fences, and selection while a turn is active.
- [ ] Add version 5 of the existing `runtime.json`, owned by the same manager/persist queue. Store active selection/revision and a bounded transition/receipt record there; do not create a second independently writable policy file. Separate persisted selection from safe readiness metadata.
- [ ] Implement fail-closed preparation/commit/reconcile with the interface in Section 2. The durable transition is written before revocation; startup closes admission and completes reconciliation before becoming ready. Persistence failure before commit keeps the old selection; uncertainty never permits both.
- [ ] Run `pnpm platform:test test/assistant-policy.test.mjs test/cli-runtime.test.mjs` RED/GREEN; commit `feat(platform): persist exclusive administrator assistant policy`.

**Test anchor:**

```js
assert.equal((await policy.describe()).activeRuntime, 'opencode');
const lease = await policy.admit(identity, async () => reservation);
await assert.rejects(policy.select({runtime:'codex', expectedRevision:1,
  operationId:'switch-1'}), {code:'assistant_busy'});
await lease.settle({cleanupVerified:true});
assert.equal((await policy.select({runtime:'codex', expectedRevision:1,
  operationId:'switch-1'})).revision, 2);
```

`identity` and `reservation` are disposable fixture values of the Section 2 contract; `policy` receives fake readiness, persistence and execution-inventory functions. Explicitly test these dependencies failing.

### Task 3: Fence Every Execution Path and Repair the Existing Admin API

**Modify:** `services/platform/src/{platform-server,cli-runtime,main,model-broker,sandbox-control-plane,prompt-admission,runtime-route-policy}.mjs` and corresponding tests; `services/platform/src/workspace-state.mjs` only for integrating existing durable mutation fences.

- [ ] Add HTTP tests: unauthenticated management is 401; student management/cross-site changes are 403; stale policy is 409 before native submission; user runtime-change requests cannot select any different assistant. Validate origin including proxy scheme/host conventions without loosening unrelated routes.
- [ ] Reuse Admin GET/POST at `/api/admin/runtime`: POST accepts exactly `AdminSelection`; GET reports safe active revision, readiness and owned operation outcome. Reject legacy independent enabling writes with an explicit migration error instead of letting them bypass exclusivity. User GET `/api/runtime` exposes active policy/model metadata without private profiles.
- [ ] Add the policy revision to prompt, command, shell, fork-as-execution, question/permission replies and broker authorization where applicable. Use `x-scikeel-assistant-revision` alongside, not instead of, the current worker-generation header. Stop remains possible for its captured original execution even after a stale page detects a policy change.
- [ ] Integrate global leases with OpenCode and native admission, existing workspace admission, prompt cleanup, and all durable account state. Include direct model requests from an old helper process: revoke/check inference grants on policy revision, not only UI routing. Separate workspace/bridge authority from inference so disabling OpenCode does not break file reads.
- [ ] Test switch versus first send, direct disabled-runtime requests, delayed old replies, active jobs on a cold/unloaded account, unknown write effects, HTTP acknowledgement loss and process restart. Lock ordering must not deadlock.
- [ ] Run focused `assistant-policy`, `platform-server`, `runtime-route-policy`, `model-broker` and `prompt-admission` tests; commit `fix(platform): fence runtime selection and prompt admission`.

### Task 4: Initialize and Synchronize an Isolated Service Codex Profile Into the Broker

**Modify:** `services/platform/src/{cli-profile,sandbox-control-plane,model-broker,main}.mjs`; `services/platform/test/{cli-profile,sandbox-control-plane,model-broker}.test.mjs`.

- [ ] Add private fixture profiles for API-key `auth.json`, configured `env_key`, catalog changes, partial writes, unsupported OAuth/auth modes, unreadable files, missing allowed model, and hostile executable/MCP/header settings. Use `smol-toml` and structured JSON only.
- [ ] Use the approved dedicated service `CODEX_HOME` inside existing private platform data, with the personal host home as initialization source only. Implement explicit controlled synchronization without silently replacing independent service configuration or changing the host. Keep upstream secrets server-only; service and tenant homes are different objects. Test owner/mode, no-follow traversal, symlinks, non-regular files, atomic coherent revisions and fail-closed validation.
- [ ] Prove the managed chain from allowlisted source import through private service credential resolution and broker routing to sanitized tenant configuration. Support absolute catalog source paths while extracting necessary allowed model metadata, never complete catalog instructions. Negative Web managed integration tests must fail if `copyForTurn` is invoked or raw auth/upstream credentials reach a tenant; retain legacy desktop behavior.
- [ ] Expose a private resolved provider snapshot to the trusted control plane and a separate safe catalog. For the first Codex activation, assert `models.map(m => m.id)` equals `['gpt-6.1-sol']`, retaining only actually supported reasoning/modality metadata. Do not rewrite the host catalog or duplicate credentials into `/etc/scikeel/model-brokers.json`.
- [ ] Add broker provider-snapshot replacement and revision-bound grant issuance/revocation using its private map. A new endpoint/auth identity cannot reuse an incompatible native binding or old grant. Persist only non-secret revision references/selection, not resolved keys.
- [ ] Assert injected fixture keys/URLs/paths do not occur in public runtime catalogs, errors, logs, exported history or tenant profiles; assert no host `copyForTurn` or host `spawn` in sandbox mode. Record the current HTTP upstream as an explicitly user-accepted plaintext transport risk, not an encrypted connection.
- [ ] Run `pnpm platform:test test/cli-profile.test.mjs test/sandbox-control-plane.test.mjs test/model-broker.test.mjs` RED/GREEN; commit `feat(platform): resolve Codex broker routing from the host profile`.

### Task 5: Give Conversations Stable Identity and Versioned Native Bindings

**Create:** `services/platform/src/conversation-state.mjs`, `services/platform/test/conversation-state.test.mjs`.
**Modify:** `services/platform/src/{cli-runtime,session-authority,tenant-policy,workspace-management}.mjs` and their tests.

- [ ] Seed legacy OpenCode and managed-CLI sessions with colliding native IDs, different owners, parent chains, attachment references, trash lifecycle and completed/failed/partial turns. Assert list/read after a switch does not hide history or authorize another owner.
- [ ] Extend existing platform CLI/session metadata storage to versioned conversation records: unchanged public ID, owner/workspace, ordered message origin mappings, binding history and represented sequence, and durable turn delivery state. Retain native payloads in their existing storage; normalized imported history is a rebuildable view, not a second independent transcript writer.
- [ ] Define explicit `open`, `importNative`, `appendEvent`, `bind` and `list` methods on `ConversationState`, with owner, expected revision and stable origin keys. Persist import cursors/mappings atomically. Never infer completed turns from a manager's startup `idle` default.
- [ ] Use bounded/paginated trusted runtime reads to index legacy records independently of active inference. Validate parent chains and original workspace through existing authorities. A read/import failure preserves the cursor and fails truthfully, not an empty or deleted conversation.
- [ ] Run `pnpm platform:test test/conversation-state.test.mjs test/session-authority.test.mjs test/tenant-policy.test.mjs test/cli-runtime.test.mjs` RED/GREEN; commit `feat(platform): preserve conversations across assistant selection`.

### Task 6: Route Existing Conversation APIs and Events Through Bindings

**Create:** `services/platform/src/conversation-router.mjs`, `services/platform/test/conversation-router.test.mjs`.
**Modify:** `services/platform/src/{platform-server,cli-runtime,interaction-replies}.mjs`, `packages/sdk/src/{OpenCodeClient,types,runtime}.ts`.

- [ ] Add black-box API tests for create/list/read/history/rename/fork/archive/move/events across historical and active bindings. Ordinary users see one merged owned history; a backend/native ID supplied directly cannot bypass the public conversation lookup.
- [ ] Make `ConversationRouter` resolve public conversation operations to existing adapters and normalize events with conversation, execution, sequence and runtime-binding identity. Writes still pass policy and workspace admission first. Do not keep the current runtime-based session lookup as an alternative bypass.
- [ ] Route inactive history reads through their retained native storage/normalized view without inference. Include historical-root inventory, project trash/restore, ancestor ownership, attachment records and session folders in these lookups.
- [ ] Add duplicate/out-of-order/late event tests, SSE reconnect and account change. Forward no old binding's approval as a new binding's request. Preserve SDK desktop calls; gate gateway-only revision metadata by Web mode.
- [ ] Run `pnpm platform:test test/conversation-router.test.mjs test/interaction-replies.test.mjs test/platform-server.test.mjs`, then `pnpm test src/test/opencode-client.sessions.test.ts src/lib/runtime.store.test.ts`; commit `feat(gateway): route stable conversations through runtime bindings`.

### Task 7: Lazy Handover With Explicit Delivery Uncertainty

**Create:** `services/platform/src/conversation-handover.mjs`, `services/platform/test/conversation-handover.test.mjs`.
**Modify:** `services/platform/src/{cli-runtime,conversation-state,conversation-router,attachment-turns}.mjs`, `services/platform/test/cli-runtime-sandbox.test.mjs`.

- [ ] Test all six directed pairs among OpenCode/Codex/Claude with deterministic adapters, same-runtime profile changes, and OpenCode -> Codex -> OpenCode with intervening messages. Assert compatible native resume only if its represented sequence covers current history.
- [ ] Define `prepareHandover({conversation,binding,profile,decisions,attachments})` returning bounded quoted completed context, trusted separately supplied platform state, validated owned references, and `resumeNativeSessionId` only if fresh. Reuse `handoverText` with twelve exchanges/16,000 characters as ceilings; report omission and essential-context failure rather than silently approving a truncated decision.
- [ ] Submit only on the next authorized user message. Use a durable turn receipt keyed by owner/conversation/request/payload hash; preserve original native session IDs as historical metadata, never pass one into a different runtime. Record `prepared`, `submitted`, `accepted`, `settled` or `unknown` without claiming an external side effect is exactly-once.
- [ ] Test failure before submit, loss after submit, retry with changed text, interrupted effects, worker replacement, long histories, missing images, deleted files, and persistence failure after a native reply. Unknown submission cannot be automatically retried; the UI retains the input and reconciles.
- [ ] Run `pnpm platform:test test/conversation-handover.test.mjs test/conversation-state.test.mjs test/conversation-router.test.mjs test/cli-runtime-sandbox.test.mjs`; commit `feat(platform): hand over completed context between assistants`.

### Task 8: One Execution Permission Decision for Every Adapter

**Create:** `services/platform/src/execution-permissions.mjs`, `services/platform/test/execution-permissions.test.mjs`.
**Modify:** `services/platform/src/{automatic-tool-permissions,sandbox-native-jobs,platform-server,collaboration}.mjs`; their focused tests.

- [ ] Add table-driven assertions for owner/ancestor, policy revision, generation, execution/job, explicit deny, outside-workspace access, Stop during await, pending research decision and repair-exhausted state. Foreign or blocked requests cause zero approval calls.
- [ ] Define `ExecutionPermissions.authorize(identity, action)` with injected current-authority, owned-session, execution/decision and effective-deny readers; return a scoped allow/deny decision, not a reusable global boolean. `assertCurrent(decision)` rechecks before a native reply or effect.
- [ ] Call this shared decision from OpenCode root/child automatic permission repair and Codex approval/custom-tool dispatch. Preserve existing child denies and approved Skills exceptions; do not infer that native `read-only` plus an accepted approval permits actual required writes.
- [ ] Keep question input interactive and platform research decisions durable. Cancellation expires native requests only after cleanup; native approval receipt does not settle a tool as successful. Add duplicate/late decision and cross-job replay tests.
- [ ] Run `pnpm platform:test test/execution-permissions.test.mjs test/automatic-tool-permissions.test.mjs test/sandbox-native-jobs.test.mjs test/collaboration.test.mjs`; commit `fix(platform): enforce common execution permissions in native adapters`.

### Task 9: Connect Native Research and Network Tools to Existing Services

**Create:** `runtime/sandbox/native-tools.mjs`, `services/platform/test/native-tools.test.mjs`.
**Modify:** `runtime/sandbox/{cli-jobs,runner,collaboration}.mjs`, `services/platform/src/{sandbox-native-jobs,platform-server,network-operations,model-broker}.mjs`, relevant fixtures/tests.

- [ ] Use only the protocol verified in Task 1. Register fixed schemas for `research_checkpoint`, `research_delivery`, `websearch`, and `webfetch`; no caller-selected executable, endpoint, host path, or host MCP inheritance. Add invalid JSON, oversized arguments, forged tool identity and unsupported method tests.
- [ ] Implement `NativeTools.call({identity,callId,name,input,signal})` via the existing scoped bridge. Bind native thread/turn/call to the platform conversation before policy checks; verify active calls using trusted adapter state rather than searching OpenCode history for a Codex call.
- [ ] Reuse `CollaborationStore` for checkpoint blocking, authenticated decisions, original-input hashes and actual delivery verification. Stop and repair exhaustion prevent subsequent effects. Prompt instructions alone are not enforcement.
- [ ] Reuse `NetworkOperations`/EgressBroker for exact origins, 120-second maximum budget, public-address checks, redirect continuation and per-operation revocation. Never pass a global authenticated proxy to every native shell. Unsupported native built-in networking stays disabled; equivalent application tools must work.
- [ ] Test actual controlled-origin request counts, no outbound attempt after denial, two concurrent conversations, Stop during grant acquisition, bridge/cleanup failure, forged model-token grants, and credential redaction. Prove the native effect guard from Task 1 covers all enabled effect paths.
- [ ] Run `pnpm platform:test test/native-tools.test.mjs test/network-operations.test.mjs test/collaboration-runtime.test.mjs test/collaboration-delivery.test.mjs test/sandbox-native-jobs.test.mjs`; commit `feat(sandbox): bridge native research and network workflows`.

### Task 10: Preserve Real Revert and Edit-Message Semantics

**Read:** `crates/osd-core/src/{file_policy,git_snapshot}.rs`, `runtime/history-plugin/history-guard.ts`.
**Create if native parity is absent:** `services/platform/src/conversation-revert.mjs`, `services/platform/test/conversation-revert.test.mjs`.
**Modify:** Existing conversation routing, file RPC/native adapter, `crates/osd-core/src/file_policy.rs`, `crates/osd-cli/src/managed.rs`, `runtime/sandbox/file-rpc.mjs`, `services/platform/src/workspace-rpc.mjs` only where checked restore primitives are missing.

- [ ] Reproduce current managed-runtime 501 behavior and specify native OpenCode revert semantics with controlled file changes. Test message ownership, confirmed idle, intervening manual edits, cross-runtime turns, new/deleted/binary/oversized/linked files, and lost acknowledgement.
- [ ] Prefer a verified native revert for its own fresh binding. For otherwise-required parity, capture bounded pre/post file versions under the tenant state root and use a receipt-based, revision-checked restore primitive, not `git reset`, `git checkout`, arbitrary symlink traversal, or truncating only the transcript.
- [ ] Define `ConversationRevert.prepare/commit/reconcile` bound to public target message, file versions and conversation revision. Persist a recovery journal before the first restore; on restart finish or report a truthful partial/unknown outcome. Do not claim atomic multi-file restoration without proving it. Original inputs, later user changes, provenance and unrelated files cannot be overwritten silently.
- [ ] Do not install a new workspace-wide unbounded file watcher or archive secrets. If required effects cannot be captured/restored safely within existing quota and native constraints, retain the activation blocker and get a narrower reviewed design; do not hide a formerly supported core control just to pass.
- [ ] Run guarded focused conversation/router tests and `pnpm sandbox:core:test` plus affected CLI/file-policy tests. Verify acknowledged file bytes and transcript after restart; commit `feat(platform): preserve checked conversation revert semantics` only after the gate passes.

### Task 11: Admin Single Selection and Ordinary Model-Only UI

**Modify:** `apps/desktop/src/components/settings/{ManagedAgentsCard,ManagedAgentsCard.test}.tsx`, `apps/desktop/src/components/thread/{RuntimePicker,RuntimePicker.test}.tsx`, `apps/desktop/src/{lib/runtime.ts,lib/runtime.store.test.ts,lib/webModelCatalog.ts}`, `SettingsPage.tsx`, `Composer.tsx`, existing settings/model tests, `packages/sdk/src/OpenCodeClient.ts`, locale catalogs and parity tests.

Verified existing entry point: the Admin account's model menu/page at `/settings/models` renders `GatewayModelsPanel`, which renders `ManagedAgentsCard` only for `role === "admin"`. Its existing switches read and write `/api/admin/runtime` (currently POST `{ runtime, enabled }`). Modify mutual exclusion and committed-policy behavior there, not in a parallel management page. Parent review independently confirmed this is the user's specified visible model-menu assistant switch.

- [ ] Add RED tests: only Admin sees the single-selection control; ordinary users have no assistant control; one selected radio value maps to committed policy, not optimistic readiness. Busy/unavailable targets explain failure without changing the effective selection.
- [ ] Replace independent managed-assistant switches inside the existing settings surface with an accessible radio/segmented selection. Send the Section 2 `AdminSelection`; on timeout GET/reconcile its operation before retry, rather than blindly rolling back or posting again.
- [ ] Remove/hide the assistant picker in authenticated platform Web only. Keep active backend metadata internal and expose its allowed models through existing model controls. A disabled or stale model is refreshed without silently submitting a different request/model.
- [ ] Attach both worker generation and policy revision to SDK sends, attachment XHR and interaction replies. Refresh metadata on revision conflict, preserve draft/files/answer input, and never replay automatically. Refresh must not cancel an accepted run.
- [ ] Preserve phone focus, fitting text, existing notifications and localization. No visible instructional feature descriptions or new marketing surface. Run `pnpm test src/components/settings/ManagedAgentsCard.test.tsx src/components/thread/RuntimePicker.test.tsx src/lib/runtime.store.test.ts src/lib/webModelCatalog.test.ts src/i18n/parity.test.ts`, then guarded typecheck/lint; commit `feat(web): expose administrator-only assistant selection`.

### Task 12: Measure, Attest and Install the Native-Capable Image

**Modify:** `.github/workflows/sandbox-image.yml`, `scripts/dev/{fetch-sandbox-codex,prepare-science-image,stage-sandbox-image}.mjs`, `scripts/dev/install-sandbox-image.py`, `runtime/sandbox/image-manifest.schema.json`, `services/platform/src/sandbox-manifest.mjs`, image tests and release source-input checks.

- [ ] Add manifest tests rejecting advertised Codex without its measured executable/version/hash, mismatched runner/tool bridge inputs, writable/untrusted manifests, altered image digest and unsupported native capabilities. Never trust a new environment flag as proof of image contents.
- [ ] Regress the exact discovered exclusions: `web-release-policy.mjs` source inputs must include `runtime/codex-patches/**` and `scripts/dev/build-codex-guard-runtime.mjs`; build-context validation must admit only the measured `codex-resources/bwrap` and `native-integration.json` additions. Bind patch/test/compiler locks, builder and native resources into manifest/tool lock, installer hashes and source matching. A guard-only change must invalidate old-image reuse. The production science job must actually build this integration; feasibility-only artifacts are not deployable images.
- [ ] Wire the existing integrity-pinned Codex download into dedicated CI, measure it and every new bridge/resource, and advertise Codex only after native workflow probes pass. Keep existing measured OpenCode infrastructure; do not advertise Claude merely because a fixture adapter exists.
- [ ] Load verified enabled runtimes from the installed immutable manifest into sandbox configuration/readiness, closing the current unpopulated `configuration.enabledRuntimes` path. The broker must use the selected assistant's provider snapshot, not the default OpenCode provider.
- [ ] Run `pnpm platform:test test/science-image.test.mjs test/sandbox-manifest.test.mjs test/sandbox-control-plane.test.mjs` and workflow checks before CI. After CI, stage/install through the existing guarded scripts with reviewed artifact provenance and exact source-input parity; never mutate an installed image or build it on this small host.
- [ ] Verify image-native protocol, allowed writes, denied host/cross-tenant reads and scoped network tools in disposable tenants. Retain production image selection until formal publication. Commit source changes as `build(sandbox): attest Codex runtime and workflow resources`.

### Task 13: Shared Adapter Matrix, Failure Injection and Browser Acceptance

**Create:** `services/platform/test/assistant-contract.test.mjs`, `services/platform/fixtures/assistant-contract.mjs`, `apps/desktop/src/test/webAssistantCompatibility.acceptance.test.mjs`.
**Modify:** Existing Web continuity, interaction, collaboration, attachment, project/file and recovery acceptance fixtures.

- [ ] Run one contract suite against OpenCode, Codex and Claude deterministic adapters: all spec Section 9 rows, all six handover directions, switch-back freshness, inactive history reads and stopped/unknown effects. Fixtures cannot mark unsupported capabilities ready.
- [ ] Inject failures at policy prepare/write/revoke/commit, native acceptance, history import and binding persistence, question acknowledgements, file restore and workspace restart. Assert effect counters, file bytes, immutable original hashes, no duplicate transcript and no simultaneous enabled inference.
- [ ] Browser fixture at 1280/390/320 verifies admin-only selection, student model-only UI, existing session after cutover, stale tab send, draft/attachment/question retention, research decision survival, streamed tool state, last-page absence and confirmed Stop.
- [ ] Register `OSD_ASSISTANT_BROWSER=1` in the frozen release browser runner so this scenario is mandatory for policy/router/native/image changes. Direct optional-skip execution alone is not acceptance.
- [ ] Run `pnpm platform:test test/assistant-contract.test.mjs`, required frontend suites, guarded lint/typecheck/build, then candidate browser execution through the release workflow. Inspect screenshots/artifact output for mobile overflow and console errors; commit `test(web): cover assistant compatibility and context handover`.

### Task 14: Selected-Assistant Live Gate and Storage-Compatible Rollback

**Modify:** `scripts/dev/{web-release-policy,web-release,web-release-deploy,web-release-source,web-release-state,web-release.test,safe-desktop-task}.mjs`, `package.json` only if a new guarded live alias is needed.
**Create:** `services/platform/test/assistant-runtime.live.acceptance.mjs`.

- [ ] Add RED release tests proving the new policy/router/permission/native modules select full platform, image where required, assistant-browser and native live gates. Replace the hardcoded `liveOpenCode` requirement with a versioned selected-assistant gate; do not silently reinterpret old manifest evidence as current success.
- [ ] Freeze target selection, allowed model, catalog/profile identity, image/source and required capability results into candidate metadata without keys, prompts or private profiles. A post-freeze identity change invalidates the live gate. Use a disposable account, not an existing user conversation.
- [ ] Live acceptance for selected Codex must perform a real reply, controlled file write/read, owned question/answer, actual research checkpoint/delivery, scoped public fetch, Stop/cleanup, reload and a legacy-history handover. No canned response or bare Responses API check substitutes for a native workflow.
- [ ] Keep pinned OpenCode deterministic/native protocol regression without depending on its failing free service. Record OpenCode live tests as blocked, not passed; prohibit activating it until available-provider live gates pass. No live Claude calls.
- [ ] Add rollback metadata for runtime-policy/conversation schema compatibility. Reject an older release that cannot read new data; prepare a compatibility-reader rollback release before first activation. Test rollback after new messages, bindings and file effects without erasing those records or resetting user files.
- [ ] Run `pnpm release:test`, the full guarded platform/frontend suites and candidate browser gates. Commit `fix(release): gate the selected assistant and compatible rollback` only after equivalent live evidence is enforced, not bypassed.

### Task 15: Frozen Candidate, Explicit Publication and Final Acceptance

**Read/modify evidence only:** Existing release manifest and `PROGRESS.md`.

- [ ] Review the complete spec-to-task matrix, staged source identity, CI image artifact and compatible rollback reader. Ensure all required Codex capabilities passed; ask the user about any unresolved native limitation or plaintext-upstream remediation rather than silently accepting weaker behavior.
- [ ] Inspect with `pnpm web:release inspect --source /opt/open-science-desktop/.worktrees/web-prompt-send-recovery-20261015`. Prepare with the same source, `--full --maintenance`, and the exact verified `--image-digest` returned by Task 12. Use actual workflow-returned identifiers, never an invented release/image ID.
- [ ] Before publication, present the prepared candidate/rollback identities, live-tested capability results and remaining OpenCode/Claude availability limits. Publication is authorized by the October 15 execution instruction, conditional on every required gate. Run the existing deploy command for the prepared release and apply the approved Admin target through the authenticated revisioned API; do not edit runtime JSON or credential files manually.
- [ ] Verify exact served assets, health, committed exclusive selection, only `gpt-6.1-sol`, no student assistant picker, legacy conversation readability and native continuation, isolation/permission outcomes and retained rollback. Required failure restores only a compatible release and preserves new histories/files; unknown rollback remains an explicit recovery state.
- [ ] Add one English actual-result milestone to `PROGRESS.md`, newest first. Report separately what was implemented, live-verified, deployed and still unavailable. Do not claim OpenCode upstream refusal was repaired by activating Codex.

## 5. Dependency and Review Gates

- Tasks 0-1 first: refuse to promise runtime parity without native protocol/effect evidence.
- Tasks 2-4 establish authority and private profile routing; no public activation.
- Tasks 5-7 establish durable conversation identity and safe handover.
- Tasks 8-10 establish actual permission, research/network and revert parity. Missing core semantics remain activation blockers.
- Task 11 changes UI only after backend contracts exist. Task 12 measures the final runner/resources, not an earlier incomplete bridge.
- Tasks 13-14 require deterministic, browser, native and rollback evidence together. Task 15 publishes only with explicit authorization.

Keep intermediate commits reviewable and non-activating. No service-wide switch, profile overwrite, unbounded native probe or live user-data migration is part of a RED/GREEN development step.

## 6. Spec Coverage and Plan Self-Review

| Specification requirement | Tasks |
| --- | --- |
| Admin global exclusive selection, no ordinary-user switch | 2, 3, 11, 13 |
| Host Codex config, only `gpt-6.1-sol`, real keys remain server-side | 4, 12, 14 |
| Stable history and workspace lifecycle across assistants | 5, 6, 7, 13 |
| No native identity/approval/token transfer; lazy continuation | 3, 7, 8, 13 |
| Preserve research decisions, scope and delivery checks | 7, 8, 9, 13 |
| Shared automatic permissions, explicit denies and scoped egress | 1, 8, 9, 12 |
| Stop, questions, browser absence, unknown effects and no replay | 3, 6, 7, 8, 13 |
| Revert/edit semantics do not become transcript-only success | 1, 10, 13 |
| Missing capabilities and unavailable Claude/OpenCode are honest | 1, 12, 13, 14 |
| Guarded tasks, attested image, frozen release, compatible rollback | 0, 12, 14, 15 |

Self-review: policy versus worker revisions are distinct; lock order and durable unknown effects are explicit; switching back cannot reuse stale native context; no new framework/provider editor is introduced; native hooks and safe revert are feasibility gates rather than assumed implementations; required tests cannot pass through skips; no Claude live request or disabled-assistant inference is authorized. Product implementation, tests and publication were not performed while authoring this plan; the subsequent October 15 instruction authorizes execution and gated publication by this single owner.
