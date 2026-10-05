# Web Update Workflow Design

Date: 2026-10-06
Status: Design approved in conversation; specification and implementation plan requested together. Implementation is not authorized by this documentation request.

## 1. Goal and scope

Reduce the time and manual coordination needed to deliver a SciKeel gateway Web change on the existing production host. Preserve resource limits, reproducible verification, tenant isolation, recoverable deployment, and user data.

The first deliverable is one bounded, resumable release workflow with change-aware verification, reusable vendor artifacts, staged acceptance, explicit deployment identity, and rollback. Improve the existing tooling; do not introduce a deployment service, a database, or a new application framework.

The user approved the six-part direction: a unified entry point, removal of duplicate checks, vendor caching and a separate Web build, verification of the exact deployed artifact, affected-service deployment and acceptance, and timing/storage visibility. They explicitly requested the spec followed by the plan without an intervening approval request.

Current product acceptance targets the gateway Web client, including phone-width viewports. Existing desktop build behavior must remain supported. CI migration, machine upgrades, zero-downtime deployment, and broad application refactoring are outside this first implementation.

## 2. Verified baseline

The following observations were collected on 2026-10-06. They are observations, not permanent configuration assumptions:

- The host reports four CPUs, 3,399 MiB RAM, 2,047 MiB swap, and approximately 6.8 GiB free space on its 40 GiB root filesystem. One sample reported 1,602 MiB available RAM; available memory varies with live workloads.
- The guarded task wrapper uses MemoryHigh=1850M, MemoryMax=2200M, MemorySwapMax=256M, a shared task lock, and host-pressure interruption. Do not raise these values or bypass the guard.
- The production service's effective WorkingDirectory is `/opt/open-science-desktop/.worktrees/tenant-science-isolation`. Its live process uses Web root `.deploy/web-build-qwTqC2` under that checkout. The main checkout's `apps/desktop/dist` is not the currently served bundle.
- Both `/etc/osd-platform.env` and `/etc/scikeel/platform-sandbox.env` exist. Effective systemd configuration and the running process, rather than the first configuration file found, determine production state.
- The main checkout has 117 changed/untracked paths. HEAD alone cannot identify the content of a release. Do not stage or copy unrelated work into an implementation commit.
- `safe-desktop-task.mjs` runs TypeScript, ACP server bundling, vendor bundling, and Vite for every existing build. `build-web-vendor.mjs` rebuilds its nine JavaScript outputs on every invocation.
- The vendor plugin also consumes Monaco CSS. Treat every consumed vendor asset, including CSS and workers, as part of the cache output contract.
- One historical verification batch recorded 281.30 seconds for 212 frontend test files, 120.69 seconds for the platform suite, 22.56 seconds for four focused frontend files, 12.60 seconds for browser acceptance, and 14.92 seconds for Vite. Vite's number excludes earlier build steps; these records do not measure complete release time.
- Frontend tests default to jsdom. That full run reported 75.76 seconds in environment setup. Environment changes might help later, but they are not required for the first release workflow.
- `PlatformServer` resolves its Web root at construction; `main.mjs` reads the environment at startup. Switching the configured root requires a platform restart in this design.
- Scientific image construction already runs in a dedicated CI workflow with measured identities and attestation. Preserve that path; do not rebuild images for unrelated UI changes.

Evidence: root and production-checkout package scripts; both guarded task wrappers; `scripts/dev/build-web-vendor.mjs`; `apps/desktop/web-vendor.ts`; production `services/platform/src/main.mjs` and `platform-server.mjs`; effective systemd service configuration; and `.deploy/verification/two-requirements/*.log`.

## 3. Alternatives

| Approach | Benefit | Cost | Decision |
| --- | --- | --- | --- |
| Improve the existing local release workflow | Reduces repeated work without adding infrastructure | Requires explicit selection and deployment contracts | Implement first |
| Move frontend verification/builds to CI | Removes heavy work from production | Requires source/artifact handoff, runner availability, and delivery authentication | Evaluate after measurements |
| Upgrade the machine | Increases resource margin | Does not fix duplicated checks or source/production drift | Evaluate separately |

Do not promise a fixed speedup from the historical logs. Measure equivalent changes before and after implementation.

