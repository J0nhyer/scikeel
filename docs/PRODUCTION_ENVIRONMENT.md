# SciKeel 正式环境说明（Production Environment Reference）

> 面向对象：需要理解或操作 SciKeel 正式环境的人/agent。
>
> 本文是**正式环境的现状快照**，只描述正式环境，不是安装手册；首次部署见
> [`docs/DEPLOYMENT.md`](./DEPLOYMENT.md)，项目规则见 [`AGENTS.md`](../AGENTS.md)。
>
> **最后核对：2026-11-05 14:30–14:40 CST（Asia/Shanghai）。**
> 正式环境会持续发布和变化；本文所有具体值都应在使用前用第 13 节的命令复核。
>
> **安全约定：**本文不包含任何密码、token、API key、auth hash 或用户数据。
> 不要把 `/etc/osd-platform.env`、`/etc/scikeel/platform-sandbox.env`、
> `/etc/scikeel/model-brokers.json`、`.deploy/platform-data/auth.json` 的原始内容
> 打印到对话、日志、文档或 Git。需要核对时只输出变量名或结构，不输出值。
>
> **发布注意：**本文包含内部路径、服务名、发布 ID 和运维拓扑。如果仓库是
> 公开的，提交前确认这些信息可以公开，或把本文放到私有运维仓库。
>
> **阅读顺序：**0–2 看拓扑；3–8 看服务、发布、数据、沙箱；9–11 看运行时、
> 资源/安全和 Git 状态；12 看操作边界；13 做只读复核。

---

## 0. 一分钟摘要

- **单台 Linux 云 VM**，不是 Kubernetes，也不是“整个平台跑在一个 Docker 容器里”。
- 操作系统：Ubuntu 22.04 LTS（jammy），x86_64，4 vCPU，3.3 GiB RAM，2 GiB swap，
  40 GB 磁盘（审计时约 26 GB 已用、12 GB 可用）。
- **唯一长期运行的 Docker 容器是 nginx**（`nginx:alpine`，host 网络，监听 80），
  反向代理到本机 `127.0.0.1:4790`。
- 平台后端是 **systemd + Node 24**：`osd-platform.service`，源码来自
  `.deploy/web-releases/<id>/source` 的冻结快照，而不是当前 git 工作树。
- 前端是静态 bundle，由平台从 `PLATFORM_WEB_ROOT` 提供。审计时 live web root
  与 live source 同属 reader release；发布机制也允许 Web 复用上一个 release，
  因此以有效 env 和 manifest 为准。
- 租户隔离是 **gVisor（runsc）+ 自定义 `osd-sandbox-host` + loop ext4 quota**，
  不是 Docker；需要 root、systemd、mount/overlay、network namespace、loop 设备。
- 所有运行时二进制和 sandbox rootfs 都是 **x86_64**。
- 数据主要是 **JSON 文件**（账号、会话、工作区、日志）；平台控制面没有外部
  数据库，worker/agent 内部可能有自己的状态。
- 发布通过 `pnpm web:release` 把冻结源码/构建产物切换到 systemd；发布工具有
  锁、预检、健康检查和自动回滚。
- **关键限制：**单机、`PLATFORM_MAX_RESIDENTS=1`、3.3 GiB 内存、磁盘紧、
  没有自动备份、没有自动 TLS、没有外部监控。

---

## 1. 主机与运行时版本

| 项目 | 审计值 | 说明 |
| --- | --- | --- |
| 主机形态 | 单台云 VM（provider-neutral） | 虚拟机，不是物理宿主集群 |
| 操作系统 | Ubuntu 22.04 LTS (jammy) | `/etc/os-release` |
| 内核 | `5.15.0-106-generic` | x86_64 |
| CPU | 4 vCPU | `nproc` |
| 内存 | 3.3 GiB total / 2.0 GiB swap | `free -h` |
| 磁盘 | `/dev/vda2` 40 GB，审计时 26 GB 已用、12 GB 可用 | 见第 10.1 节磁盘风险 |
| cgroup | cgroup v2 | `/sys/fs/cgroup` 为 `cgroup2fs` |
| 时区 | Asia/Shanghai (CST, +0800) | 日志使用本地时间 |
| KVM | 未使用；gVisor 以 Systrap 运行 | 规格见 `docs/superpowers/specs/2026-10-02-web-tenant-execution-isolation-design.md` |
| Docker | Docker 26.1.3 | 仅 nginx 使用 |
| Node | v24.16.0（nvm 路径） | `/home/ubuntu/.nvm/versions/node/v24.16.0/bin/node` |
| pnpm | 9.4.0 | `packageManager` 固定 |
| Python | 3.10.12 | 主机脚本使用 |
| osd | 0.5.2 | `.deploy/osd/current/osd` |
| OpenCode | 1.18.18 | `.deploy/osd/current/opencode` |
| gVisor runsc | `release-20260928.0`，OCI spec 1.2.1 | `/usr/local/lib/scikeel/runsc` |
| 架构 | 全部 x86_64 | osd/opencode/runsc/sandbox-host/rootfs |

平台服务以 `ubuntu` 用户运行；sandbox host、租户卷、镜像安装等宿主级操作以
root 运行。平台进程本身不承担这些宿主级权限。

---

## 2. 请求路径与进程拓扑

