# scripts

Repo tooling.

- `release/` — packaging and release scripts (Tauri build matrix, signing/notarization
  helpers, GitHub Release upload, `latest.json` generation).
- `dev/` — local development helpers (bootstrap, run the app, seed the demo workspace).

## Gateway Web updates

Use the checkout containing the changes:

```bash
pnpm web:release run --source /opt/open-science-desktop
```

The command runs the unit tests selected for changed frontend and platform
code, builds Web output when needed, publishes the result, restarts the platform
service, and checks `/health`. A failed test or unhealthy restart prevents a
successful publication; the previous service configuration is restored when
possible.

Review code before publication and run the unit tests for the affected behavior.
Routine Web publication does not run lint, type checks, Rust builds, Docker or
gVisor checks, image provenance or Git commit matching, browser workflows, or
live model calls. These requirements do not apply to a release that explicitly
changes native desktop packaging or scientific images.

Build and test jobs keep the existing host resource limits and lock. The release
command does not rebuild native agents or scientific images for Web changes.

Standalone `pnpm build` retains desktop typecheck and ACP packaging.
`pnpm web:build` checks types and stages a Web-only bundle. Vendor cache entries
include verified Monaco CSS and worker files; changes/corruption force a refresh.
