# Web Update Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task in this session. Steps use checkbox (`- [ ]`) syntax for tracking. Keep heavy tasks sequential on this host; do not dispatch parallel implementation or verification agents without explicit authorization.

**Goal:** Deliver a reproducible, resumable gateway Web update workflow that reduces redundant checks and vendor rebuilds while preserving the existing host limits and verified rollback.

**Architecture:** A small Node CLI selects verification from a deployed-content baseline, freezes source, and prepares one candidate under the existing guarded task runner. Shared build functions preserve standalone desktop behavior and provide a Web-only build with a validated vendor cache. A separate publication adapter switches the effective platform/Web configuration, verifies served identities, and restores the prior deployment on failure.

**Tech Stack:** Existing Node ESM, pnpm, TypeScript, ESLint, Vitest, esbuild, Vite, fixture PlatformServer/browser acceptance, Linux systemd/flock/cgroup v2, JSON manifests, and existing scientific-image attestation tooling. No new dependencies or services.

**Specification:** `docs/superpowers/specs/2026-10-06-web-update-workflow-design.md` (spec commit `3313816`). The user requested spec and plan together; this document does not begin implementation or deployment.

---

## Execution context and boundaries

Paths below are relative to the implementation checkout unless they are absolute. Production currently runs from `/opt/open-science-desktop/.worktrees/tenant-science-isolation`, not the main checkout. Inspect the effective service again at execution time. Do not use the main checkout's missing sandbox modules as the production base.

Use an isolated implementation worktree based on a verified production-compatible revision. Preserve every existing dirty path in both checkouts. When production prerequisites are uncommitted, copy only files explicitly matched to the running source/image and account for them in a prerequisite commit; do not blanket-copy either checkout. If deployed frontend source provenance is incomplete, import the deployed artifact identity and force a conservative full verification rather than claiming a source match. An incompatible source fails preflight before implementation deployment.

All Web tests, typechecks, lint and builds below run through package scripts. New Node workflow tests also receive a guarded package script. Never run Vite/Vitest/Cargo directly on this machine, never run heavy tasks in parallel, and never increase the configured memory limits. Do not probe Claude. Do not push, merge, install dependencies, delete worktrees/data, or deploy as part of writing this plan.

The root `.gitignore` ignores `docs/superpowers/`; the requested spec is tracked deliberately. Documentation commits use exact paths with `git add -f` and do not change ignore rules. Implementation commits also stage exact paths only.

## File responsibilities

| Path | Responsibility |
| --- | --- |
| `scripts/dev/web-release.mjs` | CLI parsing, sequential preparation, resumable stages, command dispatch |
| `scripts/dev/web-release-source.mjs` | Effective production inspection, source inventory/snapshot, baseline and content identity |
| `scripts/dev/web-release-policy.mjs` | Explicit change groups, conservative selection, stage requirements |
| `scripts/dev/web-release-state.mjs` | Schema, atomic manifest writes, timings, resume and read-only storage inventory |
| `scripts/dev/web-release-deploy.mjs` | Fixed publication/rollback actions and safe configuration handling |
| `scripts/dev/web-build.mjs` | Shared checked desktop/Web build execution within a verified guard |
| `scripts/dev/web-vendor-cache.mjs` | Input/output identity and complete immutable vendor cache |
| `scripts/dev/build-web-vendor.mjs` | Existing sequential bundling, parameterized output directory |
| `scripts/dev/safe-desktop-task.mjs` | Existing limits/lock, new release and release-test modes, shared guard execution |
| `apps/desktop/vite.config.ts`, `apps/desktop/web-vendor.ts` | Consume the selected verified cache directory |
| `package.json`, `apps/desktop/package.json` | Unified release entry, guarded workflow tests, explicit Web build |
| `apps/desktop/src/test/webRelease.acceptance.test.mjs` | Required candidate app load and browser fixture lifecycle |
| Existing `apps/desktop/src/test/web*.acceptance.test.mjs` | Reuse login/workspace/session/attachment scenarios with explicit candidate root |
| `scripts/dev/web-release.test.mjs` | Source, policy, state, orchestration and publication regressions using fake operations |
| `scripts/dev/web-vendor-cache.test.mjs` | Cache invalidation/completeness/failure regressions |
| `scripts/README.md`, `PROGRESS.md` | Existing operator instructions and one milestone line per completed result |