```text
Browser
  │
  ▼
:80 nginx 容器（docker, nginx:alpine, network=host, restart=unless-stopped）
  ├── /                      -> 127.0.0.1:4790  platform
  ├── /preview/agent-analytics -> 127.0.0.1:4796  analytics preview
  └── /preview/*             -> 静态预览文件
        │
        ▼
osd-platform.service（systemd, Node 24, 127.0.0.1:4790）
  ├── 静态 Web bundle（PLATFORM_WEB_ROOT）
  ├── auth store / sessions / workspaces（PLATFORM_DATA_DIR）
  ├── /run/scikeel/host.sock
  │     └── scikeel-sandbox-host.service（root）
  │           └── runsc（Systrap, network=sandbox）
  │                 └── 每个租户的 osd/OpenCode worker
  └── OpenCode / Codex 托管运行时（按用户选择）
```

事实要点：

- 平台只监听 `127.0.0.1:4790`；`0.0.0.0:80` 由 nginx 容器监听。
- nginx 配置来自 `.deploy/osd-nginx.conf`，以 `:ro` 挂载进容器。
- 审计时 **没有 443 监听**；TLS/域名/云安全组/SSH 策略是 operator/云厂商侧
  配置，公网暴露前必须复核并收紧。
- 不要暴露 4790、4796、3141；它们只应监听 loopback。

---

## 3. 运行中的服务与定时器

以下为审计时 `systemctl list-units`/`systemctl cat` 的关键结果。具体状态会变化，
使用 `systemctl status` 复核。

| 单元 | 状态 | 用户 | 作用 | 资源/端口 |
| --- | --- | --- | --- | --- |
| `osd-platform.service` | active | ubuntu | 多用户平台、Web、API、SSE、会话 | 127.0.0.1:4790；MemoryMax=640M；MemorySwapMax=128M |
| `scikeel-sandbox-host.service` | active | root | 租户沙箱 launcher、runsc 生命周期 | `/run/scikeel/host.sock`；MemoryHigh=128M；MemoryMax=192M；swap=64M；CPU 25%；TasksMax=32 |
| `scikeel-tenant-volume.service` | active (exited) | root | 准备 loop ext4 租户卷（`/dev/loop4`） | MemoryMax=96M |
| `scikeel-package-mirror-volume.service` | active (exited) | root | 挂载 loop `prjquota` 包镜像卷（`/dev/loop3`） | 2 GiB 卷 |
| `scikeel-package-mirror.service` | active | scikeel-mirror | 沙箱用 Python 包镜像（devpi） | 127.0.0.1:3141；MemoryMax=256M；CPU 50% |
| `scikeel-agent-analytics-preview.service` | active | ubuntu | 管理员 Agent analytics 预览 | 127.0.0.1:4796；MemoryMax=128M |
| `scikeel-watchdog-load.service` | active (exited) | root | 加载 `softdog` 内核模块 | 启动早期 |
| `scikeel-tenant-user-*.service` | 动态 | root | 每个租户的 `runsc` 进程（瞬态单元） | 由 sandbox host 创建 |
| nginx 容器 | running | root(docker) | 反向代理 80 | `open-science-osd-nginx`，`nginx:alpine` |

定时器（用 `systemctl list-timers 'scikeel*'` 复核）：

- `scikeel-disk-check.timer` → `scikeel-disk-check.service`
- `scikeel-disk-maintenance.timer` → `scikeel-disk-maintenance.service`
- `scikeel-storage-trim.timer` → `scikeel-storage-trim.service`（对 loop 卷 `fstrim`）
- `scikeel-image-compaction.timer` → `scikeel-image-compaction.service`（共享不可变镜像文件）
- `scikeel-temporary-library-cleanup.timer` → `scikeel-temporary-library-cleanup.service`

这些维护单元以 root 运行，部分会访问 `.deploy`、`.worktrees`、`.git`、Docker
socket、APT 缓存和 journal。不要在没有阅读 `host-disk-maintenance.mjs` 的情况下
手动触发或修改它们。

**已失败的 `osd-maint-*` / `osd-nnp-test-*` 单元**：审计时显示为 failed，
从名称/命令看是历史测试/调试残留，未发现被生产 timer 引用；不要把它们的
failed 状态当成平台故障。需要清理时先确认没有被其他脚本引用。

---

## 4. systemd 配置、drop-in 与优先级（重要陷阱）

`osd-platform.service` 的单元文件在 `/etc/systemd/system/`，通过 drop-in 叠加：

```text
/etc/systemd/system/osd-platform.service
/etc/systemd/system/osd-platform.service.d/
  ├── memory-limit.conf          MemoryMax=640M, MemorySwapMax=128M
  ├── sandbox-ordering.conf      Wants/After scikeel-sandbox-host.service
  ├── tenant-isolation.conf      历史配置：WorkingDirectory 指向已不存在的
  │                              .worktrees/tenant-science-isolation
  └── zz-scikeel-web-release.conf 发布工具托管；把 WorkingDirectory 指向
                                  当前 live release 的 source
```

关键点：

- **最后一个 drop-in 生效。** `tenant-isolation.conf` 里的旧 WorkingDirectory
  已被 `zz-scikeel-web-release.conf` 覆盖；不要因为看到旧路径就认为服务跑在
  那个目录。以 `systemctl show osd-platform.service -p WorkingDirectory` 为准。
- `zz-scikeel-web-release.conf` 由发布流程创建/更新，带
  `# SciKeel managed Web release` 标记；不要手改，否则下一次发布/回滚会覆盖。
- 环境文件按顺序读取：`/etc/osd-platform.env`，然后
  `/etc/scikeel/platform-sandbox.env`。后者由发布流程更新
  `PLATFORM_WEB_ROOT` 和 `PLATFORM_SANDBOX_IMAGE_DIGEST`，因此**后者优先**。
