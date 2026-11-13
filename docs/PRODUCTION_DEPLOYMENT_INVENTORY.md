# Production Deployment Artifact Inventory

Status: factual inventory. This document records where deployment-related
artifacts are located and what they contain. It does not contain
recommendations, procedures, or conclusions about what should be done.

Recorded on 2026-11-13. Repository branch: `main` at `1f6c217d`
(`docs(progress): record the runtime watchdog and analytics restore`).

## 1. Repository documents

| Path | Contents |
| --- | --- |
| `docs/DEPLOYMENT.md` | General Web deployment guide. Covers repository publication, prerequisites, local Linux/macOS setup, Windows setup, provider/CLI configuration, a systemd unit example (`osd-platform.service`), Nginx HTTPS example, accounts, acceptance checks, update/rollback/backup, troubleshooting. It states Node.js 20 or newer (line 76), uses `EnvironmentFile=/etc/osd/platform.env` in the systemd example (line 344), states that workers share one OS service identity (line 408), and contains a Windows example using `apps/desktop/dist` (line 234). |
| `docs/WEB_RELEASE_CHECKLIST.md` | Web release checklist. Covers first-turn browser acceptance, the 3.3 GiB host note, worker-image inputs, and publication. States that `runtime/skills/core/**`, `runtime/sandbox/**`, OpenCode/Codex patches, and image build scripts are worker-image inputs; names the attested CI image workflow; lists the two skill files expected in the image. |
| `docs/TECHNICAL_DESIGN.md` | Historical v0.1 desktop design (Tauri). The document header states the Tauri desktop shell was retired and the current product is Web-only. |
| `docs/PRD.md` | Product requirements. |
| `docs/REQUIREMENTS.md` | Requirements specification. |
| `docs/CONNECT_YOUR_TOOLS.md` | Tool connection notes. |
| `docs/rfc/internal-multi-user-platform.md` | Multi-user platform RFC. Describes the control plane plus per-user worker model, acceptance tests, implementation status, and current constraints. |
| `docs/rfc/remote-access-gateway.md` | Remote access gateway RFC. |
| `docs/rfc/agent-runtime.md` | Agent runtime RFC. |
| `docs/rfc/multi-agent-acp.md` | Multi-agent ACP RFC. |
| `docs/superpowers/specs/2026-10-06-web-update-workflow-design.md` | Web update workflow design. Contains the 2026-10-06 production baseline observations: 4 CPUs, 3,399 MiB RAM, 2,047 MiB swap, approximately 6.8 GiB free on the root filesystem; effective production `WorkingDirectory` at `/opt/open-science-desktop/.worktrees/tenant-science-isolation`; both `/etc/osd-platform.env` and `/etc/scikeel/platform-sandbox.env` exist; multiple release commands. |
| `docs/superpowers/specs/2026-11-05-docker-native-sandbox-design.md` | Docker native sandbox design. Contains the macOS local Docker stack description, cloud inventory fields, target architecture, data layout, memory budget for the 3.3 GiB host (section 10), Phase 2 cloud deployment cutover, acceptance criteria, risks, and decisions. States that the systemd-bound release/maintenance scripts require Compose adaptation in Phase 2 (section 7.6 and decisions 9-10). |
| `docs/superpowers/plans/` | Implementation plans referenced by the specs. |

## 2. Repository service units

The following units are in `services/platform/infra/`.

| Path | Contents |
| --- | --- |
| `services/platform/infra/scikeel-sandbox-host.service` | `scikeel-sandbox-host.service`: `Type=notify`, `ExecStart=/usr/local/lib/scikeel/osd-sandbox-host --config /etc/scikeel/sandbox-host.json`, `User=root`, `Group=root`, `RuntimeDirectory=scikeel`, `ReadWritePaths=/run/scikeel /run/netns /var/lib/scikeel/launcher`, `MemoryHigh=128M`, `MemoryMax=192M`, `MemorySwapMax=64M`, `TasksMax=32`, `CPUQuota=25%`, `KillMode=control-group`. Requires `scikeel-tenant-volume.service`. |
| `services/platform/infra/scikeel-tenant-volume.service` | `scikeel-tenant-volume.service`: `Type=oneshot`, `ExecStart=/usr/bin/python3 /usr/local/lib/scikeel/prepare-tenant-volume.py`, `ConditionPathExists=/var/lib/scikeel/tenant-quota.json`, `RemainAfterExit=yes`, root user/group, `UMask=0077`, `MemoryMax=96M`, `MemorySwapMax=32M`, `TasksMax=16`. |
| `services/platform/infra/scikeel-package-mirror.service` | `scikeel-package-mirror.service`: devpi-server, `User=scikeel-mirror`, `ExecStart=/usr/lib/scikeel/mirror/bin/devpi-server --serverdir /var/lib/scikeel/package-mirror/data --host 127.0.0.1 --port 3141`, `MemoryHigh=192M`, `MemoryMax=256M`, `MemorySwapMax=64M`, `TasksMax=64`, `CPUQuota=50%`, `ProtectSystem=strict`, `ReadWritePaths=/var/lib/scikeel/package-mirror`. Requires `scikeel-package-mirror-volume.service`. |
| `services/platform/infra/scikeel-package-mirror-volume.service` | `scikeel-package-mirror-volume.service`: mount `/var/lib/scikeel/package-mirror.img` at `/var/lib/scikeel/package-mirror` with `loop,prjquota,nodev,nosuid`. |

