# Internal Multi-User Research Platform

Status: **Implemented internal MVP — internal deployment active**

This document defines the smallest cloud-managed, internal-only product that can
reuse Open Science Desktop for university students without turning the current
single-user runtime into an incomplete multi-tenant core.

## 1. Product Boundary

The first release is a **single-organization, multi-user internal platform**:

- students open a browser and sign in;
- the platform creates and manages their cloud workspace;
- Open Science provides the research workspace, agent runtime, projects, files,
  sessions, and artifacts;
- OpenCode remains the default, private runtime for every account, including
  its existing conversations and model selection;
- administrators maintain the shared Claude Code and Codex installations and
  credentials and enabled model catalogs, while each account independently
  chooses a CLI and one of its enabled models;
- ordinary users cannot edit the shared Claude Code/Codex commands,
  credentials, or model catalogs;
- students do not install the desktop app, manage the server CLI credentials,
  or receive a worker gateway token as an account credential.

The first release does not promise public SaaS, cross-organization tenancy,
billing, enterprise SSO, or a complete audit system.

## 2. Verified Current Constraints

The current implementation is instance-scoped rather than user-scoped:

- `crates/osd-core/src/gateway.rs` authenticates requests with one persisted
  bearer token and one global read-only/full mode;
- session listing, project listing, file browsing, run history, and OpenCode
  proxying operate over the instance workspace;
- `crates/osd-core/src/project.rs` stores project ownership in filesystem
  metadata, with no user or membership field;
- `apps/desktop/src/lib/webMode.ts` stores the gateway token in browser
  `localStorage` and uses the token as the web client's identity;
- `osd server` already accepts `--state-dir` and `--workspace`, which can form
  independent worker instances when each worker receives its own directories;
- provider credentials and OpenCode auth are instance-local and must be
  provisioned deliberately for a headless worker.

Therefore, adding a login screen in front of the current shared gateway would
not provide isolation. The platform must either filter every gateway/runtime
surface by user or route each user to an independently scoped worker.

## 3. Decision

Use a **control plane plus isolated Open Science workers** for the internal MVP.

```text
Browser
  -> HTTPS reverse proxy
  -> platform control plane (login, users, per-user runtime routing)
     -> one private Open Science worker per user -> OpenCode
     -> per-user CLI facade -> administrator-managed Claude Code or Codex
```

The control plane owns identity and lifecycle. The worker remains a mostly
single-user Open Science instance. A worker is started with a unique state root,
workspace root, loopback port, and gateway token, for example:

```text
/srv/osd/instances/<instance-id>/state
/srv/osd/instances/<instance-id>/workspace
```

The browser may receive a short-lived worker bootstrap capability in the first
MVP, but the platform must never expose the administrator's provider keys or
the global server token.

### Why this route

It reuses existing `osd server --state-dir --workspace` behavior and avoids a
large, high-risk rewrite of every `/v1` route and every OpenCode proxy path.
The alternative — one shared worker with user-aware filtering — uses fewer
processes but requires a complete ownership model for sessions, directories,
files, events, permissions, projects, runs, and direct OpenCode paths before it
can be trusted.

## 4. Internal MVP Scope

### Required

1. Invite or account-based sign-in.
2. One private workspace per user.
3. Worker creation, start, stop, restart, and idle cleanup.
4. Existing Open Science web UI available after sign-in.
5. Existing per-user OpenCode model selection, plus centrally maintained
   Claude Code and Codex installations/configuration.
6. Basic per-user concurrency and storage limits.
7. A small administrator view for users, workers, failures, and reset/delete.
8. Basic operational logs sufficient to diagnose a failed task or worker.

### Deferred

- team project sharing;
- school-wide SSO;
- granular roles and permissions;
- billing and quotas by money;
- detailed provenance/audit dashboards;
- multi-region deployment and high availability;
- object storage migration;
- public self-registration.

### Safety that remains mandatory

Internal use permits simpler policy, but not shared host access:

- authentication must remain enabled;
- user workspaces must not overlap;
- provider credentials stay server-side;
- workers bind to loopback behind the platform proxy;
- resource limits and task cancellation are required;
- automatic approval is acceptable only inside a disposable/containerized worker
  or a workspace-only sandbox, not as unrestricted host execution.

## 5. Control-Plane Model

The first control-plane store only needs lifecycle and ownership metadata:

- `users`: id, login identifier, password hash or external subject, status,
  created time;
- `worker_instances`: id, user/team owner, state directory, workspace directory,
  port, gateway token reference, status, last activity, failure message;
- `sessions`: optional platform-level mapping from OpenCode session id to worker
  instance, for routing and cleanup;
- `settings`: per-user runtime selection and administrator-managed CLI policy.

Open Science project metadata and research artifacts remain inside the worker's
workspace for the MVP. The control plane should not duplicate the artifact model
until sharing and search require it.

## 6. Execution Stages

### Stage 0 — Architecture checkpoint

- Land this document and record the decisions required from the product owner.
- Confirm deployment assumptions and the first acceptance scenario.

### Stage 1 — Worker contract