- 服务属性：`Type=simple`、`Restart=on-failure`、`RestartSec=5`、
  `KillMode=control-group`、`TimeoutStopSec=30`、`UMask=0077`。
- 修改 unit/drop-in 后需要 `sudo systemctl daemon-reload`；修改环境后需要
  `sudo systemctl restart osd-platform.service`。

复核：

```bash
systemctl show osd-platform.service \
  -p WorkingDirectory -p EnvironmentFiles -p ActiveState -p SubState \
  -p MainPID -p MemoryMax -p MemorySwapMax
systemctl cat osd-platform.service
systemctl cat scikeel-sandbox-host.service
```

---

## 5. Live 代码与发布模型

### 5.1 运行的不是 git 工作树

平台运行的是：

```text
.deploy/web-releases/<release-id>/source
```

这是一个**冻结源码快照**，不是 `/opt/open-science-desktop` 的当前 checkout。
因此：

- 直接修改 `/opt/open-science-desktop` 的源码不会影响线上；
- 直接修改 live release 的 `source` 也不会出现在 Git 中，且会被下一次发布/回滚
  覆盖；
- 线上变更必须走 `pnpm web:release`。

### 5.2 `current.json` 与 manifest

发布状态在：

```text
.deploy/web-releases/current.json
.deploy/web-releases/<release-id>/manifest.json
.deploy/web-releases/<release-id>/{source,web,recovery}
```

`current.json` 记录 `id`、`previousId`（发布完成后还可能包含
`manifestHash`）。实际 live 身份以 `systemctl show`、`/proc/<pid>/cwd`、
manifest 和 `pnpm web:release inspect` 的输出为准。

**不要用“最新目录”判断 live 发布。** 目录按时间排序不代表它是当前发布；
恢复流程还可能产生 `*-reader` 目录。判断顺序应为：

1. `systemctl show osd-platform.service -p WorkingDirectory`
2. `.deploy/web-releases/current.json`
3. `manifest.json` 的 `production` / `source` / `artifacts`
4. `/health`

### 5.3 审计时的发布状态（快照，会变化）

| 项目 | 审计值（2026-11-05） |
| --- | --- |
| `current.json` id | `2026-11-05T04-37-34-389Z-4e4a8905-reader` |
| `previousId` | `2026-11-05T01-44-10-289Z-3e31086f` |
| 有效 WorkingDirectory | `.deploy/web-releases/2026-11-05T04-37-34-389Z-4e4a8905-reader/source` |
| live source baseCommit | `b82e899ecfe0ed53aeabf6b7d99b279b37d7c450`（生产仓库 `main`） |
| live web root | `.deploy/web-releases/2026-11-05T04-37-34-389Z-4e4a8905-reader/web` |
| sandbox image digest | `sha256:8c1e1cbffb709554733ca30652890adf10c3684fb7ae2ba93c964389871ebece` |
| 平台健康 | `{"ok":true,"service":"open-science-platform"}` |
| 镜像启用的运行时 | `opencode`, `codex` |
| 最大常驻沙箱 | 1 |

说明：审计时 `-reader` manifest 的状态是 `recovery-prepared`，相邻的非 reader
release 是 `recovering`。这是发布恢复流程的中间状态，不代表服务不可用；
以 health、effective systemd 和 manifest 三项交叉判断。不要删除 reader 或
`recovery` 目录，回滚/恢复可能还需要它们。

### 5.4 发布命令

在**生产服务器**上执行（需要 Linux systemd、`/etc` 配置和 production
`.deploy` 状态）：

```bash
# 只读检查某个 checkout 相对 production 的变更与验证选择
pnpm web:release inspect --source /path/to/checkout

# 准备并发布（源码必须是同一仓库的 worktree，见 5.6）
pnpm web:release run --source /path/to/checkout

# 强制完整验证（耗时更长）
pnpm web:release run --source /path/to/checkout --full

# 对已准备的 release 发布/回滚
pnpm web:release deploy --release <id>
pnpm web:release rollback --release <id>

# 只做磁盘清理预演
pnpm web:release prune --dry-run
```

发布流程包含：

- source inventory 与 fingerprint；
- 按 changed paths 自动决定前端/平台测试、Web 构建、平台切换、镜像校验；
- 在 `.deploy/web-release-deploy.lock` 上加锁；
- 构建/测试通过 `scripts/dev/safe-desktop-task.mjs` 的资源限制；
- 切换 `/etc/scikeel/platform-sandbox.env` 与 managed drop-in；
- 重启 `osd-platform.service`，等待 `/health`；
- 失败时自动恢复上一个 source/web/image 配置并再次健康检查。

### 5.5 镜像变更不是普通 Web 发布

`web-release-policy.mjs` 把以下路径视为镜像输入：

- `runtime/sandbox/`
- `runtime/skills/core/`
- `runtime/opencode-patches/`、`runtime/codex-patches/`
- `crates/`
- 镜像构建/拉取/安装相关脚本，以及 `Cargo.toml`/`Cargo.lock`、
  `OPENCODE_VERSION` 等。

当 `imageRequired=true` 时：

- 必须有已安装、CI attest 过、digest 匹配的镜像；
- 发布工具会校验/复用已安装镜像，**不会替你构建沙箱镜像**；
- 镜像构建是单独的 CI/宿主流程（见 `.github/workflows/sandbox-image.yml`、
  `runtime/sandbox/image/Dockerfile`）；
- 普通 Web 改动不会重建镜像，也不应随意切换镜像 digest。