## 3. Host paths referenced by repository tooling and units

| Path | Referenced by | Contents / role |
| --- | --- | --- |
| `/etc/scikeel/platform-sandbox.env` | `scripts/dev/web-release-source.mjs:175` | The managed platform environment file. `inspectProduction` reads it as the last `EnvironmentFile=` of the effective `osd-platform.service`; `web-release-deploy.mjs` reads and rewrites `PLATFORM_DATA_DIR`, `PLATFORM_WEB_ROOT`, and `PLATFORM_SANDBOX_IMAGE_DIGEST` in it. |
| `/etc/osd/platform.env` | `docs/DEPLOYMENT.md:344` | Environment file used by the systemd example in the general deployment guide. |
| `/etc/osd-platform.env` | `docs/superpowers/specs/2026-10-06-web-update-workflow-design.md` | A second environment file recorded as existing on the production host; the same document states effective systemd configuration and the running process determine production state. |
| `/etc/scikeel/sandbox-host.json` | `services/platform/infra/scikeel-sandbox-host.service`, `docs/superpowers/specs/2026-11-05-docker-native-sandbox-design.md` | Configuration for `osd-sandbox-host`; contains instance/native roots, quota device, launcher state directory. |
| `/etc/systemd/system/osd-platform.service.d/zz-scikeel-web-release.conf` | `scripts/dev/web-release-deploy.mjs:16` | Managed release drop-in. `web-release-deploy.mjs` writes a `WorkingDirectory=` line prefixed with `# SciKeel managed Web release`. |
| `/var/lib/scikeel/images/<sha256-digest>/rootfs` | `scripts/dev/web-release.mjs:83`, `scripts/dev/stage-sandbox-image.mjs` | Installed scientific image rootfs. `validateInstalledImage` reads `image-manifest.json` and `ready.json` under the digest directory; the image is installed by `/usr/local/lib/scikeel/install-sandbox-image.py`. |
| `/var/lib/scikeel/tenant-quota.json` | `services/platform/infra/scikeel-tenant-volume.service` | Condition file for the tenant volume unit. |
| `/var/lib/scikeel/tenant-data.img` | `docs/superpowers/specs/2026-11-05-docker-native-sandbox-design.md` | Reserved quota-backed tenant backing file referenced in the design document. |
| `/var/lib/scikeel/package-mirror.img` | `services/platform/infra/scikeel-package-mirror-volume.service` | Reserved quota-backed package mirror backing file. |
| `/var/lib/scikeel/package-mirror` | `services/platform/infra/scikeel-package-mirror.service` | Mount point and devpi data root. |
| `/usr/local/lib/scikeel/osd-sandbox-host` | `services/platform/infra/scikeel-sandbox-host.service` | Sandbox host executable. |
| `/usr/local/lib/scikeel/install-sandbox-image.py` | `scripts/dev/stage-sandbox-image.mjs` | Root-owned image installer invoked with `sudo -n /usr/bin/python3 .../install-sandbox-image.py <artifactRoot>`. |
| `/usr/local/lib/scikeel/inspect-sandbox-archive.py` | `scripts/dev/stage-sandbox-image.mjs` | Archive inspection helper whose identity is checked before installation. |
| `/usr/local/lib/scikeel/prepare-tenant-volume.py` | `services/platform/infra/scikeel-tenant-volume.service` | Tenant volume preparation helper. |
| `/opt/open-science-desktop` | `docs/DEPLOYMENT.md`, `scripts/README.md`, `scripts/dev/live-maintenance.mjs` | Repository checkout path used in deployment examples. |
| `/opt/open-science-desktop/.worktrees/tenant-science-isolation` | `scripts/README.md:15-18`, `docs/superpowers/specs/2026-10-06-web-update-workflow-design.md` | Production-compatible checkout path used in release examples and recorded as the effective production `WorkingDirectory` on 2026-10-06. |
| `/opt/open-science-desktop/.deploy/platform-data` | `scripts/dev/live-maintenance.mjs` | Default data directory in `live-maintenance.mjs`. |
| `/opt/open-science-desktop/.deploy/web-releases/` | `scripts/dev/web-release.mjs`, `scripts/dev/web-release-state.mjs` | Release store. Contains candidate directories, `manifest.json`, and `current.json`. |
| `/opt/open-science-desktop/.deploy/web-publications/` | `scripts/README.md:74` | Durable unattended publication jobs. |
| `/opt/open-science-desktop/.deploy/publish-auth/credential.json` | `scripts/dev/web-publish.mjs:122` | Private GitHub credential file for unattended publication; alternative path is `SCIKEEL_GITHUB_CREDENTIAL_FILE`. |
| `/srv/osd/platform` | `scripts/dev/web-release-source.mjs:179` | Default `PLATFORM_DATA_DIR` fallback in `inspectProduction`. |
| `/srv/scikeel/data` | `scripts/dev/bootstrap-docker.mjs`, `.env.docker.example` | Container-side data root used by the local Docker stack examples. |

