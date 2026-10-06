# scripts

Repo tooling.

- `release/` — packaging and release scripts (Tauri build matrix, signing/notarization
  helpers, GitHub Release upload, `latest.json` generation).
- `dev/` — local development helpers (bootstrap, run the app, seed the demo workspace).

## Gateway Web updates

Use an explicit production-compatible checkout. The main checkout's `dist` may
not be the gateway's effective Web root; inspection reads the running service.

```bash
pnpm web:release inspect --source /opt/open-science-desktop/.worktrees/tenant-science-isolation
pnpm web:release prepare --source /opt/open-science-desktop/.worktrees/tenant-science-isolation
pnpm web:release deploy --release RELEASE_ID
pnpm web:release run --source /opt/open-science-desktop/.worktrees/tenant-science-isolation
pnpm web:release rollback --release RELEASE_ID
pnpm web:release prune --dry-run
```

Preparation freezes tracked and non-ignored source, selects checks against the
last verified deployment, checks types once, reuses verified vendor artifacts,
and accepts the exact staged bundle at 1280px and 390px. Unknown baseline or
unregistered inputs widen coverage. `--full` widens it explicitly. `resume
--release RELEASE_ID` resumes only unpublished, unreferenced candidates with
matching input/output identities. Deployment does not rebuild.

All heavy stages retain the existing cgroup limits, memory-pressure interruption
and common host lock. Running research workers also hold that lock. A busy host
fails explicitly. On the current sole-user testing host, `prepare` or `run` with
`--maintenance` explicitly pauses project workloads, acquires the host lock,
restarts the platform to keep the current Web entry served, and performs bounded
verification. Workspace files, credentials and conversations are preserved;
research execution is unavailable during this window. No automatic workload
interruption occurs without this option.

Required browser paths are `OSD_PLAYWRIGHT_PATH` (an installed Playwright module)
and `OSD_CHROMIUM_PATH` (the installed Chromium executable). Set them in the
process environment or the local ignored `.deploy/web-release-settings.json`.
No package install or browser download is performed. Missing required browser
configuration fails acceptance rather than silently skipping it. Fixture
acceptance uses synthetic accounts; Claude is excluded from live release gates.

Standalone `pnpm build` retains desktop typecheck and ACP packaging.
`pnpm web:build` checks types and stages a Web-only bundle. Vendor cache entries
include verified Monaco CSS and worker files; changes/corruption force a refresh.

A publication restarts only the platform service when its source, Web root or
image selection changes. It verifies authenticated served asset hashes, process
identity and health, retains private recovery configuration, and restores the
previous selections on failure. It does not migrate/restore tenant data or
restart unrelated host services. Image input changes require an installed
CI-attested image supplied as `--image-digest sha256:DIGEST`; frontend revisions
reuse unchanged measured image inputs.

Release manifests under the shared `.deploy/web-releases/` record actual stage
times, selection reasons, cache hits, source/asset identities and recovery state.
A failed stage is not a passing release. If recovery is incomplete, retain both
candidates and inspect the recovery record before retrying. Dry-run storage
reporting pins referenced and unknown versions; it never deletes user data,
worktrees, current/rollback bundles, or cache entries.