### 5.6 源码 checkout 的硬性要求

`commonStore()` 要求源码 checkout 与生产仓库共享同一个 git common dir：

```bash
git -C /opt/open-science-desktop worktree add .worktrees/<name> <branch-or-commit>
pnpm web:release run --source /opt/open-science-desktop/.worktrees/<name>
```

在服务器上任意位置新 `git clone` 一份再发布，会被拒绝
（`Source must belong to the same project Git common root`）。

发布还需要 `node_modules`：

- 根目录、`apps/desktop/node_modules`、`services/platform/node_modules`；
- 当前 worktree 的 `node_modules` 可能是指向另一个 worktree 的 symlink
  （见 `.deploy/web-releases/<id>/manifest.json` 的 `dependencies.references`）；
- 不要删除被引用的 worktree，否则依赖校验会失败。

---

## 6. 数据布局与磁盘

### 6.1 生产数据

| 路径 | 审计大小 | 权限/用途 |
| --- | --- | --- |
| `.deploy/platform-data` | 842 MB | 700；平台持久状态 |
| `.deploy/platform-data/auth.json` | 68 KB | 600；账号与密码 hash |
| `.deploy/platform-data/workers` | 776 MB | 每用户 workspace/worker 状态 |
| `.deploy/platform-data/cli-runtime` | 52 MB | 每用户 CLI 会话与配置 |
| `.deploy/platform-data/agent-logs` | 未单独统计 | agent 日志（可能含 prompt/工具输出） |
| `.deploy/platform-data/attachments` | 1.1 MB | 会话附件 |
| `.deploy/platform-data/conversation-state` | 1.2 MB | 会话状态 |
| `.deploy/platform-data/collaboration` | 1.8 MB | 协作状态 |
| `.deploy/platform-data/workspace-catalog` | 840 KB | 工作区目录元数据 |
| `.deploy/platform-data/workspace-management` | 488 KB | 工作区管理 |
| `.deploy/platform-data/agent-analytics` | 5.7 MB | 管理分析 |
| `.deploy/platform-data/tool-outcomes` | 376 KB | 工具结果 |
| `.deploy/platform-data/model-defaults` | 小 | 模型默认值 |

平台控制面没有外部数据库；会话、账号、工作区等以 JSON 文件持久化。
worker/agent 可能在 `workers/` 下有自己的状态。备份必须是
**文件系统级一致备份**，并包含整个 `platform-data`，不能只备份 auth.json。

### 6.2 发布与运行时资产

| 路径 | 审计大小 | 说明 |
| --- | --- | --- |
| `.deploy/web-releases` | 约 955 MB | 28 个 release 目录；冻结 source/web/recovery |
| `.deploy/osd` | 约 331 MB | `.deploy/osd/current` → `releases/0.5.2`；osd/opencode/uv/agent-browser/resources |
| `.deploy/osd/current` | 约 291 MB（解引用） | 完整 headless 运行时发行包 |
| `.deploy/osd-nginx.conf` | 4 KB，ubuntu:ubuntu 664 | nginx 配置；不在 Git |
| `.deploy` 总量 | 约 2.7 GB | 还包含 prototypes、backups、临时检查脚本等；不要整目录删除 |
| `.worktrees` | 约 862 MB | git worktree；gitignored |
| `.git` | 约 32 MB | 仓库历史 |

`.deploy` 是**混合目录**：既有生产状态，也有开发/验收/原型/备份产物。只把
`platform-data`、`web-releases`、`osd`、`osd-nginx.conf` 和发布锁视为生产关键；
清理前先看清楚路径，不要用 `rm -rf .deploy/*` 之类的命令。

### 6.3 沙箱与宿主资产

| 路径 | 审计大小 | 说明 |
| --- | --- | --- |
| `/usr/local/lib/scikeel` | 314 MB | runsc、gvisor-bin、osd-sandbox-host、安装/维护脚本 |
| `/var/lib/scikeel/images` | 2.6 GB | 每个 digest 一份只读 sandbox rootfs |
| `/var/lib/scikeel/tenant-data` | 550 MB | loop4 挂载的租户数据 |
| `/var/lib/scikeel/tenant-data.img` | 2.1 GB | loop4 的 ext4 backing file |
| `/var/lib/scikeel/package-mirror` | 2 GB 卷（loop3） | devpi 包镜像数据 |
| `/var/lib/scikeel/package-mirror.img` | 2 GB | loop3 backing file |
| `/var/lib/scikeel/production-launcher` | 小 | sandbox host 状态 |
| `/etc/scikeel` | 小 | 沙箱/模型配置；权限见第 7 节 |

`/srv/osd` 在审计时**不存在**；某些 unit 的 `ReadWritePaths=/srv/osd/...` 带
`-` 前缀（允许缺失），属于历史/兼容路径。实际数据目录是
`.deploy/platform-data`。

### 6.4 备份现状

- **没有发现自动备份 timer/service**。
- `.deploy/backups` 是手工/临时备份目录，内含历史配置和测试数据，不是完整
  备份方案。
- 生产备份至少应覆盖：
  - `.deploy/platform-data`（含 auth.json）
  - `.deploy/web-releases/current.json` 和当前/上一个 release 的 manifest
  - `/etc/osd-platform.env`、`/etc/scikeel/platform-sandbox.env`
  - `/etc/scikeel/model-brokers.json`、`sandbox-host.json`
  - `.deploy/osd-nginx.conf`
  - `/var/lib/scikeel/tenant-data.img`（如果租户数据需要保留）
  - `/var/lib/scikeel/images`（或记录可重建的 digest 来源）