## 4. Release tooling

| Path | Contents |
| --- | --- |
| `scripts/dev/web-release.mjs` | `web:release` command implementation. Subcommands: `inspect`, `prepare`, `deploy`, `run`, `rollback`, `prune`, `resume`. Selects checks through `web-release-policy.mjs`, freezes source, validates the installed image, builds the Web bundle, stages browser acceptance, and records release manifests. `run` requires `--source`; deployment requires `--release`. `validateInstalledImage` reads `/var/lib/scikeel/images/<digest>/image-manifest.json` and `ready.json`. |
| `scripts/dev/web-release-source.mjs` | `inspectProduction` reads `systemctl show osd-platform.service -p WorkingDirectory -p MainPID`, `/proc/<pid>/environ` for `PLATFORM_WEB_ROOT`, `PLATFORM_DATA_DIR`, `PLATFORM_SANDBOX_IMAGE_DIGEST`, `PLATFORM_PORT`, `PLATFORM_HOST`; reads `/etc/scikeel/platform-sandbox.env` as the managed environment file; records source, dataDir, webRoot, imageDigest, entry hash, unit hash. |
| `scripts/dev/web-release-deploy.mjs` | Publication transaction. `dropIn` is `/etc/systemd/system/osd-platform.service.d/zz-scikeel-web-release.conf`. `switchConfiguration` rewrites `PLATFORM_DATA_DIR`, `PLATFORM_WEB_ROOT`, `PLATFORM_SANDBOX_IMAGE_DIGEST` in the managed env file; writes the drop-in when `deployPlatform` is selected; restarts through `live-maintenance.mjs`; `verifyProduction` re-inspects the running service, verifies delivery, and records the deployment. |
| `scripts/dev/web-release-policy.mjs` | Change-to-check selection. `imageInputPath` matches `runtime/sandbox/`, `runtime/skills/core/`, `runtime/opencode-patches/`, `runtime/codex-patches/`, `crates/`, their build scripts, and the image workflow. |
| `scripts/dev/web-release-state.mjs` | Release manifest read/write and storage inventory. Manifest schema is 1 with an `id`, `status`, and `stages`. |
| `scripts/dev/web-release-recovery.mjs` | Compatible-recovery reader handling. |
| `scripts/dev/web-release-maintenance.mjs` | Maintenance helper for releases. |
| `scripts/dev/web-publish.mjs` | Unattended publication. `publicationCITimeoutMs = (120 + 45 + 15) * 60 * 1000` (line 14). Stages: `snapshot`, `push`, `ci`, `artifact`, `install`, `deploy`. `install` runs `sudo -n systemctl stop osd-platform.service`, `pnpm sandbox:image:stage --manifest ... --install`, then `sudo -n systemctl start osd-platform.service` (lines 304-306). `deploy` runs `web:release run --source ... --image-digest ... --maintenance` (lines 75-77, 309). Requires `SCIKEEL_GITHUB_CREDENTIAL_FILE` or `.deploy/publish-auth/credential.json` with `token` and `owner: J0nhyer`. |
| `scripts/dev/live-maintenance.mjs` | Turn-aware maintenance gate. Default `dataDir` `/opt/open-science-desktop/.deploy/platform-data`, default lock dir `/opt/open-science-desktop/.deploy`, `FRESH_MS=30000`, runs `sudo -n systemctl stop|start osd-platform.service`, reads `live-state.json`, refuses when `activeTurns > 0` unless `LIVE_MAINTENANCE_INTERRUPT=1`, and refuses when live state is not fresh (`LIVE_STATE_UNKNOWN`). |
| `scripts/dev/stage-sandbox-image.mjs` | Image staging and installation. CLI is `--manifest PATH --dry-run|--install`. Verifies manifest schema, `imageDigest === sha256:rootfsSha256`, architecture `linux/amd64`, pinned tool versions, `gh attestation verify --repo J0nhyer/scikeel --bundle attestation.jsonl` for both manifest and rootfs, archive inventory, and disk space (`uncompressedBytes + 600 MiB`). `--install` invokes the root-owned installer. |
| `scripts/dev/probe-production-runner.mjs` | CI-only production runner probe. Imports `/opt/scikeel/tools/science-environment.mjs`, exercises `/files` read/write/save-with-revision/snapshot, generation and token rejection, workspace escape rejection, management alias rejection, profile restart, and gateway file inventory. Has a `--native-capabilities` mode that imports `/fixture/repo/services/platform/fixtures/native-protocol.mjs`. |
| `scripts/dev/safe-desktop-task.mjs` | Bounded task wrapper. Constants: `memoryHigh = 1850 * mib` (line 31), `memoryMax = 2200 * mib` (line 32), `swapMax = 256 * mib` (line 33). Uses `flock`, a shared task lock, and `systemd-run --user` with `MemoryHigh`, `MemoryMax`, `MemorySwapMax`; includes a `probe` mode. Live-verification tasks use 384M high / 512M max / 64M swap. |
| `scripts/dev/bootstrap-docker.mjs` | Local Docker stack bootstrap. Writes `.env.docker` values including `PLATFORM_SANDBOX_BACKEND=docker`, `SANDBOX_DOCKER_RUNTIME=runc`, `PLATFORM_DATA_DIR=/srv/scikeel/data`, and local worker limits (3 GiB memory, 4 GiB swap, 4 CPUs in the current source). |
| `scripts/dev/data-backup.mjs`, `scripts/dev/data-restore.mjs`, `scripts/dev/data-usage.mjs` | Data backup, restore, and usage helpers for the local data roots. |
| `scripts/release/package-osd.sh` | Builds a self-contained headless `osd` distribution: `osd`, `opencode`, `uv`, `agent-browser`, and `resources/`. The script states it must run after `pnpm build`. |
| `scripts/README.md` | Release CLI usage, browser path prerequisites (`OSD_PLAYWRIGHT_PATH`, `OSD_CHROMIUM_PATH`), image digest requirements, unattended publication commands, and publication behavior. |