## 4. Requirements

### R1. One explicit, resumable command

Add the root package script `web:release`. Supported subcommands:

```text
pnpm web:release inspect --source <checkout>
pnpm web:release prepare --source <checkout>
pnpm web:release deploy --release <id>
pnpm web:release run --source <checkout>
pnpm web:release rollback --release <id>
pnpm web:release prune --dry-run
```

`inspect` and `prune --dry-run` are read-only. `prepare` verifies and stages without changing production. `deploy` publishes an already prepared release without rebuilding. `run` composes prepare and deploy for an explicitly requested update; it does not add a per-step confirmation prompt. A failed stage exits nonzero and identifies the stage and candidate ID, without logging secrets.

Preparation requires an explicit checkout. Do not silently select the main checkout or apply changes from another worktree. Inspection displays the chosen source, production WorkingDirectory, effective Web root, image digest, changed content, test selection, and deployment actions. An incompatible source, including one missing active sandbox modules, fails before heavy work.

### R2. Stable content and deployment baseline

Freeze the source before verification using a file manifest and a candidate source directory under the shared `.deploy/web-releases/<id>/`. Copy tracked files and non-ignored untracked source files, excluding git internals, deployment output, build output, credentials, user state, and dependency stores. An explicitly maintained source allowlist covers package/configuration files, frontend/shared/SDK sources, platform code, runtime source, build scripts, and Rust inputs when applicable. Unknown changed source paths expand verification; they are not silently omitted.

Resolve symlinks conservatively: reject source links escaping the selected checkout or approved installed dependency roots. Use a bounded copy; do not read the entire tree into memory. Use existing installed dependencies through validated references, verify their lockfile identity, and do not install dependencies automatically.

Hash file contents and relative names, including additions and deletions. Record source base commit for context only. Build and test the frozen source; reject source/dependency mutations across preparation. The source root is configured independently from the active production root.

Use the last successful managed release as the change baseline. The first run imports and checks the existing deployment manifest and running process. If baseline provenance is incomplete, record that explicitly and require one conservative full verification; never equate the latest Git commit with verified production.

### R3. Conservative verification selection

Selection operates on changes against that deployed baseline, not solely on working-tree changes or HEAD. It includes callers and shared dependencies:

| Change group | Required verification | Build/deployment |
| --- | --- | --- |
| Known leaf UI, styles, translations | Registered related frontend tests, relevant locale parity checks, full frontend lint and one typecheck | Web build; affected page acceptance at 1280px and 390px |
| Login, session, SDK, shared state, platform routes | Registered frontend and platform test groups, lint and one typecheck when frontend inputs change | Affected Web/platform outputs; login/session browser acceptance |
| Broker, permissions, sandbox, runtime, dependency/configuration changes, unknown source changes | Full affected suites; security/runtime groups; bounded Rust checks for affected Rust inputs | Relevant outputs; existing image workflow only when image inputs change |
| Documentation only | Formatting/diff checks | No Web build, model call, or production mutation |

The registry is explicit and reviewed. Unregistered source changes select full affected suites. Do not use a fragile filename-neighbor rule or automatically reduce verification because a file looks small. Pipeline/bootstrap changes receive full workflow regressions; lockfile and build/test configuration changes invalidate applicable caches and select full frontend/platform verification.

An author may widen selection with `--full`; no flag bypasses required checks. Record selected and skipped groups with reasons. Do not claim that skipped groups passed.

### R4. One check per frozen candidate

Run typecheck once when required; the release Web bundling stage consumes that candidate's successful result. Ordinary `pnpm build` remains self-contained and includes its own typecheck and ACP build. Do not add a general skip-typecheck switch.

Frontend/backend groups run once per frozen candidate unless a failure or changed input justifies a repeat. Resume only stages whose input fingerprint and output hashes still match. Do not initially cache arbitrary test results across different releases.

Add an explicit guarded `web:build` entry without the Node ACP bundle. It keeps typecheck when called alone, resource limits, vendor preparation, and staged output. The release orchestrator shares its checked build functions inside the same verified guard.

### R5. Validated vendor cache