- 备份必须加密/限制权限；不要放进 Git。

---

## 7. 配置与密钥（只记录位置，不记录值）

| 文件 | 权限 | 内容类别 | 注意事项 |
| --- | --- | --- | --- |
| `/etc/osd-platform.env` | root:root 600 | 平台路径、管理员 bootstrap、CLI 路径、运行时选择 | 含 `PLATFORM_ADMIN_PASSWORD`；不要打印 |
| `/etc/scikeel/platform-sandbox.env` | root:root 600 | managed Web root、sandbox socket、镜像 digest、租户根、max residents | 发布工具会更新；不要手改关键值 |
| `/etc/scikeel/model-brokers.json` | root:ubuntu 640 | provider/model 目录、默认模型、镜像 URL、搜索 provider | 含 provider 凭据；只读 schema，不读值 |
| `/etc/scikeel/sandbox-host.json` | root:ubuntu 640 | runsc 路径/校验和、quota 设备、租户/镜像根 | 宿主级配置；改动需重启 sandbox host |
| `.deploy/platform-data/auth.json` | ubuntu 600 | 用户、密码 hash、会话状态 | 敏感；备份/恢复需加密 |
| `.deploy/osd-nginx.conf` | ubuntu:ubuntu 664 | 反向代理、预览路由 | 可能含内部主机名；不要公开发布 |

`osd-platform.env` 当前变量名（只列名，不含值）：

```text
PATH
PLATFORM_DATA_DIR
PLATFORM_ADMIN_USERNAME
PLATFORM_ADMIN_PASSWORD
PLATFORM_AGENT_RUNTIME
PLATFORM_HOST
PLATFORM_PORT
PLATFORM_SECURE_COOKIES
PLATFORM_WEB_ROOT
PLATFORM_CLAUDE_BIN
PLATFORM_CODEX_BIN
PLATFORM_CLAUDE_CONFIG_DIR
PLATFORM_CODEX_HOME
PLATFORM_AGENT_TURN_TIMEOUT_MS
OSD_BIN
OSD_RESOURCES
OSD_STARTUP_TIMEOUT_MS
OSD_STOP_TIMEOUT_MS
```

`platform-sandbox.env` 当前变量名：

```text
PLATFORM_MANAGED_SANDBOX
PLATFORM_SANDBOX_SOCKET
PLATFORM_SANDBOX_IMAGE_DIGEST
PLATFORM_SANDBOX_IMAGES_DIR
PLATFORM_SANDBOX_INSTANCES_DIR
PLATFORM_SANDBOX_NATIVE_DIR
PLATFORM_DATA_DIR
PLATFORM_MAX_RESIDENTS
PLATFORM_WEB_ROOT
```

语义要点：

- 管理员只在 auth store 没有用户时由 `PLATFORM_ADMIN_PASSWORD` 创建；
  之后修改该变量**不会重置已有密码**。不要通过改 env 猜密码。
- `PLATFORM_SECURE_COOKIES=false` 适用于当前 HTTP 反向代理；一旦启用 HTTPS，
  应改为 `true`，否则 cookie 的 Secure 属性不匹配。
- `PLATFORM_MANAGED_SANDBOX=1` 表示平台走 sandbox host；没有 sandbox host
  的部署不能设置该值，否则会因配置不完整启动失败。
- `model-brokers.json` 的顶层结构是
  `defaultModel/defaultProvider/mirrorUrl/providers/schema/searchProvider`；
  具体 provider 值属于密钥，不要复制到文档或 Git。
- 服务器的凭据实际存放在 root-owned 文件/环境变量中，不是 OS keychain。
  这是与项目早期“keychain”描述不同的实际部署事实；备份/恢复时必须按
  文件权限处理。

---

## 8. 租户沙箱细节

### 8.1 配置

`/etc/scikeel/sandbox-host.json` 审计字段：

| 字段 | 值/含义 |
| --- | --- |
| `schema` | 1 |
| `platformUid/platformGid` | 1000（`ubuntu`） |
| `socketPath` | `/run/scikeel/host.sock` |
| `stateDir` | `/var/lib/scikeel/production-launcher` |
| `roots.instances` | `/var/lib/scikeel/tenant-data/live/instances` |
| `roots.native` | `/var/lib/scikeel/tenant-data/live/native` |
| `roots.images` | `/var/lib/scikeel/images` |
| `runsc` | `/usr/local/lib/scikeel/runsc` |
| `quotaDevice` | `/dev/loop4` |
| `quotaBytes` | 1 GiB |
| `quotaInodes` | 30000 |
| `quotaBackingFile` | `/var/lib/scikeel/tenant-data.img` |
| `quotaCapacity` | 2 GiB |
| `synthetic` | false |

平台侧对应：

- `PLATFORM_MANAGED_SANDBOX=1`
- `PLATFORM_MAX_RESIDENTS=1`
- 租户实例/原生目录来自 `platform-sandbox.env`
- 镜像 digest 来自 `PLATFORM_SANDBOX_IMAGE_DIGEST`

### 8.2 运行方式

审计时观察到的租户 `runsc` 命令形态：

```text
runsc --root=/var/lib/scikeel/production-launcher/runsc
  --platform=systrap
  --network=sandbox
  --host-uds=none
  --directfs=false
  --ignore-cgroups
  --file-access=exclusive
  --file-access-mounts=exclusive
  run --bundle ... scikeel-user-...
```

要点：