## 5. CI workflow

| Path | Contents |
| --- | --- |
| `.github/workflows/sandbox-image.yml` | `sandbox-image` workflow. `push` triggers on branch `feat/tenant-science-isolation` for `runtime/opencode-patches/**`, `runtime/codex-patches/**`, `runtime/sandbox/**`, `crates/osd-cli/**`, `crates/osd-core/**`, related build scripts, and the workflow file. `workflow_dispatch` inputs: `native_feasibility_only`, `python_image` (default `python:3.12.12-slim-bookworm`), `uv_image` (default `ghcr.io/astral-sh/uv:0.11.26`). Jobs include `native-feasibility` (installs pinned gVisor `release-20260928.0`, runs Docker/gVisor native capability cases, uploads `native-gvisor-capabilities-<sha>`, `native-capabilities-<sha>`, `guarded-codex-<sha>`) and `science-probe-image` (builds `scikeel-science-probe:ci`, runs the production runner probe, exports `rootfs.tar.gz` and `image-manifest.json`, runs `actions/attest-build-provenance@v2`, uploads `science-v1-production-<sha>`). |
| `.github/workflows/web-checks.yml` | `web-checks` workflow, `workflow_dispatch` only; runs `pnpm platform:test` for two analytics test files. |
| `.github/workflows/package-mirror.yml` | `package-mirror` workflow, `push` on `feat/tenant-science-isolation` for the lock/workflow paths, plus `workflow_dispatch`; builds the public package mirror. |