Do not split these helpers further unless implementation shows an actual need. `web-release.mjs` and helper modules must have no CLI side effects on import; expose named functions for deterministic tests and protect the CLI entry using the resolved `process.argv[1]`.

## Task 0: Establish a safe implementation base

**Files:** No application changes. Record execution-only inspection under the shared `.deploy/verification/web-update-workflow/`.

- [ ] Read `AGENTS.md`, the spec and this plan; inspect status in both checkouts and effective production paths:

```bash
git status --short
git -C /opt/open-science-desktop/.worktrees/tenant-science-isolation status --short
systemctl show osd-platform.service -p WorkingDirectory -p ActiveState -p FragmentPath
```

Expected: existing changes remain intact; the effective source and service status are recorded. Read process/configuration values with the existing allowlist approach; never print full environment files or `/proc/<pid>/environ`.

- [ ] Capture active Web entry hash, source file hashes, image digest and effective systemd overrides. Reconcile the existing release manifest with the running process. An absent source hash is `unknown`, not inferred from HEAD.
- [ ] Use `superpowers:using-git-worktrees` at execution time. Base the worktree on the verified production-compatible revision. Transfer only independently identified prerequisites; hash each transferred file before and after. If the agreed base is unavailable, stop deployment work with an explicit base mismatch while preserving existing state.
- [ ] Confirm installed dependency references and available memory/disk. The worktree does not get its own simultaneous heavy build. Copy the tracked spec/plan into the implementation branch only if that branch does not contain them.
- [ ] Record a baseline inventory, not a speculative timing benchmark. Do not rebuild or restart production just to prepare the workspace.

Checkpoint: an isolated, production-compatible checkout and a truthful baseline are available; no production mutation has occurred.

## Task 1: Add release identity and atomic stage records

**Create:** `scripts/dev/web-release-state.mjs`, `scripts/dev/web-release-source.mjs`, `scripts/dev/web-release.test.mjs`.
**Modify:** `package.json`, `scripts/dev/safe-desktop-task.mjs`.

- [ ] Add `release:test` mapped to `node scripts/dev/safe-desktop-task.mjs release-test`. Add the new mode to the existing allowlist; its guarded branch runs Node tests with `--test-concurrency=1` from the repository root. Preserve the production wrapper's Git-common-root lock behavior and every existing mode.

```js
// New guarded dispatch; execute only after the existing verifyLimits().
if (mode === "release-test") {
  run(process.execPath, ["--test", "--test-concurrency=1", ...args], root);
}
```

- [ ] Write the source fingerprint regression first. It proves that changing an untracked source input changes the fingerprint even when the base commit remains constant:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { fingerprintFiles } from "./web-release-source.mjs";