- **Systrap**：不需要 `/dev/kvm`；宿主内核 5.15 上运行。
- `--network=sandbox`：租户网络在独立 netns 中。
- `--host-uds=none`：不向租户暴露宿主 Unix socket。
- `--directfs=false`：文件访问经过 gVisor。
- `--file-access=exclusive`：限制宿主文件访问路径。
- `--ignore-cgroups`：当前不依赖 cgroup 做租户级资源限制；不要据此假设
  CPU/内存有独立硬限额。
- 每个租户由瞬态 `scikeel-tenant-user-*` unit 驱动，由 sandbox host 创建/回收。

### 8.3 存储与配额

- 租户卷：`/dev/loop4`，ext4，`prjquota`，挂载到
  `/var/lib/scikeel/tenant-data`；backing file 2 GiB；每租户 1 GiB / 30000 inode。
- 镜像卷：`/dev/loop3`，ext4，`prjquota`，挂载到
  `/var/lib/scikeel/package-mirror`；2 GiB。
- `scikeel-storage-trim.timer` 对两个 loop 卷做 `fstrim`。
- `scikeel-image-compaction.timer` 跨镜像共享不可变文件，节省磁盘。
- 不要手动 `losetup -d`、`umount` 或重建 `.img`，除非明确知道租户卷依赖。

### 8.4 沙箱镜像

- 当前 digest：`sha256:8c1e1cbffb709554733ca30652890adf10c3684fb7ae2ba93c964389871ebece`
- 根目录：`/var/lib/scikeel/images/<digest 去掉 sha256:>/rootfs`
- rootfs 是 x86_64；由 `runtime/sandbox/image/Dockerfile` 构建。
- 镜像启用的运行时：`opencode`, `codex`。
- 镜像内的工具包括 osd runner、文件 RPC、cli jobs、project/science environment、
  collaboration、tool outcome 等；`install-sandbox-image.py` 会校验 attestation、
  archive 内容和 tool lock。
- 镜像输入改变时，必须走单独的镜像构建/安装流程；普通 Web 发布不会重建。

### 8.5 安全边界

- 租户只能看到 workspace/state/home/scratch 等显式 bind mount；
- 镜像只读；租户卷有 quota；
- 宿主 UDS 不暴露；
- 网络在独立 netns；
- 命令执行/文件删除/依赖安装/远程连接仍受平台审批策略约束；
- 不要为了调试关闭 sandbox 或把 4790/3141 暴露到公网。

---

## 9. 平台运行时与 agent

- `services/platform/src/main.mjs` 构造：
  - `AuthStore`（`PLATFORM_DATA_DIR/auth.json`）
  - `WorkerManager`（每用户 `osd` worker）
  - `CliRuntimeManager`（OpenCode/Claude/Codex）
  - `PlatformServer`（HTTP/SSE、Web、API）
- 默认 runtime 是 **OpenCode**；管理员可在设置中按用户选择 Claude/Codex。
- OpenCode 会话由用户自己的 worker（`osd`）处理，不是 `CliRuntimeManager`
  直接 spawn；Claude/Codex 是 managed runtime，由平台 spawn 主机上的 CLI。
- 当前沙箱镜像启用 `opencode` 和 `codex`；**Claude 当前不可用**（用户确认
  2026-10-02），不要探测 Claude 模型/端点，也不要把它当作发布阻塞。
- 正式环境的 live assistant 自 2026-11-03 起为 OpenCode + DeepSeek Flash，
  通过 `/etc/scikeel/model-brokers.json` 的 broker 配置提供；以管理员设置/实时
  provider catalog 为准，不要复制 provider 密钥。
- 会话/工作区状态在 `.deploy/platform-data`；`workers/` 是最大目录（约 776 MB），
  可能包含用户工作区；备份/恢复需按用户数据对待。
- 平台是单用户/小规模内部部署；“多用户”不等于可横向扩展：当前
  `PLATFORM_MAX_RESIDENTS=1`，只有一台宿主。

---

## 10. 资源、安全与运维约束

### 10.1 资源

- 宿主 3.3 GiB RAM，2 GiB swap；历史上发生过全局 OOM/SSH 失联，禁止无界构建。
- 平台服务 `MemoryMax=640M`，swap 128M。
- sandbox host `MemoryHigh=128M` / `MemoryMax=192M` / swap 64M / CPU 25% /
  TasksMax 32。
- package mirror 256M / CPU 50%；analytics preview 128M；tenant volume 96M；
  disk maintenance/check 256M；release build cgroup 上限 2200M/swap 256M。
- 所有前端构建、测试、Cargo、Vitest、Vite 必须走 package scripts，由
  `scripts/dev/safe-desktop-task.mjs` 套 cgroup/锁；不要直接运行重型命令。
- 发布和 guarded task 共享 `.deploy/web-release-deploy.lock`；忙时失败退出，
  不要绕过锁。
- 磁盘审计时仅约 12 GB 可用；release candidate 预留 300 MB；定期
  `pnpm web:release prune --dry-run` 检查，不要在未确认时删除 worktree/release。
- 并发 agent 会话可能重启/停止平台服务；在共享环境做验收前先确认不会打断
  其他用户的 turn。

### 10.2 安全

- 唯一公网入口应是 nginx 的 80；审计时没有 443 监听，防火墙/TLS/SSH 策略
  由 operator/云安全组管理。公网生产应收紧安全组、限制 SSH、配置 TLS，并设置
  `PLATFORM_SECURE_COOKIES=true`。