- Add a small worker manager abstraction outside the existing gateway routes.
- Provision unique state/workspace directories.
- Start `osd server` on a loopback port with a generated worker token.
- Health-check `/v1/health` and cleanly stop/restart the complete process group.
- Test two workers concurrently and prove their projects/files/sessions do not
  overlap.

### Stage 2 — Platform authentication and routing

- Add the smallest supported account flow (recommended: administrator-created
  invite plus password).
- Store password hashes, not passwords.
- Resolve the authenticated user to one worker instance.
- Proxy browser/API traffic only to that worker.
- Replace the current shared-token entry path with a worker-scoped bootstrap;
  keep the worker token internal to the platform where practical.

### Stage 3 — Web product shell

- Add a login screen and a minimal account/workspace loading state.
- Reuse the existing Open Science SPA after the worker route is established.
- Make logout, expired sessions, worker startup, worker failure, and retry clear.
- Hide desktop-only controls that cannot work in cloud web mode.

### Stage 4 — Internal operations

- Add admin-only user/worker list and reset controls.
- Add per-user concurrent-run and storage limits.
- Add idle worker shutdown and restart-on-next-request.
- Add basic usage and failure records; do not build a full audit product yet.

### Stage 5 — Research workflow polish

- Configure the paper-search and analysis skills on the worker image/profile.
- Add default research project templates for students.
- Validate paper download, analysis, artifact preview, and report export from a
  phone-width browser as well as desktop.

## 7. Acceptance Tests for the First Slice

The first implementation slice is complete only when all of these pass:

1. User A signs in and receives worker A; User B receives worker B.
2. A cannot list, read, or delete B's projects, sessions, files, or runs.
3. A and B can run turns concurrently without the other worker's events appearing
   in the browser.
4. Restarting worker A does not change worker B's state.
5. Stopping a worker kills its OpenCode child and leaves no orphan process.
6. A provider key is never returned by the control plane or browser API.
7. An expired/invalid platform session cannot reach a worker.
8. An administrator can disable a user and stop their worker.

## 8. Current Implementation Status

Implemented and verified in this repository:

- Stage 0 architecture and acceptance boundary;
- isolated per-user Worker Manager with separate state, workspace, port, and token;
- file-backed administrator/user accounts, password hashes, HttpOnly sessions, and disablement;
- authenticated Web routing with server-side Bearer/Basic/SSE credential rewriting;
- reuse of the existing Open Science Web SPA after login;
- real two-user integration against the deployed `osd 0.5.2` binary;
- administrator-managed native Claude Code/Codex CLI facade with per-user private
  runtime homes and copied server-side configuration;
- OpenCode as the default for every account, with independent per-user selection
  of OpenCode, Claude Code, or Codex and an enabled managed model through
  `/api/runtime`;
- administrator-only Claude Code/Codex model catalog and default-model controls,
  exposed in the Web settings UI without exposing credential fields;
- OpenCode conversations and model controls preserved for each user's isolated
  worker, while Claude Code/Codex credentials remain administrator-managed;
- Codex new-session and resumed second-turn execution verified end to end against
  the installed cloud-server CLI, including the required option ordering before
  the `resume` subcommand;
- Claude Code execution verified end to end through the installed cloud-server
  CLI with the currently available `openrouter/free` model; the previous
  `stealth/union-alpha` mapping is retired, and paid OpenRouter models remain
  unavailable until the administrator account has credits and regional access;
- non-zero CLI exits now remain visible as assistant errors even when the CLI
  emitted explanatory text before exiting;
- a real public OpenCode turn verified after the managed-runtime changes, with
  the administrator restored to OpenCode after all CLI checks;
- the rebuilt Web SPA served by the Node control plane, so the platform does not
  require rebuilding the Rust binary for this deployment;
- systemd supervision on port `4790` behind the existing Nginx container, with
  the public entry point routed through the authenticated control plane.

Still a separate stage:

- adding credits or replacing the OpenRouter account if paid Claude models are
  required; the verified free router may select different underlying models;
- quotas, idle shutdown, persistent worker reattachment, and a richer admin UI;
- HTTPS termination. The current internal deployment is HTTP-only and should not
  be treated as a public SaaS boundary.

## 9. Decisions Needed Before Stage 3

The following choices materially affect the implementation. Defaults are listed
so development can continue without designing a second time:

| Question | Recommended default | Why |
| --- | --- | --- |
| Initial login | Admin-created invite + password | No external identity integration for the MVP |
| Worker isolation | One process/container per user; lazy-start | Reuses current instance model and limits data leakage |
| Collaboration | No shared projects in Stage 1 | Avoids a second ownership model |
| Model credentials | Platform-managed provider/API credentials | Students should not configure or expose keys |
| Storage | Local persistent volume on the cloud server | Lowest implementation cost; object storage later |
| Deployment | One Linux host, existing reverse proxy, loopback workers | Matches the current server deployment |
| Agent runtime | OpenCode by default per user; Claude Code/Codex selectable per account from administrator-managed server profiles | Preserves the original OpenCode product while keeping shared CLI credentials server-side |
