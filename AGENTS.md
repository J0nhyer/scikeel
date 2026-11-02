# SciKeel

Brand name: **SciKeel** — "A model-agnostic AI research workbench for reproducible,
collaborative science." Public repository target: `J0nhyer/scikeel`. Derived from
Open Science Desktop (formerly Open Science), retaining its MIT license and upstream
attribution. Inherited UI/desktop labels may still use the original name while
branding is migrated. Bundle identifier stays `com.ai4s.workbench` and internal
`@ai4s/*` package names are unchanged.

Project rules and working context for AI agents (Claude Code, Cursor, Codex, etc.).
`CLAUDE.md` is a symlink to this file — edit only `AGENTS.md`.

## Design principles

Keep it **simple, explicit, clear, complete**.

- **Simple** — no over-engineering; if not necessary, do not add entities.
- **Explicit** — no ambiguity; no bugs.
- **Clear** — understandable at a glance.
- **Complete** — cover the key points; prioritize safety.

## What this project is

An open-source, local-first, model-agnostic, reproducible AI research desktop
for macOS, Windows, and Linux. See `README.md`, `docs/PRD.md`, and
`docs/TECHNICAL_DESIGN.md`.

Recommended stack: **Tauri 2 + React + TypeScript + Vite**, Tailwind + Radix UI,
**OpenCode** as the agent runtime (bundled single-binary sidecar; HTTP + SSE API),
local workspace + SQLite + JSONL provenance.

## Repository map

- `apps/desktop/` — Tauri + React desktop shell (`src/` frontend, `src-tauri/` Rust).
- `packages/` — `ui`, `shared`, `sdk` (the `OpenCodeClient` wrapper).
- `runtime/` — `manager`, `opencode-profile`, `mcp`, `skills`, the OpenCode
  guard plugins and custom tools, and `computer/` (the computer-use host layer).
- `native/` — the per-platform computer-use providers (macOS Swift helper app,
  Linux AT-SPI script, Windows UI Automation script), ported from Orca (MIT).
  Staged into the bundle by `scripts/dev/build-computer-use.mjs`.
- `docs/` — product and technical specs.
- `examples/bci-trends/` — the built-in demo project.
- `scripts/` — release and dev scripts.

## Architecture guardrails

- The UI never calls OpenCode directly — it goes through `packages/sdk` (`OpenCodeClient`).
  Pin the OpenCode version (see `OPENCODE_VERSION`) and bundle it as a sidecar.
- Keep the frontend, desktop shell, and agent runtime decoupled.
- Skills, MCP servers, and model providers must stay pluggable.
- Keep the artifact schema and workflow templates stable and versioned.
- Every feature must work on Windows, macOS, and Linux, AND in the gateway web
  client — including phone-width viewports (the web client is used from
  phones). If a feature fundamentally cannot work over the web (local kernels,
  native dialogs, host filesystem access), hide it in web mode (`isGatewayWeb`)
  instead of shipping a control that fails.

## Safety defaults (non-negotiable for the desktop)

- The agent may only access the current workspace.
- Command execution, file deletion, dependency install, and remote connections
  require approval (manual approval mode by default — never ship `off`).
- API keys go to the OS keychain / credential manager; never into provenance,
  logs, crash reports, git, or exported projects.

## Working conventions

- Default working language for discussion is Chinese; **all project files and
  code are in English** (this is a pure-English project).
- Current product work targets the public multi-user gateway Web client only.
  Unless the user explicitly requests desktop work, scope product design,
  implementation, deployment, and acceptance testing to Web. Shared code must
  not intentionally break desktop builds, but desktop UX and feature parity are
  not current deliverables.
- Runtime availability (user-confirmed on 2026-10-02): Claude is currently
  unusable. Exclude Claude from live acceptance tests and release gates; do not
  probe alternative Claude models or endpoints unless the user explicitly
  confirms that Claude service has been restored. Preserve adapter compatibility
  and deterministic tests, but do not treat Claude unavailability as a feature
  defect or deployment blocker.
- Internal testing operations (user-confirmed on 2026-10-05): the user is the
  sole current user. Agents may stop or restart project-related services and
  processes as needed for deployment, testing, or troubleshooting without
  asking again, including active project workloads. Preserve workspace files,
  conversations, credentials, and recoverable state; this authorization does
  not permit deleting user data or stopping unrelated system services.