- 不要把 4790（平台）、4796（analytics preview）、3141（devpi）暴露公网。
- 密钥/凭据存放在 root-owned 600/640 配置、root-readable env，以及
  ubuntu-owned 600 的 auth.json 等数据文件中；不要 `cat` 到对话/日志，
  不要进入 Git/provenance/崩溃报告。
- 平台的命令执行、文件删除、依赖安装、远程连接默认需要审批；不要为方便
  关闭审批或绕过 sandbox。
- 公开仓库/PR 中不要加入 `.deploy`、`.env`、auth、provider 配置、用户数据。

### 10.3 可观测性

- 健康：`curl -fsS http://127.0.0.1:4790/health`
- 平台日志：`journalctl -u osd-platform.service`（JSON 行）
- 沙箱：`journalctl -u scikeel-sandbox-host.service`，以及瞬态
  `scikeel-tenant-user-*` 单元
- 包镜像：`journalctl -u scikeel-package-mirror.service`
- nginx：`docker logs open-science-osd-nginx`
- 发布：`.deploy/web-releases/<id>/manifest.json`、`recovery/`、
  `.deploy/web-releases/current.json`
- 数据：`.deploy/platform-data/agent-logs`、`workers` 等
- 没有发现外部监控/告警/自动备份系统；需要 operator 自行补齐。

### 10.4 已知陷阱

1. **live source 不是 git checkout**；改工作树不会上线。
2. **`current.json` 不是“最新目录”**；reader/recovery 状态可能让它看起来
   与目录时间不一致。
3. **发布状态 `recovery-prepared` / `recovering` 不等于服务不可用**；看 health。
4. **drop-in 顺序**：旧 `tenant-isolation.conf` 的路径已被 `zz-...` 覆盖；
   以 `systemctl show` 为准。
5. **`/srv/osd` 不存在**；unit 中的该路径带 `-`，是兼容/历史项。
6. **node_modules 可能是跨 worktree 的 symlink**；删除/移动 worktree 会破坏
   发布依赖校验。
7. **`.deploy` 是混合目录**；不是所有内容都是生产数据。
8. **镜像变更需要 CI attest 的已安装镜像**；普通 Web 发布不构建镜像。
9. **所有产物是 x86_64**；不要假设同一份产物能在其他架构上直接运行。
10. **单机 + max residents 1**；不要按水平扩展假设容量。

---

## 11. Git、worktree 与已知漂移

- 仓库：`/opt/open-science-desktop`
- 远端：
  - `origin` = `https://github.com/J0nhyer/scikeel.git`
  - `upstream` = `https://github.com/ai4s-research/open-science.git`
- 审计时约 11 个 worktree；`.worktrees/` 被 Git 忽略。
- live source 的 baseCommit 是生产仓库 `main` 的 `b82e899e`；live source 是
  冻结副本，不是 worktree。
- **审计时的已知漂移（务必先用命令复核）：**
  - 生产仓库 `main` 比 `origin/main` 领先 312 个提交；
  - `origin/main` 比生产仓库 `main` 多 1 个提交（删除旧 GitHub Actions）；
  - 当前工作分支 `feat/research-work-modes` 落后 `main` 283 个提交，
    且有约 164 个未提交/未跟踪项（103 个修改 + 61 个未跟踪）。
- 这意味着 **GitHub 上的 main 可能不是线上代码**。在 clone、对比或部署前，
  先运行：
  ```bash
  git -C /opt/open-science-desktop status --short
  git -C /opt/open-science-desktop rev-list --count origin/main..main
  git -C /opt/open-science-desktop rev-list --count main..origin/main
  git -C /opt/open-science-desktop worktree list
  ```
- 不要假设 `git clone` 就是线上版本；以生产仓库的 live baseCommit 和
  release manifest 为准。
- 发布源码 checkout 必须是本仓库的 worktree；独立 clone 会被
  `commonStore()` 拒绝（见 5.6）。

---

## 12. 正式环境操作边界

本节只说明正式环境中的发布和操作约束。

### 12.1 发布影响

- **只改 Web**：release 构建 Web bundle；只有 Web 变化时平台不重启
  （除非 selection.deployPlatform 为真）。
- **改平台源码**：release 切换 WorkingDirectory 并重启
  `osd-platform.service`；必须验证 `/health`、登录和真实 turn。
- **改 runtime/sandbox、runtime/skills/core、patches、crates 等镜像输入**：
  `imageRequired=true`；必须先有 CI attest 且已安装的镜像；release 只校验/
  复用，不构建镜像。
- **改路径/端口/用户**：同时更新两个 env、unit/drop-in、sandbox-host 配置、
  tenant/package volume 和 nginx；执行 `daemon-reload` + restart，并复核
  `PLATFORM_SECURE_COOKIES` 与 TLS。
- **发布位置**：只允许在生产服务器执行 `pnpm web:release`；release 依赖
  production systemd、`/etc` 配置和 `.deploy` 锁。

### 12.2 不可直接操作

- 不要直接修改 live release 的 `source`、`web`、`manifest.json`、
  `current.json` 或 `recovery/`；它们由发布/恢复流程管理。
- 不要删除当前、上一版、reader/recovery 目录；`prune` 只允许 `--dry-run`。
- 不要绕过发布锁或 guarded task 的 cgroup 限制。
- 不要打印密钥；不要把 `.deploy`、auth、provider 配置、用户数据写入 Git。
- 不要假设平台是普通无特权进程：sandbox host 依赖 root、systemd、
  mount/overlay、network namespace、loop 设备和 gVisor。