## 6. Local Docker Compose stack

The following files define the macOS/local Docker stack.

| Path | Contents |
| --- | --- |
| `compose.yml` | Services: `caddy` (image `caddy:2.8-alpine`, publishes `127.0.0.1:${LOCAL_HTTP_PORT}:8080`), `platform` (image `scikeel-platform:local`, `user: ${PLATFORM_UID}:${PLATFORM_GID}`, front and control networks, mounts `apps/web/dist`, `.deploy/worker-image.json`, `secrets/model-brokers.json`, and `sandbox-run`), `sandbox-backend` (image `scikeel-sandbox-backend:local`, `user: 0:0`, mounts `/var/run/docker.sock`, data roots, and `sandbox-run`), `package-mirror` (image `scikeel-package-mirror:local`). Networks: `front` (fixed subnet) and `control` (internal). Volumes: `sandbox-run`, `package-mirror-data`. |
| `compose.dev.yml` | Development overlay that bind-mounts platform/backend source and the Web dist. |
| `Caddyfile` | `:8080 { reverse_proxy platform:4790 }`. |
| `.env.docker.example` | Local Compose variables: `LOCAL_HTTP_PORT=8080`, `PLATFORM_DATA_DIR=/srv/scikeel/data`, `PLATFORM_WEB_ROOT=/app/apps/web/dist`, `PLATFORM_SANDBOX_BACKEND=docker`, `SANDBOX_DOCKER_RUNTIME=runc`, `SANDBOX_WORKER_MEMORY=1073741824`, `SANDBOX_WORKER_SWAP=1207959552`, `SANDBOX_WORKER_PIDS=256`, `SANDBOX_WORKER_CPUS=1`, `PLATFORM_MAX_RESIDENTS=1`, `PLATFORM_CATALOG_MIGRATE=0`, `PLATFORM_SANDBOX_DISABLED_RUNTIMES=codex`. |
| `Dockerfile.platform` | `FROM node:22-slim`; installs `python3 make g++` and `pnpm@9.4.0`; copies platform, SDK, shared, sandbox runtime, skills, and fonts; `CMD ["node", "services/platform/src/main.mjs"]`. |
| `Dockerfile.sandbox-backend` | `FROM node:22-slim`; copies the sandbox backend and `tenant-layout.mjs`; `CMD ["node", "services/sandbox-backend/src/main.mjs"]`. |
| `Dockerfile.package-mirror` | Package mirror image. |

## 7. Configuration variables and their readers

