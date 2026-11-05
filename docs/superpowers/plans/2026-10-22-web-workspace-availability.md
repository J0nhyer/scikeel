# Web Workspace Availability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Gateway Web workbench usable again after login, let an
administrator change the deployment's AI assistant, and keep every conversation
reachable — without a new runtime, image, or release mechanism.

**Architecture:** Make the platform able to account for every live sandbox
instance, so that a stale or unadopted instance is retirable instead of an
unknown that blocks the deployment; make the assistant transition report and
recover from its own failures; make the client distinguish the failures it can
act on, and stop reading one catalogue page as the whole conversation list.

**Tech Stack:** Existing React/TypeScript/Vite Web client, `@ai4s/sdk`, Node
platform services, the existing sandbox host, systemd cgroup v2, and the
existing guarded test and release scripts.

---

## Execution boundary and baseline

Specification:
[Web Workspace Availability and Assistant Selection Recovery](../specs/2026-10-22-web-workspace-availability-design.md).

Execution worktree: `/opt/open-science-desktop/.worktrees/web-login-performance-20261021`
(branch `feat/web-login-performance-20261021`). It is the published source of
release `2026-10-22T05-39-55-996Z-734a01dd` and holds the login-optimization
work. Do not edit the repository root, another worktree, or a frozen release
directory. Do not push.

Read the current `AGENTS.md` before starting. The published platform is the
74-module lineage; the repository root is the older 13-module lineage and is
not the execution baseline.

Use manual file patches for edits. Never use Git to restore files. Commit only
the reviewed files of the task in the execution worktree.

Before any test, create an ignored, short-path scratch directory in that
worktree and export it for every subprocess:

```bash
mkdir -p .deploy/t
export TMPDIR="$PWD/.deploy/t" TMP="$PWD/.deploy/t" TEMP="$PWD/.deploy/t"
git check-ignore .deploy/t
```

Never run `pnpm install`. Every build, test, typecheck and lint runs through the
package scripts, which apply the cgroup limits this 3.3 GiB host requires.
A busy `desktop-task.lock` means the live platform service holds it; schedule
around the service, never bypass the guard.

### Preconditions that are not the agent's to decide

- **The production assistant switch (task 7) requires the user's explicit
  authorization.** The design names the change; the authorization must be
  recorded before the change is made.
- **A platform restart interrupts running work.** Task 0 verifies that no turn
  is in flight before any restart.

## File ownership

| Responsibility | Files |
| --- | --- |
| Worker lifecycle and host inventory | `services/platform/src/managed-worker-manager.mjs` |
| Assistant policy, selection, recovery | `services/platform/src/assistant-policy.mjs`, `services/platform/src/cli-runtime.mjs`, `services/platform/src/assistant-runtime-authority.mjs` |
| Administrator routes and start-up behaviour | `services/platform/src/platform-server.mjs`, `services/platform/src/main.mjs` |
| Client assistant panel and messages | `apps/desktop/src/components/settings/ManagedAgentsCard.tsx`, `apps/desktop/src/i18n/locales/*/settings.json` |
| Client session list and readiness | `apps/desktop/src/lib/runtime.ts`, `apps/desktop/src/app/routes/LiveSessionPage.tsx`, `packages/sdk/src/GatewayBootstrapClient.ts` |
| Publication safety | `scripts/dev/web-release.mjs`, `scripts/dev/web-release-deploy.mjs` |
| Tests | `services/platform/test/*.test.mjs`, `apps/desktop/src/**/*.test.tsx` |

## Tasks

### Task 0 — Close the evidence gap and record the preconditions

- [ ] Reproduce the failure in a real browser (authorization already given for
      browser acceptance, including entering the administrator password) and
      record: the request that fails, the visible surface, and the moment the
      workbench becomes usable. Save the trace under an ignored path
      (`.deploy/diagnostics/`).
- [ ] With an administrator session, read `GET /api/admin/workers` and record
      the administrator instance's `status`, `generation` and whether a local
      record exists. This identifies which branch of
      `managed-worker-manager.mjs:46-47, 57, 88, 89-91` produced the uncertain
      effect.
- [ ] Read `GET /api/admin/runtime` and record `activeRuntime`, `revision`,
      `recoveryRequired` and `operation`.
- [ ] Confirm that no turn is in flight (`GET /api/admin/workers` plus the
      platform log) before any restart.
- [ ] Record the user's authorization for the production assistant switch.

**Done when:** the failing request path and the uncertain-effect branch are
named in writing, and the authorization is recorded.