- 当前是单机、`PLATFORM_MAX_RESIDENTS=1`；不要按水平扩展假设容量。

### 12.3 发布后验收与失败处理

- 检查 `/health`、登录、真实 agent turn；涉及沙箱时再检查 sandbox exec、
  配额和重启持久化。
- 失败时查看该 release 的 `manifest.json` 和 `recovery/`，确认发布工具已恢复
  上一版；不要手工改 live source 来“修复”线上。
- 变更完成后更新本文的快照表（见第 14 节）。

---

## 13. 只读复核命令

以下命令用于确认本文快照是否仍成立。**不要**用它们打印密钥；涉及 env/model
config 时只输出键名或安全字段。

```bash
# 主机
uname -a
cat /etc/os-release
nproc
free -h
df -h /
cat /proc/pressure/memory
stat -fc %T /sys/fs/cgroup

# 平台有效配置
systemctl show osd-platform.service \
  -p WorkingDirectory -p EnvironmentFiles -p ActiveState -p SubState \
  -p MainPID -p MemoryMax -p MemorySwapMax
systemctl is-active osd-platform.service \
  scikeel-sandbox-host.service scikeel-tenant-volume.service \
  scikeel-package-mirror.service scikeel-agent-analytics-preview.service

# 健康与端口
curl -fsS http://127.0.0.1:4790/health; echo
ss -ltnp | grep -E ':(80|443|4790|4796|3141)\b'

# 发布状态（从 current.json 动态解析，不依赖固定 release id）
cat .deploy/web-releases/current.json
RELEASE_ID=$(python3 -c "import json; print(json.load(open('.deploy/web-releases/current.json'))['id'])")
python3 - "$RELEASE_ID" <<'PY'
import json, sys
release_id = sys.argv[1]
m = json.load(open(f'.deploy/web-releases/{release_id}/manifest.json'))
print('id', m.get('id'), 'status', m.get('status'))
print('baseCommit', m.get('source', {}).get('baseCommit'))
sel = m.get('selection') or {}
print('selection', {k: sel.get(k) for k in
      ('buildWeb', 'deployPlatform', 'imageRequired', 'liveAssistant', 'full')})
print('artifacts.image', (m.get('artifacts') or {}).get('image', {}).get('imageDigest'))
PY

# 进程实际生效的安全字段（不要打印完整 environ）
PID=$(systemctl show osd-platform.service -p MainPID --value)
sudo -n python3 - "$PID" <<'PY'
import sys
pid = sys.argv[1]
keys = {'PLATFORM_WEB_ROOT', 'PLATFORM_SANDBOX_IMAGE_DIGEST', 'PLATFORM_HOST',
        'PLATFORM_PORT', 'PLATFORM_DATA_DIR', 'PLATFORM_SECURE_COOKIES',
        'PLATFORM_MANAGED_SANDBOX', 'PLATFORM_MAX_RESIDENTS'}
for entry in open(f'/proc/{pid}/environ', 'rb').read().split(b'\0'):
    if b'=' not in entry:
        continue
    k, v = entry.split(b'=', 1)
    k = k.decode()
    if k in keys:
        print(f'{k}={v.decode(errors="replace")}')
PY

# 沙箱
systemctl status scikeel-sandbox-host.service --no-pager
sudo -n cat /etc/scikeel/sandbox-host.json
findmnt -no SOURCE,FSTYPE,TARGET /var/lib/scikeel/tenant-data
findmnt -no SOURCE,FSTYPE,TARGET /var/lib/scikeel/package-mirror
lsblk -o NAME,SIZE,TYPE,MOUNTPOINT

# 运行时版本
node -v
pnpm -v
/usr/local/lib/scikeel/runsc --version
.deploy/osd/current/osd version
.deploy/osd/current/opencode --version

# Docker / nginx
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
docker inspect open-science-osd-nginx \
  --format 'Network={{.HostConfig.NetworkMode}} Restart={{.HostConfig.RestartPolicy.Name}}'

# Git / worktree
git status --short
git worktree list
git rev-list --count origin/main..main
git rev-list --count main..origin/main

# 数据大小
du -sh .deploy/platform-data .deploy/web-releases .deploy/osd .worktrees
du -sh /var/lib/scikeel/images /var/lib/scikeel/tenant-data /var/lib/scikeel/package-mirror

# 只输出 env 键名，不输出值
sudo -n grep -oE '^[A-Z_]+=' /etc/osd-platform.env
sudo -n grep -oE '^[A-Z_]+=' /etc/scikeel/platform-sandbox.env
```

发布前只读检查（需指定真实 worktree）：

```bash
pnpm web:release inspect --source /opt/open-science-desktop/.worktrees/<name>
```

---

## 14. 文档维护

- 本文最后核对：2026-11-05（Asia/Shanghai）。
- 任何 release、unit、端口、路径、沙箱配置、Git 状态变化后，应更新本文的
  快照表；不要把快照值当成永久事实。
- 本文允许使用中文（见 `AGENTS.md` 的 Working conventions）；代码、标识符、
  注释、commit message 和产品字符串仍使用英文。
- 不应在本文加入任何密钥、token、auth hash、用户数据或公网地址；需要时只写
  路径、权限和读取方法。
- 相关文档：
  - `docs/DEPLOYMENT.md` — 安装、首次部署、HTTPS、更新/回滚/备份。
  - `AGENTS.md` — 项目规则、安全默认值、发布约定。
  - `docs/superpowers/specs/2026-10-02-web-tenant-execution-isolation-design.md`
    — 租户隔离与 gVisor 设计。