- One progress file: `PROGRESS.md`. Append one line per real milestone,
  `YYYY-MM-DD HH:MM` + a one-sentence conclusion, newest on top. Results and
  blockers only.
- Avoid adding new Markdown docs unless requested — too many docs become debt.
- Prefer minimal, verifiable changes; every step should produce a checkable result.
- Do not write inferences as verified facts; tie conclusions to code or data.
- New session workspaces are local git repos: the app initializes them and makes
  best-effort local commits after workspace file changes. Never set a remote or push.
- This cloud host has only 3.3 GiB RAM and previously suffered global OOM and
  loss of SSH responsiveness during an unbounded frontend build. Run all Web
  builds, tests, typechecks and lint through the package scripts, which use
  `scripts/dev/safe-desktop-task.mjs` to enforce per-task cgroup memory/swap
  limits and serialize heavy tasks on small Linux hosts. Never invoke Vite,
  Vitest, Cargo, or parallel heavy jobs directly on this host without an
  equivalent verified cgroup limit. A failed build must leave the deployed Web
  bundle untouched. If the bounded build runs out of memory, optimize its
  footprint; never remove the host guard or raise it into the system reserve.
- Stop or restart the live `osd-platform.service` only through the maintenance
  gate (`pnpm live:maintenance` or the release tooling). A raw `systemctl stop`
  bypasses the turn-aware wait/refuse; reserve it for an explicit emergency and
  expect the platform to mark any active turn interrupted.

## Proportionate Web releases (mandatory)

The 2026-10-21 login-performance work expanded into runtime and image changes.
The selected publication path consequently rebuilt Codex for about 78 minutes;
its 75-minute publication deadline expired, and a subsequent native capability
check failed on a subprocess temporary-directory configuration. The requested
login improvement remained unpublished. Treat end-to-end delivery time and
verification cost as design constraints from the beginning.

- Keep implementation within the requested user outcome. Do not add runtime,
  image, infrastructure, or release-system changes without code or measurement
  evidence that the outcome requires them. Before choosing a change, account for
  its build, deployment, and acceptance consequences. Explain an unavoidable
  expensive dependency before starting it.
- Use the shortest existing deployment path that correctly publishes the changed
  components. An authorized release does not require another planning cycle,
  new documents, a new publication framework, or repeated user confirmation.
- Build and publish the frontend for frontend changes; update the platform for
  platform changes. Reuse installed runtimes and images when their relevant
  source, dependencies, configuration, and compatibility remain unchanged and
  verified. Routine Web releases must not automatically rebuild native agents
  or scientific images.
- Changed runtime or image inputs require the corresponding build and safety
  checks. Never relabel those changes as frontend-only, disable isolation, or
  bypass a relevant release check to obtain a faster publication.
- Select tests from affected behavior, shared dependencies, and actual risk.
  Keep test-first regressions and code review. Run broader suites when their
  coverage is needed; do not repeatedly run the entire repository solely because
  a generic script selects everything. Reuse passing results only while their
  verified inputs remain unchanged.
- Before a costly stage, validate its prerequisites with inexpensive checks:
  arguments, dependencies, available resources, source and artifact identity,
  compatibility, and writable project-local temporary directories inherited by
  every subprocess. Publication deadlines must cover the selected bounded jobs
  and queue allowance.
- Follow long-running work through one task with bounded, low-frequency status
  checks. Inspect meaningful progress and failures. Do not busy-wait, repeat
  unchanged output, start duplicate builds, or consume model calls just to wait.
  A timeout requires diagnosis before another attempt; merely extending a
  deadline does not resolve a failed check.
- Preserve user data, existing published behavior, and the working deployment
  until the candidate is ready. After deployment, verify the served version,
  service health, and the affected user workflow against real services and
  data. For login changes, check login, workspace readiness, history access,
  and logout, and measure user-visible readiness time. Unit-test success or a
  health response alone cannot establish the requested login speed.
- Report implementation, verification, deployment, and live acceptance as
  separate states. Claim publication only after the intended version is served
  and the required live checks pass; state measured timings and remaining
  failures accurately. Finish verification once the acceptance criteria are
  satisfied instead of adding unrelated checks.
