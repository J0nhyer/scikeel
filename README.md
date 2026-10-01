# SciKeel

**An AI research workbench in your browser.**

SciKeel brings research conversations, literature, code, data, figures, and reports
into one Web workspace. Deploy it on your own server, create accounts for your
team, and work from a computer or phone. Choose OpenCode or administrator-enabled
Claude Code/Codex assistants without switching applications.

Source repository: **[J0nhyer/scikeel](https://github.com/J0nhyer/scikeel)**.
Source collaboration uses Issues, branches, and pull requests.

## What you can do

- **Work with research agents.** Explore a question, review literature, develop
  analysis code, generate figures, and draft a report in a continuous conversation.
  Streaming responses and tool activity keep the work visible.
- **Choose your assistant and model.** OpenCode is the default. Administrators can
  enable Claude Code and Codex using server-managed profiles. The Web composer
  exposes available models and supported reasoning settings.
- **Keep research files together.** Browse your server workspace, preview PDFs,
  images, tables, and documents, and download original files from the browser.
- **Continue a project.** Return to sessions and generated files, inspect the work
  behind a result, and use workflow starters for analysis and traceability review.
- **Use a computer or phone.** The gateway Web interface supports narrow viewports
  for conversations, file browsing, and research artifact previews.
- **Manage access.** Administrators create accounts and manage enabled assistants;
  each account gets its own workspace, worker state, and conversation history.

Multi-user access currently provides separate personal workspaces. Shared project
editing and simultaneous document collaboration are not implemented. Research
outputs still need human verification of calculations, citations, and conclusions.

## How it runs

```text
Browser -> HTTPS reverse proxy -> SciKeel platform -> user worker -> AI runtime
```

The React/TypeScript Web UI is served by a Node.js platform that manages sign-in,
accounts, runtime selection, and authenticated API/SSE proxying. A headless `osd`
worker starts on demand for each user, with independent workspace paths and state.
OpenCode, provider integrations, skills, and MCP connectors power the research work.

Workspace files and conversations are stored on the deployment host. Requests to
external model providers can include prompts, selected context, and tool results;
this is a self-hosted service, not an offline AI system. Provider and optional CLI
credentials are managed on the server and must stay out of the source repository.

## Get started

**Using an existing instance:** open its Web address, sign in with an account
created by the administrator, choose an available model, and start a conversation.
Windows, macOS, and Linux users access the same service through their browser.

**Hosting your own instance:** follow [the deployment guide](./docs/DEPLOYMENT.md).
It covers local startup, configuration, Linux services, Windows setup, HTTPS,
accounts, acceptance checks, updates, backups, and rollback.

To prepare a source checkout:

```bash
git clone https://github.com/J0nhyer/scikeel.git
cd scikeel
pnpm install --frozen-lockfile
pnpm build
```

You need Node.js 20 or newer, pnpm 9.4.0, Git, and a complete headless `osd`
distribution matching the server architecture. Building the Web UI alone does not
start the platform or provision a research runtime. Configure the absolute Web,
runtime, and persistent data paths described in the guide before running:

```bash
pnpm platform:start
```

The default host setting is loopback. For public access, put an HTTPS reverse proxy
in front of the platform and enable secure session cookies. Keep worker ports private.

## Deployment support

| Use case | Current status |
| --- | --- |
| Windows/macOS/Linux browser client | Uses the deployed Web interface; no local runtime installation required. |
| Linux server | Current verified deployment path: Node platform, headless workers, systemd, and reverse proxy. |
| Native Windows server | Windows runtime build target exists; manual startup instructions are provided. Full multi-user deployment has not been accepted on Windows. |
| Windows unattended installation | No bundled one-click installer, service registration, or automatic update flow yet. |
| WSL deployment | Can use Linux components with systemd-enabled WSL; Windows startup/networking still require configuration and acceptance. |

## Development and collaboration

Project code and documentation are written in English. Follow
[AGENTS.md](./AGENTS.md), keep changes small, and include phone-width behavior in
Web UI reviews.

1. Describe the problem and acceptance criteria in an Issue.
2. Create a feature branch. Invited collaborators can push branches; other
   contributors can fork the public repository and open a pull request.
3. Run the checks relevant to your change through the package scripts below.
4. Open a PR describing the behavior change, validation, and deployment steps.
   Have another contributor review it before merging.

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm platform:test
pnpm build
```

Run heavy checks sequentially. On small Linux hosts, the frontend package scripts
apply cgroup memory/swap limits and protect the existing bundle when a build fails.
Use these scripts for builds and tests; see the deployment guide for host setup.

Merging a PR does not deploy the Web service. Web PR automation and automatic Web
deployment are not configured yet. Keep deployment data, credentials, and private
research files out of commits and Issue/PR attachments.

## Repository layout

| Path | Purpose |
| --- | --- |
| `apps/desktop/src/` | Shared React Web interface and gateway browser behavior. |
| `services/platform/` | Node platform: authentication, accounts, runtime management, and proxying. |
| `packages/sdk/` | API client wrapper used by the UI. |
| `packages/shared/` | Shared types and domain models. |
| `crates/osd-core/`, `crates/osd-cli/` | Headless research server and command-line tools. |
| `runtime/` | Agent profiles, skills, plugins, tools, and MCP integration. |
| `examples/` | Example research workspaces. |
| `scripts/` | Build, resource preparation, and release tooling. |
| `docs/DEPLOYMENT.md` | Current Web deployment and collaboration guide. |
| `PROGRESS.md` | Verified milestones and blockers. |

## Operating limits

Accounts are administrator-created; public self-registration is not implemented.
Users have separate application state, but workers share an OS service identity:
there is no container/VM boundary, per-user resource quota, or login rate limiter.
The current deployment is intended for trusted collaborators. Review configured
assistant permissions and use manual approval for sensitive OpenCode actions.

Phone and computer browsers work against server-side workspaces. Browser access
does not grant direct access to the user's local filesystem. Account membership in
the workbench is separate from GitHub collaborator membership.

## License and attribution

SciKeel derives from [Open Science Desktop](https://github.com/ai4s-research/open-science)
under the [MIT license](./LICENSE); the inherited desktop code is retained.
Third-party resources keep their own licenses. Historical design documents,
translated upstream READMEs, and [CITATION.cff](./CITATION.cff) may describe the
upstream project; they do not identify a SciKeel release or research citation.
