# SciKeel

[English](./README.md) · [简体中文](./README.zh.md)

**在浏览器中运行的 AI 科研工作台。**

SciKeel 把科研对话、文献、代码、数据、图表和报告集中在一个 Web 工作区里。
你可以把它部署在自己的服务器上，为团队成员创建账户，然后在电脑或手机上使用。
无需切换应用，即可选择 OpenCode，或由管理员启用的 Claude Code / Codex 助手。

源码仓库：**[J0nhyer/scikeel](https://github.com/J0nhyer/scikeel)**。
协作通过 Issues、分支和 Pull Request 进行。

## 能做什么

- **与科研智能体协作。** 在连续对话中探索问题、阅读文献、编写分析代码、生成图表并撰写报告。
  流式回复和工具活动让过程保持可见。
- **选择助手和模型。** 默认使用 OpenCode。管理员可以通过服务器托管的配置启用
  Claude Code 和 Codex。Web 输入框会列出可用模型和支持的推理设置。
- **集中管理科研文件。** 浏览服务器工作区，预览 PDF、图片、表格和文档，并在浏览器中下载原始文件。
- **继续一个项目。** 回到历史会话和生成的文件，查看结果背后的工作，并使用工作流模板做分析和可追溯性审查。
- **电脑和手机都能用。** 网关 Web 界面支持窄屏，可进行对话、文件浏览和科研产物预览。
- **管理访问权限。** 管理员创建账户并管理已启用的助手；每个账户都有独立的工作区、worker 状态和对话历史。

当前多用户访问提供相互独立的个人工作区。共享项目编辑和多人同时编辑文档尚未实现。
科研产出仍需人工核验计算、引用和结论。

## 运行方式

```text
浏览器 -> HTTPS 反向代理 -> SciKeel 平台 -> 用户 worker -> AI 运行时
```

React/TypeScript Web 界面由 Node.js 平台提供，平台负责登录、账户、运行时选择和经过认证的
API/SSE 代理。每个用户按需启动一个无界面的 `osd` worker，拥有独立的工作区路径和状态。
OpenCode、模型供应商集成、技能和 MCP 连接器共同支撑科研工作。

工作区文件和对话保存在部署主机上。发往外部模型供应商的请求可能包含提示、选定上下文和工具结果；
这是一个自托管服务，不是离线 AI 系统。供应商凭据和可选的 CLI 凭据由服务器管理，不得进入源码仓库。

## 开始使用

**使用已有实例：** 打开它的 Web 地址，用管理员创建的账户登录，选择可用模型，然后开始对话。
Windows、macOS 和 Linux 用户都通过浏览器访问同一个服务。

**自行部署：** 参阅[部署指南](./docs/DEPLOYMENT.md)。其中涵盖本地启动、配置、Linux 服务、
Windows 环境、HTTPS、账户、验收检查、更新、备份和回滚。

准备源码检出：

```bash
git clone https://github.com/J0nhyer/scikeel.git
cd scikeel
pnpm install --frozen-lockfile
pnpm build
```

需要 Node.js 20 或更高版本、pnpm 9.4.0、Git，以及与服务器架构匹配的完整无界面 `osd` 发行包。
只构建 Web 界面不会启动平台，也不会创建科研运行时。运行前请按部署指南配置好 Web、
运行时和持久化数据的绝对路径：

```bash
pnpm platform:start
```

默认监听回环地址。若需公网访问，请在平台前放置 HTTPS 反向代理并启用安全会话 cookie。
请保持 worker 端口不对外暴露。

## 部署支持

| 场景 | 当前状态 |
| --- | --- |
| Windows/macOS/Linux 浏览器客户端 | 使用已部署的 Web 界面，无需本地安装运行时。 |
| Linux 服务器 | 当前已验证的部署路径：Node 平台、无界面 worker、systemd 和反向代理。 |
| 原生 Windows 服务器 | 存在 Windows 运行时构建目标，并提供手动启动说明；完整多用户部署尚未在 Windows 上验收。 |
| Windows 无人值守安装 | 尚无内置一键安装器、服务注册或自动更新流程。 |
| WSL 部署 | 可使用启用了 systemd 的 WSL 运行 Linux 组件；Windows 启动和网络仍需配置与验收。 |

## 开发与协作

项目代码和文档使用英文。请遵循 [AGENTS.md](./AGENTS.md)，保持改动小而聚焦，
并在 Web 界面评审中覆盖手机宽度。

1. 在 Issue 中描述问题和验收标准。
2. 创建功能分支。受邀协作者可以直接推送分支；其他贡献者可以 fork 公共仓库并提交 Pull Request。
3. 通过下面的包脚本运行与改动相关的检查。
4. 提交 PR，说明行为变化、验证方式和部署步骤，并由另一位贡献者评审后合并。

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm platform:test
pnpm build
```

请串行运行重型检查。在小型 Linux 主机上，前端包脚本会施加 cgroup 内存/交换限制，
并在构建失败时保护现有 bundle。构建和测试请使用这些脚本；主机配置见部署指南。

合并 PR 不会自动部署 Web 服务。目前尚未配置 Web PR 自动化和自动部署。
请勿把部署数据、凭据和私有科研文件提交到仓库或 Issue/PR 附件中。

## 仓库结构

| 路径 | 用途 |
| --- | --- |
| `apps/web/src/` | React Web 界面和网关浏览器行为。 |
| `services/platform/` | Node 平台：认证、账户、运行时管理和代理。 |
| `packages/sdk/` | UI 使用的 API 客户端封装。 |
| `packages/shared/` | 共享类型和领域模型。 |
| `crates/osd-core/`、`crates/osd-cli/` | 无界面科研服务器和命令行工具。 |
| `runtime/` | 智能体配置、技能、插件、工具和 MCP 集成。 |
| `examples/` | 示例科研工作区。 |
| `scripts/` | 构建、资源准备和发布工具。 |
| `docs/DEPLOYMENT.md` | 当前 Web 部署与协作指南。 |
| `PROGRESS.md` | 已验证的里程碑和阻塞项。 |

## 运行限制

账户由管理员创建，未实现公开自助注册。用户拥有独立的应用状态，但 worker 共享同一个操作系统服务身份：
没有容器/虚拟机边界、按用户资源配额或登录限流。当前部署面向可信协作者。
请审查已配置的助手权限，并对敏感的 OpenCode 操作使用手动审批。

手机和电脑浏览器都访问服务器端工作区。浏览器访问不会授予用户本地文件系统的直接访问权限。
工作台账户成员身份与 GitHub 协作者身份相互独立。

## 许可证与来源说明

SciKeel 源自 [Open Science Desktop](https://github.com/ai4s-research/open-science)，
遵循 [MIT 许可证](./LICENSE)。第三方资源保留各自许可证。
历史设计文档和 [CITATION.cff](./CITATION.cff) 可能描述上游项目，不代表 SciKeel 的发布版本或科研引用。