### Task 1 — The platform accounts for every live instance

Files: `services/platform/src/managed-worker-manager.mjs`,
`services/platform/test/managed-worker-manager.test.mjs`.

- [ ] Write the failing tests first:
      - a launcher-reported live account that the platform has no local record
        for is retirable, and after the retirement the account reports stopped;
      - a stop that cannot be verified, where the host reports the account
        stopped at the current generation, does not latch the record, and a
        later start succeeds;
      - a stop that cannot be verified, where the host still reports the
        account alive, keeps the latch and keeps refusing acquisition.
- [ ] Implement: use the host inventory that `assistantInventory` already
      reads to decide whether a cleanup is verified, and add the retirement
      path for a live account the platform has not adopted. The host is the
      authority for "is this instance alive"; the platform's own records are
      not.
- [ ] Keep the existing refusal semantics for a genuinely unknown effect: an
      account the host still reports alive must keep blocking.
- [ ] Run `pnpm platform:test` and confirm the whole platform suite is green.

**Done when:** the new tests pass, the existing platform suite is green, and
the administrator's live instance is either adopted or retirable.

### Task 2 — The assistant transition reports and recovers from its own failures

Files: `services/platform/src/assistant-policy.mjs`,
`services/platform/src/cli-runtime.mjs`,
`services/platform/src/platform-server.mjs`,
`services/platform/src/main.mjs`,
`services/platform/test/assistant-policy.test.mjs`,
`services/platform/test/assistant-admin-contract.test.mjs`.

- [ ] Write the failing tests first:
      - a selection that repeats the same `operationId` and payload while a
        transition is pending re-runs the commit path and converges when the
        blocking condition is gone;
      - a selection with a different `operationId` while a transition is
        pending is still refused, with a code that says so;
      - `recoveryRequired` is true while the inventory holds a blocking effect,
        and the reported state matches what the transition would refuse with;
      - `assistant_unavailable` (target profile not ready) and
        `assistant_recovery_required` (work to reconcile) are distinct codes;
      - the reconciliation route requires an administrator and the same origin,
        and after it runs the reported state is consistent;
      - a policy whose replay fails still lets the platform start, reporting
        `recoveryRequired` instead of exiting non-zero.
- [ ] Implement the same-operationId replay in `select()`: it re-runs the
      existing commit sequence (inventory → prepare → revoke → prepare →
      inventory → save) and therefore still fails when the old runtime is not
      stopped.
- [ ] Implement the distinct codes and make `recoveryRequired` reflect a
      blocking effect, so the read route, the bootstrap guard and the client
      report one state.
- [ ] Expose the existing `reconcileAssistant()` as an administrator route next
      to the read and select routes, with the same admin and same-origin
      checks.
- [ ] Make a failed start-up replay a reported state instead of a process exit.
- [ ] Run `pnpm platform:test` and confirm the whole platform suite is green.

**Done when:** the new tests pass, the existing platform suite is green, and a
refused switch names its cause.

### Task 3 — The client distinguishes the failures it can act on

Files: `apps/desktop/src/components/settings/ManagedAgentsCard.tsx`,
`apps/desktop/src/i18n/locales/{en,zh-Hans,ja,de,es,fr,ko}/settings.json`,
`apps/desktop/src/components/settings/ManagedAgentsCard.test.tsx`.

- [ ] Write the failing tests first:
      - a 503 with `assistant_unavailable` shows the assistant-unavailable
        message;
      - a 503 with `assistant_recovery_required` shows a reconciliation
        message that names the action;
      - "retry" reconciles instead of re-posting an identical request that the
        server refuses;
      - a pending selection the server never persisted is released, so the
        panel is usable again.
- [ ] Implement the message mapping by error code rather than by "definitive"
      status. Do not treat 503 as definitive: a pending durable transition must
      keep its fence.
- [ ] Implement the release of a pending selection when the server proves it
      holds no such intent.
- [ ] Add the new strings to all seven locales.
- [ ] Run `pnpm test` and confirm the frontend suite is green.

**Done when:** the new tests pass, the frontend suite is green, and a 503 in
the browser shows a message that names the cause.

### Task 4 — A catalogue page is not the whole conversation list

Files: `apps/desktop/src/lib/runtime.ts`,
`apps/desktop/src/app/routes/LiveSessionPage.tsx`,
`packages/sdk/src/GatewayBootstrapClient.ts`,
the corresponding test files.

