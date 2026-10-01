# SciKeel Web Development and Deployment

This guide covers the multi-user gateway Web client: the React UI, the Node.js
platform service, and one headless `osd` worker per user.
See [AGENTS.md](../AGENTS.md) for project conventions
and the [platform RFC](rfc/internal-multi-user-platform.md) for implementation context.

The project is **SciKeel**, and the selected public repository is
`J0nhyer/scikeel`. This project retains the upstream MIT license and attribution;
some inherited UI labels
still use the original name.

## Publish the repository

For the initial publication, create an **empty public repository** under `J0nhyer`,
without generating a README,
license, or `.gitignore`: those files already exist locally. Keep the Git history,
[MIT license](../LICENSE), and third-party notices when publishing this derivative
of [ai4s-research/open-science](https://github.com/ai4s-research/open-science).

Authenticate using the [GitHub CLI browser flow](https://cli.github.com/manual/gh_auth_login).
Check that the authenticated account is `J0nhyer` before creating or pushing.
The `workflow` scope permits pushing the inherited GitHub Actions files:

```bash
gh auth login --hostname github.com --git-protocol https --web --scopes workflow
gh api user --jq .login
gh auth setup-git
```

Before the first public push, review the intended changes, untracked files, and
unpublished commit history for credentials or private deployment data. `.gitignore`
does not remove files that were previously committed. Never add `.deploy/`, `.env*`,
provider credentials, worker state, user workspaces, or session data to Git.

Run these commands in the project checkout after committing the reviewed changes.
The remote rename assumes `origin` still refers to the original upstream repository:

```bash
gh repo create J0nhyer/scikeel --public
git remote rename origin upstream
git remote add origin https://github.com/J0nhyer/scikeel.git
git push origin HEAD:main
gh repo edit J0nhyer/scikeel --default-branch main
git remote -v
```

This publishes the current committed branch as `main` without renaming the local
branch. Subsequent development should use feature branches and pull requests.
The inherited release workflow runs on `v*` tags and manual requests; pushing a
release tag is a separate action and does not deploy the Web service.

After the repository exists, continue with feature branches and pull requests;
do not rerun its initial creation commands.

Invite trusted developers through **Settings > Collaborators > Add people**.
Other contributors can fork the public repository and open pull requests. Use
Issues to describe work, and have another contributor review changes before
merging. Publishing the code does not deploy it or expose the server's local data.
See GitHub's [collaborator instructions](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/repository-access-and-collaboration/inviting-collaborators-to-a-personal-repository).

## Components and prerequisites

The request path is:

```text
Browser -> HTTPS reverse proxy -> Node platform -> private user osd worker -> agent runtime
```

The platform handles login, admin-created accounts, session cookies, runtime
selection, and authenticated API/SSE proxying. It serves the current Web bundle
from `PLATFORM_WEB_ROOT`; workers do not need an embedded copy of the latest UI.

Install these prerequisites on the development or deployment machine:

- Node.js 20 or newer and pnpm **9.4.0** (pinned in `package.json`).
- Git, and a complete headless `osd` distribution matching the host architecture.
- On a Linux server: systemd, persistent storage, and an HTTPS reverse proxy.
- On a native Windows server: a matching Windows x64 runtime archive, persistent
  storage, and an operator-configured supervisor and HTTPS reverse proxy.
- For builds on Linux hosts with less than 5 GiB RAM: unified cgroup v2, `flock`,
  and a working systemd user manager with memory/swap controller delegation.

A complete `osd` distribution contains `osd`, `opencode`, `uv`, `agent-browser`,
and `resources/` together. Use a verified release archive or an archive produced
by `scripts/release/package-osd.sh` on a build machine with sufficient resources.
The existing Linux installation uses an upstream **0.5.2** archive, and the worker
manager contains compatibility paths for it. That Linux result does not verify
native Windows deployment. Upstream release assets are available from
[the upstream releases page](https://github.com/ai4s-research/open-science/releases).
Do not assume that a new personal repository already has binary releases.

Extract the archive, for example, into `/opt/osd/runtime/`, preserving its layout.
Check `/opt/osd/runtime/osd --version`. Fetching only OpenCode is insufficient:
the platform starts `osd`, which starts the bundled runtime. Rust and Tauri system
libraries are unnecessary when deploying with an existing headless archive.

## Local Web setup on Linux/macOS

For native Windows, use the PowerShell procedure below. Clone the personal
repository:

```bash
git clone https://github.com/J0nhyer/scikeel.git scikeel
cd scikeel
pnpm install --frozen-lockfile
pnpm build
```

All commands in this guide run from the repository root unless explicitly stated.
`pnpm build` builds the Web bundle, ACP server, and heavy Web vendor libraries.
Use package scripts for checks, sequentially:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm platform:test
```

On small Linux hosts, the frontend scripts serialize heavy tasks and enforce
cgroup limits: 1850 MiB memory high, 2200 MiB memory maximum, and 256 MiB swap.
A missing guard causes the task to fail. Check guard availability with:

```bash
node scripts/dev/safe-desktop-task.mjs probe
```

Do not invoke Vite, Vitest, Cargo, or parallel heavy jobs directly on a small
production host. Resolve guard setup or reduce the build footprint when a task
fails; keep the limits and the system's memory reserve. The guarded small-host
build stages its output and preserves the previous bundle if the build fails.
On larger hosts, build in a separate checkout when an existing bundle is live.

Create a local configuration file that Git ignores:

```bash
mkdir -p .deploy
chmod 700 .deploy
${EDITOR:-vi} .deploy/platform.env
```

Use this template. Replace the password and every path with values for your machine;
paths must be absolute. The sample checkout is `/opt/open-science-desktop`:

```sh
PLATFORM_HOST=127.0.0.1
PLATFORM_PORT=4790
PLATFORM_DATA_DIR=/opt/open-science-desktop/.deploy/platform-data
PLATFORM_WEB_ROOT=/opt/open-science-desktop/apps/desktop/dist
PLATFORM_ADMIN_USERNAME=admin
PLATFORM_ADMIN_PASSWORD='REPLACE_WITH_A_UNIQUE_PASSWORD'
PLATFORM_SECURE_COOKIES=false
OSD_BIN=/opt/osd/runtime/osd
OSD_RESOURCES=/opt/osd/runtime/resources
OSD_STARTUP_TIMEOUT_MS=60000
OSD_STOP_TIMEOUT_MS=5000
PLATFORM_AGENT_TURN_TIMEOUT_MS=1200000
```

Set the numeric variables explicitly: the current entrypoint converts an omitted
numeric value to zero, including the port and timeouts. `PLATFORM_WEB_ROOT` must
also be explicit: `pnpm platform:start` runs with `services/platform` as its working
directory, so the entrypoint's relative Web-root fallback does not select the
repository's bundle.

The service reads process environment variables; it does not automatically load
`.env` files. Load the file in your shell before starting it:

```bash
chmod 600 .deploy/platform.env
set -a
. .deploy/platform.env
set +a
pnpm platform:start
```

In another terminal:

```bash
curl --fail http://127.0.0.1:4790/health
curl --head http://127.0.0.1:4790/
```

The health response is `{"ok":true,"service":"open-science-platform"}`. An anonymous
request to `/` redirects to `/login`. Open `http://127.0.0.1:4790/login` and sign in
with the bootstrap administrator. `pnpm dev` runs a standalone UI development
server; use the platform-served build for login and gateway integration checks.

The administrator is created only when the auth store has no users. Changing
`PLATFORM_ADMIN_PASSWORD` afterward does not reset an existing password. Remove
the bootstrap password from the environment file after initial setup and keep a
protected backup of the auth store.

## Windows access and hosting

A Windows user accessing an existing SciKeel instance only needs a browser and a
workbench account. Installing Node, `osd`, or a local agent is unnecessary for
that user. Hosting the service on a Windows machine is a separate setup.

The repository's build matrix includes `x86_64-pc-windows-msvc` headless archives,
and the worker manager passes per-user workspace and state directories to `osd`.
These are the foundations for native Windows hosting. The complete multi-user
platform, optional CLI integrations, reboot behavior, and process cleanup have
not been accepted on a Windows host in this work. The instructions below are a
manual setup procedure to validate, not a verified unattended installer.

### Native Windows startup

Install Node.js 20 or newer, pnpm 9.4.0, and Git. Extract a complete Windows x64
headless archive into `C:\SciKeel\runtime`, preserving `osd.exe`, `opencode.exe`,
`uv.exe`, `agent-browser.exe`, and `resources` together. Choose a local data directory
outside the checkout, and grant access only to the service account and operators.
The following example uses `C:\SciKeel\data`.

In PowerShell:

```powershell
git clone https://github.com/J0nhyer/scikeel.git C:\SciKeel\source
Set-Location C:\SciKeel\source
pnpm install --frozen-lockfile
pnpm build
& 'C:\SciKeel\runtime\osd.exe' --version
```

Set process environment variables using Windows paths; do not copy the POSIX
`.deploy/platform.env` shell-loading command. Set every numeric variable explicitly,
for the same entrypoint reason described in the local setup section:

```powershell
$env:PLATFORM_HOST = '127.0.0.1'
$env:PLATFORM_PORT = '4790'
$env:PLATFORM_DATA_DIR = 'C:\SciKeel\data'
$env:PLATFORM_WEB_ROOT = 'C:\SciKeel\source\apps\desktop\dist'
$env:PLATFORM_ADMIN_USERNAME = 'admin'
$env:PLATFORM_SECURE_COOKIES = 'false'
$env:OSD_BIN = 'C:\SciKeel\runtime\osd.exe'
$env:OSD_RESOURCES = 'C:\SciKeel\runtime\resources'
$env:OSD_STARTUP_TIMEOUT_MS = '60000'
$env:OSD_STOP_TIMEOUT_MS = '5000'
$env:PLATFORM_AGENT_TURN_TIMEOUT_MS = '1200000'
$bootstrapPassword = Read-Host 'Initial administrator password' -AsSecureString
$env:PLATFORM_ADMIN_PASSWORD = [System.Net.NetworkCredential]::new('', $bootstrapPassword).Password
pnpm platform:start
```

Enter a unique password at the prompt. The password still exists in the service's
process environment, so restrict the account and host accordingly. For ongoing
operation, remove the bootstrap password after the first account is created and
load provider credentials through a protected operator-managed configuration.
Secure the persistent directory with Windows ACLs; POSIX `chmod` does not apply.

In a second PowerShell window:

```powershell
Invoke-RestMethod http://127.0.0.1:4790/health
Start-Process http://127.0.0.1:4790/login
```

Sign in, create a second user, and run the account and real-turn acceptance checks
below. For public hosting, use an HTTPS reverse proxy, change
`PLATFORM_SECURE_COOKIES` to `true`, and keep platform/worker ports private.

### Unattended operation

A first-time operator must still install prerequisites, provide credentials,
choose storage paths, and configure startup and HTTPS. There is no shipped
one-click setup or automatic update mechanism. After that setup, Windows Task
Scheduler can launch the service at boot, or an operator can use a service wrapper;
see [Microsoft's startup trigger reference](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/new-scheduledtasktrigger).
A plain `node.exe` program is not a Windows Service executable by itself; service
registration needs a wrapper implementing the
[Windows service entry point](https://learn.microsoft.com/en-us/windows/win32/services/service-entry-point).

A background deployment must load its environment in the noninteractive account,
use explicit executable and working-directory paths, retain logs, restart on
failure, and correctly stop the complete worker/agent process tree. Configure
logon-independent execution and verify it after a reboot. Current Node spawns do
not set `windowsHide`, and the optional CLI launcher does not handle `.cmd` shims;
use actual supported executables and validate those CLIs individually before
enabling them. See [Node's Windows subprocess documentation](https://nodejs.org/api/child_process.html).
Hiding a launcher window alone does not verify process lifetime or cleanup.

WSL is another route: install Linux prerequisites and the Linux headless archive
inside WSL, then follow the Linux service guide.
[Systemd-enabled WSL](https://learn.microsoft.com/en-us/windows/wsl/systemd) can
manage the platform, but WSL distribution startup and Windows-to-WSL networking
still need configuration. Do not assume enabling a Linux service guarantees that
Windows will start the distribution at boot.

## Provider and optional CLI configuration

OpenCode is every account's default runtime. Configure a supported provider key
in the service environment, such as `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`, before
starting the platform; workers inherit that environment. Provider access is
managed by the operator. Check the Web model picker and complete a real turn to
verify credentials, model availability, billing, and network access together.
Keep command execution and other sensitive actions in manual approval mode.

Claude Code and Codex are optional. To enable either one, install and authenticate
its CLI as the service user, configure its executable/profile paths below, restart
the platform, and enable the assistant from the administrator's Web controls.
The project does not install or authenticate those CLIs for you.

| Variable | Purpose |
| --- | --- |
| `PLATFORM_CLAUDE_BIN` | Claude CLI executable; defaults to `claude` on the service PATH. |
| `PLATFORM_CLAUDE_CONFIG_DIR` | Administrator-managed Claude profile; defaults to `~/.claude` for the service user. |
| `PLATFORM_CODEX_BIN` | Codex executable; defaults to `codex` on the service PATH. |
| `PLATFORM_CODEX_HOME` | Administrator-managed Codex profile; defaults to `~/.codex` for the service user. |
| `PLATFORM_CLAUDE_ARGS_JSON`, `PLATFORM_CODEX_ARGS_JSON` | Optional additional arguments, each a JSON array of strings. |
| `OSD_ARGS_JSON` | Optional additional `osd` arguments, a JSON array of strings. |

CLI credentials stay on the server. Each user selects from enabled assistants and
available models. These optional integrations are unnecessary for the initial
OpenCode deployment.

## Linux service and HTTPS

Use a dedicated OS account, for example `osd`, with access to the code, runtime
archive, and its own persistent data. Install Node at a stable absolute path and
ensure the service PATH includes any optional CLIs. The sample below assumes
`/usr/bin/node`; replace it if Node is installed elsewhere.

Place production environment settings in `/etc/osd/platform.env`, outside the
repository. Limit access to the operator, set `PLATFORM_DATA_DIR=/srv/osd/platform`,
and set `PLATFORM_SECURE_COOKIES=true` for HTTPS. The service user must be able to
write the data directory; systemd reads the environment file. Store provider keys
there or inject them through the operator's secret manager.

Install `/etc/systemd/system/osd-platform.service`:

```ini
[Unit]
Description=SciKeel Web platform
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=osd
Group=osd
WorkingDirectory=/opt/open-science-desktop
EnvironmentFile=/etc/osd/platform.env
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/node /opt/open-science-desktop/services/platform/src/main.mjs
Restart=on-failure
RestartSec=3
TimeoutStopSec=30
KillMode=control-group
UMask=0077

[Install]
WantedBy=multi-user.target
```

Do not run the platform as root. `KillMode=control-group` stops its worker and agent
processes with the service. See the [systemd service reference](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html).

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now osd-platform
sudo systemctl status osd-platform
sudo journalctl -u osd-platform -n 50 --no-pager
```

Use a dedicated hostname at the domain root. After configuring DNS and obtaining
a TLS certificate, route every path through the Node platform. For Nginx on the
same host, use this server configuration with your hostname and certificate paths:

```nginx
server {
    listen 80;
    server_name research.example.org;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name research.example.org;
    ssl_certificate /etc/letsencrypt/live/research.example.org/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/research.example.org/privkey.pem;
    client_max_body_size 32m;

    location / {
        proxy_pass http://127.0.0.1:4790;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 1200s;
    }
}
```

Unbuffered proxying lets SSE output reach the browser as it arrives; the read
timeout accommodates long-running turns. See the [Nginx proxy reference](https://nginx.org/en/docs/http/ngx_http_proxy_module.html).
Run `sudo nginx -t` before reloading Nginx. If Nginx runs in a container, its loopback
address is inside that container: configure host networking or a private route to
the platform instead of copying `127.0.0.1` unchanged. Keep the platform and dynamic
worker ports off the public network. Route assets through the platform as well,
so direct static hosting cannot bypass the login and Web bootstrap behavior.

The current worker manager separates state, workspace paths, ports, and tokens,
but workers share one OS service identity. It does not provide container/VM
isolation, per-user resource quotas, or login rate limiting. Restrict account
creation to trusted collaborators. Running arbitrary users' agent commands needs
additional isolation and abuse controls before opening access more broadly.

## Accounts and acceptance checks

Accounts are created by an administrator; public self-registration is not
implemented. Sign in as admin, then run this in that site's browser developer
console with a unique password, using a development account first:

```js
const response = await fetch("/api/admin/users", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    username: "researcher",
    password: "REPLACE_WITH_A_UNIQUE_PASSWORD",
    role: "user",
  }),
});
console.log(response.status); // 201 on creation
```

Share the login password privately. GitHub collaborator membership grants source
access and is separate from a workbench account. Test with two browser profiles:

1. Anonymous requests reach login; the HTTPS session cookie is `Secure` and `HttpOnly`.
2. The admin can create accounts; a normal user cannot call admin APIs.
3. Both users can open a workspace and send a real OpenCode turn; approvals remain visible.
4. One user's files and sessions are absent from the other user's UI and APIs.
5. Streaming updates arrive promptly, and preview/download work at desktop and phone widths.
6. Signing out clears access; the service restarts without losing stored files or accounts.

`/health` only checks the control plane. It does not verify worker startup, provider
credentials, or model responses. Automated browser acceptance in
`apps/desktop/src/test/webWorkspace.acceptance.test.mjs` is opt-in and requires a
browser installation plus private test credentials; ordinary tests skip it.

## Update, rollback, and backup

Record the deployed commit, Node/pnpm versions, headless archive version, and
environment configuration before updating. GitHub merges do not automatically
deploy; the inherited workflows package releases on version tags or manual
requests and do not provide Web pull-request checks or a Web deployment pipeline.

Build and run the checks in a separate checkout/release directory. Keep production
`PLATFORM_DATA_DIR` outside that checkout. After a successful build, update the
service's code path and `PLATFORM_WEB_ROOT` together, restart the service, and run
the acceptance checks. If checks fail, restore both previous paths and restart.
Use an SSH tunnel or loopback for staging; never publish a second unprotected port.

For small-host frontend-only updates, the guarded build also saves the previous
bundle under `.deploy/web-before-<timestamp>-<pid>`. Keep that backup until the new
release passes acceptance. Do not delete a live bundle before its replacement is
built. Code rollback does not undo data format migrations; retain a compatible
data backup when upgrading the backend.

Stop the service for a consistent backup of the entire `PLATFORM_DATA_DIR`, including
`auth.json`, `workers/`, and `cli-runtime/`. Back up the production environment file
and record which runtime archive was used. Protect backups as secrets: worker
registries and runtime data can contain access tokens, credentials, and research
data. Store them outside the public Git repository. Restore a backup in an isolated
instance and verify login, workspace files, and session history before relying on it.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Guarded build refuses to start | cgroup v2, `flock`, systemd user manager/controller delegation, and competing heavy tasks. |
| Login works but the UI is missing | Absolute `PLATFORM_WEB_ROOT`, a successful `pnpm build`, and readable `index.html`/`assets`. |
| Worker fails on the first request | Executable `OSD_BIN`, complete adjacent sidecars/resources, writable data directory, explicit startup timeout, and service logs. |
| Health works but chat fails | Provider credentials, model availability, approvals, network access, and worker logs. |
| HTTPS login loops | `PLATFORM_SECURE_COOKIES=true`, browser origin, and routing all paths to the same platform. |
| Streaming arrives in batches | Reverse-proxy buffering/cache settings and idle read timeout. |
| Windows background task works only in a terminal | Task account environment, working directory, executable paths, protected configuration, and startup logs. |
| Windows CLI fails to spawn | Actual executable versus `.cmd` shim, absolute executable path, and supported Windows installation. |
| Changing the bootstrap password has no effect | Bootstrap only creates the first administrator; use the existing account management API for password changes. |