test("source identity includes content, additions and deletions", () => {
  const original = [{ path: "packages/sdk/src/index.ts", sha256: "a" }];
  assert.notEqual(fingerprintFiles(original), fingerprintFiles([
    ...original, { path: "apps/desktop/src/new.ts", sha256: "b" },
  ]));
  assert.notEqual(fingerprintFiles(original), fingerprintFiles([
    { path: original[0].path, sha256: "changed" },
  ]));
  assert.notEqual(fingerprintFiles(original), fingerprintFiles([]));
  assert.equal(fingerprintFiles(original), fingerprintFiles([...original].reverse()));
});
```

Run `pnpm release:test scripts/dev/web-release.test.mjs`. Expected initial failure: missing new exported module/function, not an unrelated infrastructure error.

- [ ] Implement stable identity and versioned atomic state writing:

```js
import { createHash } from "node:crypto";
export function fingerprintFiles(files) {
  const entries = [...files].sort((a, b) => a.path.localeCompare(b.path));
  if (new Set(entries.map((entry) => entry.path)).size !== entries.length)
    throw new Error("Duplicate source path");
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}
```

In `web-release-state.mjs`, export `writeManifest(path, manifest)` and `recordStage(manifest, name, inputFingerprint, action)`. `writeManifest` writes a sibling random temporary file with mode 0600, fsyncs/closes it and renames it over the destination. `recordStage` records `running` before execution, uses `performance.now()` for elapsed time, records `passed` only after successful output validation, and records a safe error category on failure before rethrowing. Record interrupted stages as incomplete on resume; do not serialize `Error` objects, environments or command output indiscriminately.

The manifest starts with these concrete fields:

```js
const manifest = {
  schema: 1, id, status: "preparing",
  source: { baseCommit, fingerprint, files, dependencyFingerprint },
  baseline: { id: baselineId, fingerprint: baselineFingerprint, known: baselineKnown },
  selection: { frontend: [], platform: [], browser: [], full: false, reasons: [] },
  stages: {}, artifacts: {}, deployment: null, rollback: null,
};
```

Every identifier above comes from inspected inputs; do not default missing baseline identity to HEAD.

- [ ] Add failure tests: incomplete stage cannot resume as passed; corrupted recorded output invalidates resume; error text containing a synthetic password/cookie is absent from the public manifest; atomic-write interruption leaves the last complete manifest readable.
- [ ] Run the same guarded tests. Expected: all identity/state cases pass; no service restart or browser process occurs.
- [ ] Commit exact changed files: `feat: record bounded Web release identities and stages`.

## Task 2: Freeze source and inspect the effective deployment

**Modify:** `scripts/dev/web-release-source.mjs`, `scripts/dev/web-release.test.mjs`.

- [ ] Add tests using temporary fixture checkouts: selected source differs from production; dirty/untracked sources are included; ignored credentials/data are excluded; escaping symlinks are rejected; a snapshot remains unchanged after the original source is edited; missing production sandbox modules fail compatibility validation.
- [ ] Export `inspectProduction(ops)`, `inventorySource(root)`, `createCandidate(root, production, releaseStore)` and `validateCandidate(candidate)`. Inject service/filesystem probes for tests. The production adapter reads effective systemd WorkingDirectory/environment-file order and whitelisted running-process values. It never assumes the first env file is authoritative.
- [ ] Implement the source selection boundaries exactly:

```js
export const SOURCE_ROOTS = [
  "apps/desktop/src/", "packages/", "services/platform/src/", "runtime/",
  "crates/", "scripts/",
];
export const SOURCE_FILES = [
  "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "OPENCODE_VERSION",
  "Cargo.toml", "Cargo.lock", "apps/desktop/package.json",
  "apps/desktop/tsconfig.json", "apps/desktop/vite.config.ts",
  "apps/desktop/web-vendor.ts", "services/platform/package.json",
];
```

Include all additional existing frontend lint/PostCSS/Tailwind/TypeScript configuration, platform tests/fixtures and frontend test files required by selected checks. Treat unknown tracked or non-ignored source paths as full-verification inputs. Exclude `.git`, `.deploy`, `node_modules`, `target`, `dist`, local env/credential files and tenant/auth state even when accidentally present. Detect an excluded file required by imports and fail rather than producing a partial snapshot.

- [ ] Enumerate Git tracked and non-ignored untracked paths with NUL-separated arguments. Stream hashes, copy files sequentially, record executable mode, and reject special files/escaping symlinks. Copy to `<shared .deploy>/web-releases/<id>/source`. Validate installed dependency references against the chosen lockfile and their resolved package identities. Link only approved dependency trees; record and revalidate their identity before/after the run. Do not run an install.
- [ ] Save the shared lock root in candidate metadata. Compute it from `git rev-parse --path-format=absolute --git-common-dir` in the original checkout; frozen sources use this checked location, not their own isolated `.deploy` directory.
- [ ] Import the existing manifest's artifact/image identities when they match the running process. Missing source provenance sets `baseline.known=false`, which mandates a full first preparation. A changing source inventory during copy fails cleanly and retains evidence without changing production.
- [ ] Run `pnpm release:test scripts/dev/web-release.test.mjs`. Expected: snapshots are stable, exclusions enforced, effective configuration precedence respected, and legacy baseline uncertainty preserved.
- [ ] Commit exact changed files: `feat: freeze production-aware Web release source`.

## Task 3: Select verification conservatively

**Create:** `scripts/dev/web-release-policy.mjs`.
**Modify:** `scripts/dev/web-release.test.mjs`.

- [ ] Write these policy regressions before implementation:

```js
import { selectVerification } from "./web-release-policy.mjs";