Cache vendor artifacts by the lockfile, vendor builder/plugin inputs, installed dependency input identity, build options, and relevant Node/esbuild versions. Verify the complete output list and hashes before a hit. Include Monaco CSS and all worker files. Build into a temporary cache directory and publish the complete directory only after successful verification.

A missing/corrupt artifact or changed input is a miss. A failed refresh leaves prior valid entries and production untouched. The Web bundle uses the verified cache directory; do not rewrite one shared mutable vendor directory while another consumer reads it.

Keep current vendor splitting and content-hashed emitted filenames. Do not inline Monaco/Office graphs into Vite or trade the existing memory optimization for a shorter script.

### R6. Host protection and serialization

All heavy stages run through package scripts and the existing verified cgroup guard. Preparation owns the shared host task lock once; internal stages inherit and verify the same guard instead of recursively acquiring the lock. Main checkout, linked worktrees, and frozen candidate sources must use the same lock location derived from the Git common root and recorded at preparation.

No parallel test/build/browser jobs on this host. Close the browser before the next heavy stage. Do not stop production or running workers merely to make a build fit. Preserve memory-pressure interruption and fail without changing production.

Deployment has a separate short global lock; it never overlaps another prepare/deploy/rollback mutation. A held lock produces a clear busy error with no hidden automatic retry loop. There is no new resident watcher or Vite development server.

### R7. Candidate acceptance

After deterministic checks and one build, start a local fixture platform serving that exact bundle, with synthetic accounts and fixture worker/runtime adapters. Use a single browser sequentially at 1280px and 390px. Select relevant existing login/workspace/refresh/attachment acceptance plus a basic app-load/no-page-error check. Browser skip conditions must not silently turn a required acceptance into success.

Frontend-only acceptance makes no real provider call. Real OpenCode acceptance is required when model transport, runtime execution, permission/tool behavior, or image inputs change. Run it against the deployed candidate with a temporary verification conversation only, preserve pre-existing sessions/files, and record provider unavailability as a distinct result. Do not probe Claude or alternative Claude endpoints. Do not enable disabled runtimes for acceptance.

There is no second browser fixture deployment and no second build merely to publish the prepared candidate.

### R8. Publication and rollback

Store the exact bundle and required platform source snapshot in the candidate directory. Include hashes for frontend entry/assets, platform/runtime files, dependency identity, and the scientific image identity independently. Unchanged platform code may reuse the current service source; changed platform code must run from a fixed candidate source rather than a worktree being edited.

A platform source switch uses a narrowly scoped systemd drop-in with WorkingDirectory pointing at that candidate source. Keep the existing executable and environment files. A Web switch changes only PLATFORM_WEB_ROOT in the effective managed configuration. Preserve every unrelated setting and mode/ownership. Validate paths, dependencies, image compatibility, and hashes before stopping/restarting the service.

The first implementation restarts `osd-platform.service` once whenever its Web root, source, or image configuration changes. It does not restart the sandbox host, tenant volume, or unrelated services for an ordinary Web update. Treat the switch as a recoverable transaction, not a zero-downtime atomic cutover.

Before the transaction, capture the previous Web root, effective source, image digest, managed configuration/drop-in contents, and artifact hashes. Configuration copies containing credentials are private (0600) and never included in public manifests or logs. Service interruption is authorized by the existing sole-user testing policy; preserve tenant files, sessions, auth state, and recoverable worker state.

After restart, check /health, the effective running process source/Web/image settings, and authenticated gateway delivery of the exact expected entry and assets. Run only the relevant authenticated smoke test; run live OpenCode acceptance when R7 requires it. Mark the new baseline successful only after these checks pass.

On any publication/acceptance failure, restore the prior configuration and source selection, restart the platform, and verify the prior entry hash and health. If rollback verification fails, report a recovery failure and retain all evidence; do not claim successful recovery or delete either version. Rollback never restores tenant data or reverts unrelated service/security changes.

Deployment rechecks the expected previous baseline before mutation. A candidate prepared against an older production baseline must be reclassified and reverified; do not overwrite a newer release.

### R9. Image identity remains separate

Reuse the currently installed, attested image when none of its actual inputs change. Compare image-relevant runner/binary/resource hashes, not just the source commit. A newer frontend commit does not invalidate an unchanged scientific image.