| Variable group | Files that read or declare them |
| --- | --- |
| Core platform: `PLATFORM_HOST`, `PLATFORM_PORT`, `PLATFORM_DATA_DIR`, `PLATFORM_WEB_ROOT`, `PLATFORM_SECURE_COOKIES`, `PLATFORM_ADMIN_USERNAME`, `PLATFORM_ADMIN_PASSWORD`, `PLATFORM_AGENT_TURN_TIMEOUT_MS`, `PLATFORM_MAX_RESIDENTS`, `PLATFORM_CATALOG_MIGRATE`, `PLATFORM_AGENT_ANALYTICS` | `services/platform/src/main.mjs`, platform server modules, `compose.yml`, `.env.docker.example`, `docs/DEPLOYMENT.md`. |
| Sandbox: `PLATFORM_MANAGED_SANDBOX`, `PLATFORM_SANDBOX_BACKEND`, `PLATFORM_SANDBOX_SOCKET`, `PLATFORM_SANDBOX_IMAGE_DIGEST`, `PLATFORM_SANDBOX_IMAGES_DIR`, `PLATFORM_SANDBOX_INSTANCES_DIR`, `PLATFORM_SANDBOX_NATIVE_DIR`, `PLATFORM_SANDBOX_WORKER_IMAGE_MANIFEST`, `PLATFORM_SANDBOX_BROKER_HOST`, `PLATFORM_SANDBOX_DISABLED_RUNTIMES` | `services/platform/src/sandbox-manifest.mjs`, `compose.yml`, `.env.docker.example`, `scripts/dev/bootstrap-docker.mjs`, `scripts/dev/web-release-*`. |
| Sandbox backend: `SANDBOX_DATA_DIR`, `SANDBOX_DATA_HOST_DIR`, `SANDBOX_INSTANCES_DIR`, `SANDBOX_INSTANCES_HOST_DIR`, `SANDBOX_NATIVE_DIR`, `SANDBOX_NATIVE_HOST_DIR`, `SANDBOX_STATE_DIR`, `SANDBOX_STATE_HOST_DIR`, `SANDBOX_SOCKET`, `SANDBOX_DOCKER_SOCKET`, `SANDBOX_PLATFORM_CONTAINER`, `SANDBOX_BACKEND_CONTAINER`, `SANDBOX_WORKER_PLATFORM`, `SANDBOX_DOCKER_RUNTIME`, `SANDBOX_WORKER_UID`, `SANDBOX_WORKER_GID`, `SANDBOX_CONTROL_GID`, `SANDBOX_WORKER_MEMORY`, `SANDBOX_WORKER_SWAP`, `SANDBOX_WORKER_PIDS`, `SANDBOX_WORKER_CPUS`, `SANDBOX_HEALTH_TIMEOUT_MS`, `SANDBOX_STOP_TIMEOUT_SECONDS` | `services/sandbox-backend/src/main.mjs`, `compose.yml`, `.env.docker.example`, `scripts/dev/bootstrap-docker.mjs`. |
| Optional CLI: `PLATFORM_CLAUDE_BIN`, `PLATFORM_CLAUDE_CONFIG_DIR`, `PLATFORM_CODEX_BIN`, `PLATFORM_CODEX_HOME`, `PLATFORM_CLAUDE_ARGS_JSON`, `PLATFORM_CODEX_ARGS_JSON`, `OSD_ARGS_JSON` | `docs/DEPLOYMENT.md` table; platform CLI profile modules. |
| Release: `OSD_PLAYWRIGHT_PATH`, `OSD_CHROMIUM_PATH`, `SCIKEEL_GITHUB_CREDENTIAL_FILE`, `LIVE_MAINTENANCE_INTERRUPT` | `scripts/README.md`, `scripts/dev/web-release.mjs`, `scripts/dev/web-publish.mjs`, `scripts/dev/live-maintenance.mjs`. |
| Worker image pin: `OPENCODE_VERSION`, `UV_VERSION` | `scripts/dev/fetch-opencode.sh`, `scripts/dev/fetch-uv.sh`, `scripts/dev/stage-sandbox-image.mjs`. |

## 8. Runtime declarations

| Path | Contents |
| --- | --- |
| `package.json` | `packageManager: pnpm@9.4.0`; `engines.node: >=20`; scripts include `web:release`, `web:publish`, `web:build`, `live:maintenance`, `platform:start`, `build`, `test`, `platform:test`, `typecheck`, `lint`, `sandbox:*`, `release:*`. |
| `services/platform/package.json` | `engines.node: >=22.19.0` (line 13); dependencies include `better-sqlite3@12.9.0`, `undici@8.12.4`, `js-yaml@4.3.1`, `smol-toml@^1.9.0`. |
| `pnpm-workspace.yaml` | Workspace package layout. |
| `pnpm-lock.yaml` | Locked dependency graph. |

## 9. Local and production differences recorded in the repository

