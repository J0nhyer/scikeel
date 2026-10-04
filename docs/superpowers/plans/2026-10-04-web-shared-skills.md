# Web Shared Platform Skills Implementation Plan

**Goal:** Load the existing platform skill pack directly from the read-only image
in managed Web runtimes, preserving manual approvals and account isolation.
**Architecture:** Use OpenCode `skills.paths`, the existing managed-runtime flag,
and existing catalog APIs. Use a small administrator-only migration utility to
verify the old pack and move its copies out of discovery; do not add a service.
**Stack:** Node.js, Rust, React/TypeScript, pinned OpenCode 1.18.32.
**Execution:** Inline with superpowers:executing-plans, test-driven-development,
and verification-before-completion. The existing isolation worktree is reused.
**Scope:** Approved spec `../specs/2026-10-04-web-shared-skills-design.md`. V2
custom skill management is not implemented here. Preserve unrelated dirty files.

## 1. Runtime configuration and copy behavior

Files: `runtime/sandbox/runner.mjs`, `services/platform/test/tenant-runner.test.mjs`,
`crates/osd-core/src/runtime.rs`.

- [x] Change the gateway regression to expect the shared root and reject an
  injected `skills.paths` field in the externally supplied managed profile.
- [x] Add a Rust behavior test that deploys a tiny resource pack in ordinary
  mode, then confirms managed mode leaves an existing private skill untouched
  and creates no missing platform copies.
- [x] Run the gateway test and Rust test first; require failures for the old
  private root and unwanted managed copying.
- [x] Generate `skills: { paths: ["/opt/scikeel/tools/resources/skills-core"] }`
  and allow only that skill root after `"*": "deny"`.
- [x] Guard `deploy_bundled_skills` with the existing Linux `managed_files()`
  marker. Leave ordinary desktop behavior unchanged.
- [x] Run `pnpm platform:test test/tenant-runner.test.mjs` and
  `pnpm sandbox:core:test --package osd-core managed_skills` through the host guard.

## 2. Skill resources and catalog label

Files: six `runtime/skills/core/*/SKILL.md` helper instructions;
`apps/desktop/src/app/routes/SkillsPage.tsx` and its Web test;
`services/platform/test/shared-skills.test.mjs`.

- [x] Add a pack regression checking every Markdown file and shipped resource,
  all six helper names, and absence of the obsolete private-profile path.
- [x] Add a Web regression supplying an actual shared skill location without
  an explicit source; require the `built-in` label.
- [x] Run both tests and observe the old paths/label failures.
- [x] Replace the helper commands with paths based on `<skill-base-directory>`
  and explain that this is the directory returned by the skill tool, not a
  literal path or assumed environment variable.
- [x] Recognize the exact shared pack prefix as builtin in `sourceOf`.
- [x] Rerun the focused tests; inspect for other path assumptions. Use local
  disposable fixture files to validate helper invocation without network jobs.

## 3. Verified copy migration and rollback

Files: `scripts/dev/migrate-platform-skills.mjs`,
`services/platform/test/shared-skills.test.mjs`.

- [x] Add tests for dry-run, complete-tree verification, modified/unknown/link
  conflicts, atomic backup, idempotent rerun, restoration, and user-file retention.
- [x] Use a strict comparison to the trusted pre-upgrade pack before moving
  anything. The migration refuses nonmatching trees, rather than pruning files.
- [x] Move the verified `state/runtime/xdg-config/opencode/skills` directory to
  `state/runtime/platform-skills-v1-backup` by rename. Do not copy or delete it.
- [x] Provide dry-run by default, explicit `--apply`, and explicit `--rollback`;
  these are deployment tools for stopped runtimes, not runtime API endpoints.
- [x] Rollback restores only when the backup matches the trusted old pack and
  no conflicting live directory exists. Repeated operations must be safe.
- [x] Run focused tests through `pnpm platform:test`; run a read-only dry-run
  against both current accounts and the retained deployed old image pack.

## 4. Integrated verification and reviewable handoff

Files: `scripts/dev/probe-production-runner.mjs`, existing spec/plan,
`PROGRESS.md`. No new runtime management entities.

- [x] Extend image acceptance to require exactly one entry for each of the nine
  platform names, shared locations, no private copies, complete resource
  references, and a rejected shared-directory write.
- [x] Run the full guarded platform suite, affected Rust tests, Web regression,
  typecheck and lint. Run a bounded staged Web build only if needed for browser
  acceptance, leaving the deployed bundle untouched.
- [ ] Review the scoped diff and record actual outcomes and remaining deployment
  gates in `PROGRESS.md`.
- [ ] Commit only this feature's files. Do not stage unrelated in-progress work.
- [ ] Present the verified change and migration dry-run before image promotion.
  Production acceptance still requires the newly attested image, account
  restart/migration, a real OpenCode turn, old-conversation continuation, and
  desktop/phone catalog checks. Do not claim these pass from unit tests alone.

## Verified implementation checkpoint

The gateway regression failed first because `skills.paths` was absent; the Rust
regression failed first because managed mode overwrote a private resource. Both
pass with the minimal runtime changes. The resource-path and migration regressions
also failed before the updates and now pass, including the old image's unshipped
placeholder directories. Both production account migration dry-runs return
`ready` with 16 verified files; neither account was changed.

The current checkout also contains an independent catalog-description update.
Its shared-path builtin classifier is already present and deployed. Keep that
work intact; stage only the classifier and the shared-location regression for
this feature. No Web rebuild is required for an already-deployed classifier.

Passing checks: 267 platform tests (3 skipped), 244 Rust core tests (1 ignored),
11 Web catalog tests, typecheck, and lint. The production-image probe has been
extended and passes syntax checking; its new container acceptance is still
pending until a new image is built. No production copy migration, image switch,
worker restart, real-model turn, or conversation-continuation acceptance has
been performed for V1.
