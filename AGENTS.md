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

An open-source, model-agnostic, reproducible AI research workbench served in the
browser. See `README.md`, `docs/PRD.md`, and `docs/TECHNICAL_DESIGN.md`.

Recommended stack: **React + TypeScript + Vite**, Tailwind + Radix UI,
**OpenCode** as the agent runtime (server-side; HTTP + SSE API), and the Rust
`osd` worker server with SQLite + JSONL provenance.

## Repository map

- `apps/web/` — the React Web interface and gateway browser behavior.
- `packages/` — `shared`, `sdk` (the `OpenCodeClient` wrapper).
- `crates/` — `osd-core`, `osd-cli`, `osd-sandbox-host`: the headless worker
  server and sandbox host.
- `runtime/` — `opencode-profile`, `skills`, the OpenCode guard plugins and
  custom tools, and the sandbox runtime.
- `services/platform/` — the multi-user gateway control plane.
- `docs/` — product and technical specs.
- `examples/bci-trends/` — the built-in demo project.
- `scripts/` — release and dev scripts.

## Architecture guardrails

- The UI never calls OpenCode directly — it goes through `packages/sdk`
  (`OpenCodeClient`). Pin the OpenCode version (see `OPENCODE_VERSION`).
- Keep the frontend, platform control plane, and worker runtime decoupled.
- Skills, MCP servers, and model providers must stay pluggable.
- Keep the artifact schema and workflow templates stable and versioned.
- The product is Web-only: every feature must work in the gateway Web client,
  including phone-width viewports. If a capability needs a host filesystem or a
  native dialog, it belongs on the server, not in the browser.

## Safety defaults (non-negotiable for the Web deployment)

- The agent may only access the current workspace.
- Command execution, file deletion, dependency install, and remote connections
  require approval (manual approval mode by default — never ship `off`).
- API keys stay in platform-managed secrets / the OS keychain; never in
  provenance, logs, crash reports, git, or exported projects.

## Working conventions

- Default working language for discussion is Chinese; **all project files and
  code are in English** (this is a pure-English project).
- The product is the public multi-user gateway Web client. Scope product
  design, implementation, deployment, and acceptance testing to Web.
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