| Aspect | Local macOS stack | Production tooling/units in the repository |
| --- | --- | --- |
| CPU architecture | amd64 containers under an arm64 Docker kernel (Rosetta), per `docs/superpowers/specs/2026-11-05-docker-native-sandbox-design.md` section 5.1 and `PROGRESS.md` 2026-11-11 17:57. | `linux/amd64`; `stage-sandbox-image.mjs` requires `architecture === "linux/amd64"`. |
| Worker isolation | Docker backend (`PLATFORM_SANDBOX_BACKEND=docker`), `SANDBOX_DOCKER_RUNTIME=runc`; worker containers non-root, read-only rootfs, `CapDrop: ["ALL"]`, `SecurityOpt: ["no-new-privileges"]`, memory/swap/pids/cpu limits, per-user internal network (`services/sandbox-backend/src/lifecycle.mjs`). | `scikeel-sandbox-host.service` runs `osd-sandbox-host` as root with `runsc`; `docs/superpowers/specs/2026-11-05-docker-native-sandbox-design.md` section 8.2 states cloud may set `SANDBOX_DOCKER_RUNTIME=runsc` after registering gVisor. |
| Worker image | Local Docker image built by overlay; `PROGRESS.md` 2026-11-11 20:12 records `cf61421bdb22` as local-only/unattested. | CI `sandbox-image` artifact `science-v1-production-<sha>`; rootfs installed at `/var/lib/scikeel/images/<digest>/rootfs`; `gh attestation verify` in `stage-sandbox-image.mjs`. |
| Data paths | `.local/data` host paths; container paths under `/srv/scikeel/data`; `.env.docker` defines the pairs. | Live paths from `/etc/scikeel/sandbox-host.json` and `/etc/scikeel/platform-sandbox.env`; `web-release-source.mjs` records the effective paths from the running systemd process. |
| Stop/restart | `docker compose` container restart. | `live-maintenance.mjs` uses `sudo -n systemctl stop|start osd-platform.service`, `live-state.json`, and active-turn checks. |
| Release implementation | `pnpm build`, copy `apps/web/dist`, restart the platform container. | `web:release`/`web:publish`; systemd `MainPID`/`WorkingDirectory` inspection; drop-in `zz-scikeel-web-release.conf`; managed env `/etc/scikeel/platform-sandbox.env`; release store `.deploy/web-releases/`. |
| Web root | `apps/web/dist` bind-mounted into the platform container (`compose.yml`). | `PLATFORM_WEB_ROOT` from the running process; release candidates use `.deploy/web-releases/<id>/web`. |
| Node | Host Node version used for local scripts; platform container `node:22-slim`. | `services/platform/package.json` declares `>=22.19.0`; `docs/DEPLOYMENT.md:76` states Node.js 20 or newer. |
| Build guard | `safe-desktop-task.mjs` 1850M high / 2200M max / 256M swap. | The same guard and limits are referenced by `scripts/README.md` and `docs/WEB_RELEASE_CHECKLIST.md` for the 3.3 GiB host. |
| Memory budget | Docker Desktop VM, local worker values from `.env.docker` / `bootstrap-docker.mjs`. | `docs/superpowers/specs/2026-11-05-docker-native-sandbox-design.md` section 10: platform 640 MiB, sandbox-backend 128 MiB, Caddy 64 MiB, package-mirror 256 MiB, worker 1 GiB + 128 MiB swap, Docker ~150 MiB, reserve ~900 MiB; `PLATFORM_MAX_RESIDENTS=1`. |

## 10. Documented inconsistencies

The following pairs of statements exist in the repository.

| Topic | Statement A | Statement B |
| --- | --- | --- |
| Node version | `docs/DEPLOYMENT.md:76` states Node.js 20 or newer. | `services/platform/package.json:13` declares `node >=22.19.0`. |
| Web root on Windows | `docs/DEPLOYMENT.md:234` uses `apps/desktop/dist`. | The current repository path is `apps/web/dist`; commit `2deae094` renamed `apps/desktop` to `apps/web`. |
| Worker isolation | `docs/DEPLOYMENT.md:408` states workers share one OS service identity and there is no container/VM isolation. | `services/sandbox-backend/src/lifecycle.mjs` starts per-user containers with isolated networks and limits; `docs/superpowers/specs/2026-11-05-docker-native-sandbox-design.md` describes the Docker/gVisor isolation path. |
| Release/maintenance mechanism | `scripts/dev/web-release-*.mjs`, `scripts/dev/live-maintenance.mjs`, and `scripts/dev/web-publish.mjs` use `systemctl show/stop/start osd-platform.service` and `/etc/scikeel/platform-sandbox.env`. | `docs/superpowers/specs/2026-11-05-docker-native-sandbox-design.md` sections 7.6 and decisions 9-10 state the release scripts require Compose adaptation in Phase 2, which the document lists as a future phase. |
| Production topology | `docs/DEPLOYMENT.md` describes systemd plus a headless `osd` distribution and `EnvironmentFile=/etc/osd/platform.env`. | `services/platform/infra/` contains `scikeel-sandbox-host.service`, `scikeel-tenant-volume.service`, and `scikeel-package-mirror.service`; `web-release-source.mjs` expects `/etc/scikeel/platform-sandbox.env` as the last environment file. |
| CI image trigger | `.github/workflows/sandbox-image.yml` pushes trigger only on `feat/tenant-science-isolation` and a listed path set. | `docs/WEB_RELEASE_CHECKLIST.md` states a skills-only change must be dispatched with `workflow_dispatch`; `web-publish.mjs` pushes an isolated `ci/` branch and dispatches the workflow manually. |

## 11. Current repository and local-stack observations