For changed image inputs, require the existing CI-generated image, manifest, measured runner files, and valid attestation before deploy; the release workflow does not build scientific images on this host. Preserve image-store validation and tenant-launcher policy.

### R10. Measured outcomes

Write a versioned JSON release manifest with: source fingerprint/base commit, deployed baseline, selected/skipped checks, tool versions, stage inputs, status, elapsed time, vendor hits/misses, candidate artifact hashes, source/Web/image identity, acceptance results, rollback identity, and safe errors. Use monotonic timers. Never record credentials, cookies, request bodies, conversation content, or entire environment maps.

Report total preparation time and publication time separately, including check/build/acceptance substeps. On interruption, preserve completed stages and mark the interrupted stage incomplete. Unknown outcomes are not success. Compare at least one representative UI change and one session/API change with the historical workflow using equivalent validation coverage.

### R11. Storage visibility without automatic deletion

`prune --dry-run` inventories only tool-owned release/cache directories. Show sizes, references, and eligibility. Pin current and previous successful releases, every currently referenced source/Web root or image, in-progress candidates, and unknown/unmanaged paths. Inspect effective service/configuration references before determining eligibility.

Do not delete user data, verification conversations, worktrees, credential stores, current images, or old deployment directories automatically. This phase does not implement destructive pruning. Warn with a measured storage estimate when preparation cannot fit; do not evict production or its rollback to make room.

### R12. Compatibility and implementation boundaries

Implement production-aware tooling in the production-compatible checkout. The main checkout currently lacks some active sandbox code, so blindly deploying it is unsupported. At execution time, create an isolated implementation checkout from the agreed production-compatible base, carrying only explicitly selected prerequisite changes. Fail if the source/base cannot represent the running deployment; do not reconcile unrelated work automatically.

Retain existing desktop commands and portable standalone builds. Linux systemd deployment subcommands are host-specific tooling, not product controls. They fail clearly on unsupported hosts; portable build/test behavior remains supported on macOS and Windows. No new desktop or gateway UI is required.

## 5. Implementation sequence

1. Establish the production baseline and frozen candidate identity; add timing and package-script regression coverage.
2. Add the conservative selector and shared guarded pipeline execution.
3. Split Web build behavior and add complete vendor cache validation.
4. Reuse existing browser acceptance against one candidate.
5. Add transactional publication, baseline checks, online identity verification, and rollback.
6. Add read-only storage reporting and compare representative end-to-end timings.

These are tasks in one release workflow, not separate independently deployed product features. Each task has a verifiable intermediate result; publication stays unavailable until its prerequisites pass.

## 6. Acceptance criteria

- A dirty source snapshot can be traced to every tested and deployed input; edits after preparation cannot change candidate contents.
- A known UI-only change selects required UI/parity checks without full platform/runtime suites, image rebuilds, or real provider calls. Unknown or high-risk source changes widen coverage.
- Typecheck runs once in release preparation; standalone build retains its existing checks.
- A warm vendor cache rebuilds no unchanged vendor outputs; missing CSS/worker output, tampering, and relevant dependency changes force a miss.
- Main/worktree/candidate heavy tasks serialize under the existing limits. Host-pressure interruption leaves the live bundle untouched.
- Required browser acceptance runs at both widths against the exact staged bundle; unavailable browser configuration fails instead of silently skipping.
- Publishing a prepared candidate performs no rebuild and verifies the served hashes. A changed backend runs from fixed candidate source.
- Failed restart, incorrect served assets, stale baseline, and failed required live acceptance trigger verified rollback or an explicit recovery failure.
- An unchanged scientific image remains valid across frontend-only source revisions; changed image inputs require existing attestation checks.
- Dry-run storage reporting preserves current/rollback and user-state references and performs no deletion.
- Both successful and failed runs leave a secret-free manifest with truthful timings/status. Desktop command compatibility remains intact.

## 7. Review outcome

Self-review checked scope, complete requirements, source/deployment identity, failed-build behavior, guard inheritance, cache integrity, secret handling, image provenance, and rollback. The user-approved direction is retained; no numerical performance promise, zero-downtime claim, automatic dependency installation, destructive cleanup, or Claude acceptance has been introduced.