test("unknown inputs and unknown baseline force full verification", () => {
  assert.equal(selectVerification(["apps/desktop/src/new-area.ts"], { known: true }).full, true);
  assert.equal(selectVerification(["apps/desktop/src/components/sidebar/Sidebar.tsx"], { known: false }).full, true);
});
test("runtime transport changes require platform and live acceptance", () => {
  const selection = selectVerification(["services/platform/src/model-broker.mjs"], { known: true });
  assert.equal(selection.liveOpenCode, true);
  assert.equal(selection.platformFull, true);
});
test("documentation does not schedule a build", () => {
  const selection = selectVerification(["README.md"], { known: true });
  assert.equal(selection.buildWeb, false);
  assert.equal(selection.deploy, false);
});
```

Run `pnpm release:test scripts/dev/web-release.test.mjs`. Expected: the new policy cases fail until the selector exists.

- [ ] Export `selectVerification(changedPaths, baseline, { full = false } = {})`. Results include `full`, `frontendFull`, `platformFull`, `frontendFiles`, `platformFiles`, `browserGroups`, `typecheck`, `lint`, `buildWeb`, `deployPlatform`, `imageRequired`, `liveOpenCode`, and reasons for skipped groups. A full flag widens checks only.
- [ ] Register initial known groups using actual production-compatible files: login (`loginPreparation`, `runtime`, `OpenCodeClient`, gateway cookie/login routes); session (`SessionView`, refresh/history/session store/client); attachments (`conversationAttachments`, attachment components/routes/input/turns); translations (parity/i18n tests). Register a leaf UI path only after checking its callers and identifying meaningful tests. Unregistered paths select full affected suites.
- [ ] Dependency/config/build/test-tool changes select full frontend/platform coverage and invalidate applicable caches. Runtime/broker/security changes select platform security tests and required live OpenCode acceptance. Derive `imageRequired` from the image workflow's actual input files and manifest runner identities; do not merely match `runtime/**` or compare commits.
- [ ] Add deletion/addition, shared SDK caller, changed tests, mixed change groups, and lockfile cases. Group unions deduplicate selected test files and never remove a required check.
- [ ] Run guarded tests. Expected: known UI changes exclude unrelated runtime work, broad changes widen coverage, and selection reasons explain every skipped group.
- [ ] Commit exact changed files: `feat: select Web release checks from deployed changes`.

## Task 4: Share guarded build execution and remove duplicate checks

**Create:** `scripts/dev/web-build.mjs`.
**Modify:** `scripts/dev/safe-desktop-task.mjs`, `apps/desktop/package.json`, `scripts/dev/web-release.test.mjs`.

- [ ] Add regression tests with injected stage functions:

```js
import { runWebStages } from "./web-build.mjs";
test("release bundle consumes one candidate typecheck and excludes ACP", async () => {
  const calls = [];
  const stage = (name) => async () => { calls.push(name); };
  await runWebStages({ profile: "release", sourceFingerprint: "same",
    checkedFingerprint: "same", check: stage("check"), acp: stage("acp"),
    vendor: stage("vendor"), bundle: stage("bundle") });
  assert.deepEqual(calls, ["vendor", "bundle"]);
});
test("standalone desktop build retains its checks", async () => {
  const calls = [];
  const stage = (name) => async () => { calls.push(name); };
  await runWebStages({ profile: "desktop", check: stage("check"), acp: stage("acp"),
    vendor: stage("vendor"), bundle: stage("bundle") });
  assert.deepEqual(calls, ["check", "acp", "vendor", "bundle"]);
});
```

- [ ] Implement the explicit profile contract:

```js
export async function runWebStages(options) {
  const { profile, sourceFingerprint, checkedFingerprint, check, acp, vendor, bundle } = options;
  if (!["desktop", "web", "release"].includes(profile)) throw new Error("Invalid build profile");
  if (profile === "release") {
    if (!sourceFingerprint || sourceFingerprint !== checkedFingerprint)
      throw new Error("Candidate typecheck does not match source");
  } else await check();
  if (profile === "desktop") await acp();
  await vendor();
  return bundle();
}
```

The production implementation accepts `checkedFingerprint` only from a validated, passed candidate stage. Do not expose it or a skip-check option as a public CLI argument.

- [ ] Add root/desktop `web:build` package scripts mapped through `safe-desktop-task.mjs web-build`. Keep existing `build` behavior. Extract existing child execution and staged Vite build logic into shared functions, retaining V8 heap limits, cgroup checks, output validation and failed-build preservation. Standalone Web builds still typecheck; release builds always stage and never replace a production root implicitly.
- [ ] Add guarded `release` execution. One outer scope acquires the original common host lock, verifies limits, and dispatches the frozen candidate pipeline. Internal shared functions run inside that verified scope; they do not acquire the lock again. Do not introduce an environment-only guard bypass. Direct worker entry outside the correct cgroup fails.
- [ ] Test shared-lock derivation across the main checkout, worktree and snapshot; inherited guard refusal; busy lock; pressure interruption; wrong typecheck fingerprint; failed build leaving the deployed index hash unchanged.
- [ ] Run `pnpm release:test scripts/dev/web-release.test.mjs`, then `pnpm typecheck` once if the extraction affects frontend configuration. Run sequentially.
- [ ] Commit exact changed files: `refactor: share guarded desktop and Web build stages`.

## Task 5: Cache the complete vendor output safely

**Create:** `scripts/dev/web-vendor-cache.mjs`, `scripts/dev/web-vendor-cache.test.mjs`.
**Modify:** `scripts/dev/build-web-vendor.mjs`, `scripts/dev/web-build.mjs`, `apps/desktop/vite.config.ts`, `apps/desktop/web-vendor.ts`.

- [ ] Write cache tests using a synthetic directory and an injected builder; they do not run Monaco/esbuild repeatedly. Exercise cold miss, warm hit, changed inputs, corrupt JS, missing CSS/worker and failed refresh preserving the previous entry.
- [ ] Define the exact cache output contract:

```js
export const VENDOR_OUTPUTS = [
  "pptx-preview.mjs", "monaco-editor.mjs", "monaco-editor.css",
  "editor.worker.js", "json.worker.js", "typescript.worker.js",
  "openchemlib.mjs", "exceljs.mjs", "docx-preview.mjs", "3dmol.mjs",
];
```

Hash all these outputs in `vendor-manifest.json`. CSS is emitted by the existing Monaco ESM esbuild operation; do not substitute a different CSS bundle from the package's minified standalone build.

- [ ] Export `vendorInputFingerprint(inputs)`, `validateVendorCache(directory, expectedKey)` and `ensureVendorCache({ store, key, build })`. The key includes lockfile bytes, builder/plugin/config bytes, Node/esbuild versions, build options, and resolved package source identities. Resolve the builder's installed entrypoints and transitive package inputs; stream hashes of those approved package trees. Do not trust mtimes alone or merely package.json versions.
- [ ] Make the existing vendor builder export `buildVendor({ root, outputDirectory })`; preserve sequential esbuild calls. Its CLI accepts the explicitly chosen output directory and uses the existing standalone default when none is supplied. Do not change bundling options to save memory at the expense of functionality.
- [ ] Build into a new sibling temporary cache directory. Check complete output hashes, atomically publish the directory, then return its immutable path and hit/miss status. No consumer reads a directory being refreshed. An interrupted miss cannot replace a complete cache entry.
- [ ] Parameterize Vite's plugin directory using an explicit `OSD_WEB_VENDOR_DIR` set by the guarded build. The cache adapter validates the directory before Vite; the plugin continues emitting content-hashed names and fails if a required file is absent. Preserve the existing default for standalone builds.
- [ ] Run `pnpm release:test scripts/dev/web-vendor-cache.test.mjs scripts/dev/web-release.test.mjs`. Then run one guarded `pnpm web:build` in staged mode and a second equivalent build to measure a warm hit. Expected: zero vendor builder invocations on the second build, no production root mutation, and all CSS/workers present. Record the key/hash-check overhead as well as saved bundling time.
- [ ] Commit exact changed files: `perf: reuse validated Web vendor artifacts`.

## Task 6: Prepare one candidate and run required browser acceptance

**Create:** `scripts/dev/web-release.mjs`, `apps/desktop/src/test/webRelease.acceptance.test.mjs`.
**Modify:** `package.json`, `scripts/dev/web-release.test.mjs`, relevant existing browser acceptance files.

- [ ] Add `web:release` mapped to `node scripts/dev/web-release.mjs`. Reject unknown commands/options and require an explicit source for inspect/prepare/run. `inspect` is light and read-only; mutation commands enter the shared guarded release scope.
- [ ] Export `prepareRelease(candidate, selection, ops)` and use this exact sequential ordering:

```js
export async function prepareRelease(candidate, selection, ops) {
  await ops.validateSource(candidate);
  if (selection.lint) await ops.stage("lint");
  if (selection.typecheck) await ops.stage("typecheck");
  if (selection.frontendFull || selection.frontendFiles.length) await ops.stage("frontend-tests");
  if (selection.platformFull || selection.platformFiles.length) await ops.stage("platform-tests");
  if (selection.imageRequired) await ops.stage("image-validation");
  if (selection.buildWeb) {
    await ops.stage("vendor");
    await ops.stage("web-bundle");
    await ops.stage("candidate-browser");
  }
  await ops.validateSource(candidate);
  await ops.validateArtifacts(candidate);
  await ops.markPrepared(candidate);
  return candidate;
}
```

`ops.stage` is implemented using Task 1 records and Task 4 checked execution. Vendor work must not run a second time inside the bundle stage; inject the validated directory returned by the vendor stage. For docs-only changes, return a verified no-deployment result.

- [ ] Add fake-operation orchestration tests: exact order and one invocation per stage; typecheck failure prevents bundle; browser failure prevents prepared status; source/dependency mutation prevents resume; full selection deduplicates groups; a passed test with a changed input reruns.
- [ ] Add candidate acceptance with synthetic AuthStore, fixture worker/CLI adapters, temporary state and one Chromium process. Serve `OSD_WEB_CANDIDATE` explicitly; at 1280px and 390px check authenticated page load, no page errors, no horizontal overflow and the relevant entry hash. Close contexts/browser/platform/state in `finally` before another stage begins. Never use the production account store for staged acceptance.
- [ ] Reuse existing login/refresh/workspace/attachment/session acceptance scenarios. In the production-compatible checkout the session scenario is `webSessionContinuity.acceptance.test.mjs`; the main checkout also contains `webRefresh.acceptance.test.mjs`. Select the scenario actually available in the frozen source, and fail if a required registered scenario is absent. Standardize the candidate-root variable, preserving existing invocation compatibility.
- [ ] Enforce prerequisites in the controller before running tests:

```js
export function requireBrowserConfiguration(environment) {
  for (const name of ["OSD_PLAYWRIGHT_PATH", "OSD_CHROMIUM_PATH"])
    if (!environment[name]) throw new Error(`Missing browser prerequisite: ${name}`);
}
```

Set required acceptance flags explicitly and reject a report in which required cases were skipped. Capture only safe test status/counts, not login credentials or browser storage state.

- [ ] Run guarded workflow regressions, then one `pnpm web:release prepare --source "$PWD" --full` using verified local browser paths. Expected: a prepared manifest and one exact bundle; production WorkingDirectory, Web entry hash and image digest remain unchanged. Run no real provider acceptance at preparation for a UI-only candidate.
- [ ] Commit exact changed files: `feat: prepare and accept one bounded Web release candidate`.

## Task 7: Publish with identity checks and verified rollback

**Create:** `scripts/dev/web-release-deploy.mjs`.
**Modify:** `scripts/dev/web-release.mjs`, `scripts/dev/web-release.test.mjs`.

- [ ] Implement and test the transaction using injected operations before any live service mutation:

```js
export async function publishRelease(candidate, ops) {
  await ops.validatePrepared(candidate);
  await ops.compareBaseline(candidate);
  const previous = await ops.capturePrevious();
  await ops.saveRecovery(previous);
  try {
    await ops.switchConfiguration(candidate);
    await ops.restartPlatform();
    await ops.verifyProduction(candidate);
    await ops.requiredLiveAcceptance(candidate);
    await ops.markPublished(candidate, previous);
  } catch (cause) {
    try {
      await ops.restorePrevious(previous);
      await ops.restartPlatform();
      await ops.verifyPrevious(previous);
    } catch (recovery) {
      throw new AggregateError([cause, recovery], "Publication and recovery failed");
    }
    throw new Error("Publication failed; previous deployment restored", { cause });
  }
}
```

Test wrong/stale baseline, altered candidate hash, changed dependency identity, restart failure, incorrect served asset, failed required live acceptance, rollback failure and success. `validatePrepared` and `compareBaseline` happen before private backup or service changes. Persist the transaction phase so interruption is recoverable.

- [ ] Implement only fixed production actions. Resolve effective managed configuration and systemd drop-ins via Task 2 inspection. Refuse ambiguous unmanaged overrides rather than editing an arbitrary env file. Capture private 0600 copies of only affected config/drop-ins; public manifests contain safe identities and reference paths only.
- [ ] Rewrite only `PLATFORM_WEB_ROOT`, and only the image digest when a changed, attested image is required. Preserve other settings verbatim. For changed platform code, install a narrowly scoped WorkingDirectory drop-in pointing at candidate source; preserve existing ExecStart/environment files. Validate that its relative Node module paths and installed dependency references resolve before switching. Perform `daemon-reload` only if a drop-in changed.
- [ ] Acquire the deployment lock within the shared guarded operation. Revalidate current baseline, active image/volume admission and candidate hashes immediately before changing configuration. Restart only `osd-platform.service` once for a successful switch. Never restart unrelated system services or remove account/state stores.
- [ ] Verify /health and the running process's whitelisted source/Web/image identity. Through an authenticated gateway request, fetch index and referenced assets and compare their actual bytes to candidate hashes; health alone is insufficient. Keep authentication in memory/private temporary files, redact it from logs, and revoke temporary verification login when finished.
- [ ] For UI-only publication, do a relevant authenticated route/app-load smoke without model calls. For model/tool/permission/runtime/image changes, execute existing live OpenCode acceptance with one temporary conversation, record provider outcomes separately, preserve existing conversations/files, and remove only the created verification resources under the existing scoped authorization. Do not enable/probe Claude or disabled runtimes.
- [ ] Image checks compare actual runner/resource/binary identities and retain the existing attestation verifier. Require a supplied CI artifact when those inputs changed; do not build an image locally or reject an unchanged image merely because frontend HEAD differs.
- [ ] Expose `deploy`, `run`, and `rollback` commands. `deploy` performs no build/test rerun beyond identity checks and required online smoke. A changed baseline requires preparation again. `rollback --release` restores only tool-managed deployment selections and verifies the old health/assets; it does not restore tenant files or unrelated security settings.
- [ ] Run `pnpm release:test scripts/dev/web-release.test.mjs`. Expected: all transaction/recovery fixtures pass before a live trial. Live publication belongs to implementation acceptance after the complete plan is authorized; this documentation task does not perform it.
- [ ] Commit exact changed files: `feat: publish Web candidates with verified recovery`.

## Task 8: Add storage reporting, operator guidance and performance evidence

**Modify:** `scripts/dev/web-release-state.mjs`, `scripts/dev/web-release.mjs`, `scripts/dev/web-release.test.mjs`, `scripts/README.md`, `PROGRESS.md`.

- [ ] Add fixture tests for current/previous/source/Web/image references, in-progress candidate, unknown external path, and symlink escape. Assert that dry-run reporting calls no delete operation.
- [ ] Export `storageInventory(releases, references)`. It returns sorted entries containing `path`, `bytes`, `pinned`, `reasons`, and `eligible`; mark unknown/unmanaged paths pinned. Limit traversal to tool-owned release/cache directories and stream size computation.

```js
export function classifyStorage(entry, references) {
  const reasons = [];
  if (entry.status === "preparing") reasons.push("in-progress");
  if (references.has(entry.path)) reasons.push("referenced");
  if (!entry.managed) reasons.push("unmanaged");
  return { ...entry, pinned: reasons.length > 0, reasons, eligible: reasons.length === 0 };
}
```

Pin the current and previous successful release directories as well as resolved source/Web/cache paths. Do not implement a non-dry-run prune command in this phase. For preparation, compare available disk space with streamed source size, required output sizes and retained rollback footprint; fail with measured values if it cannot fit. Never evict rollback or user state automatically.

- [ ] Extend `scripts/README.md` with the six commands, source/production distinction, one-check/one-bundle contract, browser prerequisite names, secret-free failure interpretation, fixed restart behavior and recovery command. Use existing documentation; add no additional Markdown guides.
- [ ] Run workflow/cache tests, selected browser acceptance and required full bootstrap verification sequentially via package scripts. Because the workflow itself changes build/configuration paths, use full affected suites for its first acceptance. Run lint and typecheck once; do not let the final bundle rerun the same validated check.
- [ ] Measure one known UI change and one login/session/API change. Record selected groups, total preparation/deployment time, substage timings, memory-pressure interruptions and vendor cache hits. Compare equivalent validation coverage with the historical workflow; do not label skipped tests as a performance improvement with unchanged coverage. Record measured totals rather than claiming an unmeasured target duration.
- [ ] Verify standalone `pnpm build` still includes typecheck and ACP, standalone `pnpm web:build` still typechecks, and required candidate acceptance runs at both widths. Verify original tenant/session/file state before and after any authorized live trial.
- [ ] Append one newest-first milestone line to `PROGRESS.md` with local date/time and verified results or blocker. Preserve unrelated existing progress edits and stage only the milestone hunk if committing that file.
- [ ] Commit exact changed files: `docs: document measured Web release workflow`.

## Completion evidence and coverage

| Spec requirement | Implementation tasks | Required evidence |
| --- | --- | --- |
| R1 explicit/resumable command | 1, 6, 7 | CLI parsing, interrupted-stage resume, no silent source selection |
| R2 content/baseline identity | 0, 1, 2, 7 | Dirty/untracked snapshot, real production baseline, stale-baseline refusal |
| R3 conservative selection | 3, 6 | Known groups, callers, unknown/config/full fallbacks |
| R4 one check / separate Web build | 4, 6 | Invocation counts; standalone desktop compatibility |
| R5 complete vendor cache | 5 | Warm hit; corruption/CSS/worker invalidation; refresh failure |
| R6 limits/serialization | 1, 2, 4, 7 | Same common lock and verified cgroup; failed work preserves live assets |
| R7 candidate/live acceptance | 6, 7 | Exact candidate at both widths; required tests cannot silently skip |
| R8 publication/recovery | 7 | Served hashes, fixed source, previous baseline, failed transaction recovery |
| R9 separate image identity | 3, 7 | Unchanged-image reuse and changed-input attestation checks |
| R10 timings/truthful records | 1, 6, 8 | Monotonic complete stage records; safe failure output |
| R11 storage dry-run | 2, 8 | Referenced versions pinned; no deletion |
| R12 compatibility/scope | 0, 4, 8 | Production-compatible base and preserved portable build behavior |

Self-review: every specification requirement maps to tasks and failure-oriented evidence. Source freezing, dependency identity, guard inheritance, cache outputs, build/check counts, fixture browser lifecycle, effective configuration precedence, stale publication and rollback failures are explicitly covered. No dependency install, higher memory limit, parallel heavy job, new resident service, automatic cleanup, push/merge, or Claude live gate is included.

Implementation has not begun. Recommended execution is sequential inline work using `superpowers:executing-plans`, with a checkpoint after candidate preparation and before the first live publication. Report concrete prepared artifacts at that checkpoint; reuse existing user authorization for project-service restarts and do not add repetitive confirmation prompts.