| Item | Observation |
| --- | --- |
| `main` | `1f6c217d` (`docs(progress): record the runtime watchdog and analytics restore`). |
| `origin/main` | `1f6c217d`, verified through `gh api repos/J0nhyer/scikeel/git/ref/heads/main`. |
| Branch relative to the previous `main` tip | 25 commits ahead; previous `main` tip was `b0d00045` (2026-11-07 14:58). |
| Commit range | `b0d00045..1f6c217d`; includes `2deae094` (`chore(web): make the project Web-only`), `992c0e7b` (`feat(runtime): restart a wedged OpenCode sidecar in managed workers`), `085c5b69` (`fix(platform): collect agent analytics from every session directory`), `1185384d` (`feat(research): use Europe PMC and validate citation evidence`), `e160a9c7` (`feat(runtime): save PDFs and parse open-access full text`), `e19fccf8` (`fix(research): reject fake PDFs and prefer publisher OA PDFs`), `655c57ae` (PDF preview scrolling), and other commits listed in `git log b0d00045..1f6c217d`. |
| `imageInputPath` matches for this range | The range contains changes under `crates/`, `runtime/skills/core/`, and `runtime/sandbox/`, which `scripts/dev/web-release-policy.mjs` matches with `imageInputPath`. |
| Local served Web bundle | `apps/web/dist/index.html` built 2026-11-11 17:04; entry `assets/index-CyeV73RQ.js`. |
| Local containers (observed 2026-11-13) | `scikeel-platform` (`scikeel-platform:local`, created 2026-11-11T12:10:23Z), `scikeel-sandbox-backend` (`scikeel-sandbox-backend:local`), `scikeel-worker-user-usr_266aff73fb8a09b836dbc10d-g115` (image `cf61421bdb22`). |
| Local data | `/Users/chenyufeng/workspace/scikeel/.local/data`; platform bind mount `apps/web/dist`. |
| GitHub connectivity from the macOS host | `https://github.com` timed out; `https://api.github.com` returned HTTP 200. The remote `main` ref was updated to `1f6c217d` through the GitHub API. |
| `PROGRESS.md` entries cited | 2026-11-13 12:08 (analytics restore; analytics worker disables on 2 s RPC timeout/crash and has no `onError`); 2026-11-11 20:12 (watchdog deployed; image `cf61421bdb22` local-only/unattested); 2026-11-11 17:25 (Web-only cleanup); 2026-11-11 15:45 (fake PDF rejection; local-only image; production requires attested CI build); 2026-11-08 21:45 (collaboration budgets; local-only image; production requires attested CI build). |

## 12. File index

| Path | Kind |
| --- | --- |
| `AGENTS.md` | Project instructions (English). `CLAUDE.md` is a symlink to it. |
| `README.md`, `README.zh.md` | Product and deployment overview. |
| `PROGRESS.md` | Chronological verified-milestone and blocker log; newest entries at the top. |
| `docs/DEPLOYMENT.md` | General deployment guide. |
| `docs/WEB_RELEASE_CHECKLIST.md` | Web release checklist. |
| `docs/PRODUCTION_DEPLOYMENT_INVENTORY.md` | This inventory. |
| `docs/superpowers/specs/2026-11-05-docker-native-sandbox-design.md` | Docker sandbox design and Phase 2 notes. |
| `docs/superpowers/specs/2026-10-06-web-update-workflow-design.md` | Web update workflow design and 2026-10-06 production observations. |
| `compose.yml`, `compose.dev.yml`, `Caddyfile`, `.env.docker.example` | Local Docker stack. |
| `Dockerfile.platform`, `Dockerfile.sandbox-backend`, `Dockerfile.package-mirror` | Container images. |
| `services/platform/infra/*.service` | Production systemd units. |
| `scripts/README.md` | Release tooling usage and prerequisites. |
| `scripts/dev/web-release*.mjs` | Release selection, state, deployment, recovery, maintenance. |
| `scripts/dev/web-publish.mjs` | Unattended publication. |
| `scripts/dev/live-maintenance.mjs` | Turn-aware stop/start gate. |
| `scripts/dev/stage-sandbox-image.mjs` | Image verification and installation. |
| `scripts/dev/safe-desktop-task.mjs` | Cgroup-bounded task wrapper. |
| `scripts/dev/bootstrap-docker.mjs` | Local Docker stack bootstrap. |
| `scripts/release/package-osd.sh` | Headless `osd` packaging. |
| `.github/workflows/sandbox-image.yml` | CI scientific image build and attestation. |