- [ ] Write the failing tests first:
      - a bootstrap snapshot whose `conversations.nextCursor` is set does not
        mark the session list ready;
      - while the list is partial, a conversation that is not in the loaded
        page is not reported as missing;
      - the catalogue cursor is followed for the session list, so a
        conversation outside the first page ends up in the list.
- [ ] Implement: keep the bootstrap page's cursor, follow it for the session
      list, and only set `sessionListReady` when the list is complete.
- [ ] Keep `missingSessionId` from rejecting a conversation while the list is
      known to be partial.
- [ ] Run `pnpm test` and `pnpm typecheck`.

**Done when:** the new tests pass, the frontend suite and typecheck are green,
and a conversation outside the first page is reachable in the running client.

### Task 5 — No readiness wait without a state

Files: `apps/desktop/src/app/routes/LiveSessionPage.tsx`,
`apps/desktop/src/lib/runtime.ts`, the corresponding test files.

- [ ] Write the failing tests first:
      - a workspace state the platform reports as unknown reaches the client as
        an explicit failure with a recovery action, not as an endless
        "checking project status";
      - a lifecycle check that cannot answer within its deadline ends in an
        explicit state.
- [ ] Implement: bound the lifecycle wait and route the unknown workspace
      state to the existing recovery affordance.
- [ ] Run `pnpm test` and `pnpm typecheck`.

**Done when:** the new tests pass and no surface can wait without a state.

### Task 6 — A publication must not change the selected assistant

Files: `scripts/dev/web-release.mjs`, `scripts/dev/web-release-deploy.mjs`.

- [ ] Write the failing test first: a publication whose candidate changes the
      assistant policy file's `activeRuntime` fails the publication and leaves
      the running deployment untouched.
- [ ] Implement: read the policy file's `activeRuntime` before and after the
      deployment, and fail the publication when it changed. The file is owned
      by the service account; no credentials are involved.
- [ ] Run the release script's own test suite.

**Done when:** the test passes and the publisher reports the assistant before
and after every publication.

### Task 7 — Return the deployment to the configured assistant

This task changes production state and runs only after the user's authorization
is recorded in task 0.

- [ ] Confirm that no turn is in flight and that the platform's catalogue has
      reconciled (`catalog.reconcile_failed` absent from the log).
- [ ] Restart `osd-platform.service` so the in-memory worker records are
      rebuilt, then confirm the policy file still reports the same
      `activeRuntime` and `revision`.
- [ ] Select the assistant through the platform's own API:
      `POST /api/admin/runtime` with `expectedRevision` from the live
      `GET /api/admin/runtime`, an `operationId` that has not been used, and
      the target runtime. Same-origin header required.
- [ ] Verify: `GET /api/admin/runtime` reports the new runtime and a higher
      revision; the policy file records it; the log shows no
      `assistant_recovery_required`.
- [ ] Log in from the browser and confirm the workspace becomes healthy and a
      prompt runs on the new assistant.

**Done when:** the deployment runs the intended assistant and the workbench is
usable.

### Task 8 — Publish

- [ ] Review the changed code with the code-review skill.
- [ ] Run the affected suites through the package scripts: `pnpm test`,
      `pnpm platform:test`, `pnpm typecheck`.
- [ ] Publish with
      `pnpm web:release run --source /opt/open-science-desktop/.worktrees/web-login-performance-20261021`.
- [ ] Confirm the health endpoint answers after the restart and that the
      publication's assistant check reports the assistant unchanged.

**Done when:** the intended version is served and the health endpoint answers.

### Task 9 — Browser acceptance

Use the same procedure as the login-performance plan's task 14. Endpoint timings
do not satisfy it.

- [ ] Log in and measure form submission to the readiness paint; report
      median, p95, maximum and failure count for every uncontended sample.
- [ ] Confirm the first screen shows the correct account, assistant, default
      model, projects and conversation page.
- [ ] Send a real prompt and read a real project file.
- [ ] Open a conversation outside the first catalogue page.
- [ ] Switch the assistant in Settings → Models and confirm the new assistant
      is in effect; also confirm a refused switch names its cause and offers
      the action.
- [ ] Open the history and log out; confirm both work.
- [ ] Append one line to `PROGRESS.md`: date, time, one sentence, release id.

**Done when:** every acceptance item in the specification's §5 is observed and
reported, with failures stated as failures.

## Not in this plan

- Rebuilding the sandbox image or the native agents.
- The tenant runner protocol, the on-demand runtime start, and the workspace
  cgroup budget; the 2026-10-22 release deferred them.
- The 13-module platform's runtime reader in the repository root; task 6
  protects the deployment against it.
- The research work modes work and the desktop client.
