# Web Tenant Execution Isolation Design

**Status:** Design draft for written-spec review. The user approved the proposed
isolation direction and requested a complete file/project compatibility audit on
2026-10-02. Application implementation and production migration have not started.

## Goal and scope

Protect the authenticated multi-user Web platform from an agent reading, changing,
or deleting another account's files or operating on the host. Preserve existing
Web file browsing, artifact previews/downloads, project creation, session/project
association, research reports, and local reproducibility data.

Use one gVisor sandbox per account, including its Open Science worker, all agent
runtimes, local MCP servers, hooks, plugins, Git snapshots, and child processes.
The platform authenticates users and owns orchestration outside the sandbox.
Account identity, never a model-supplied path, determines the sandbox and mounts.

This is account isolation. Projects belonging to one account retain their current
shared-account behavior; this design does not claim that they cannot read one
another. Conversation attachment authorization retains its separately approved
ownership rules. Strict OS isolation between conversations is a separate design.

Product scope is Web, including 390px viewports. Desktop defaults and native
integrations must remain buildable and keep their existing semantics. No new
native filesystem, local kernel, or native-dialog controls are exposed in Web.

## Evidence and feasibility

### Current implementation

- `services/platform/src/worker-manager.mjs` assigns separate workspace/state
  directories, ports, and credentials, then uses ordinary `spawn`. Its environment
  currently inherits `process.env`; this is not an OS boundary.
- `services/platform/src/cli-runtime.mjs` launches Claude/Codex with ordinary
  `spawn`. It uses private HOME/config directories and an environment allowlist,
  but session creation/movement validate paths lexically rather than resolving
  filesystem links.
- Sampled live user workers/OpenCode processes use UID 1000 and share mount,
  process, user, and network namespaces. Sampled services have no private network,
  private HOME, or per-service memory maximum.
- `crates/osd-core/src/gateway.rs` bounds versioned file routes but also forwards
  raw OpenCode routes, queries, and some bodies. The platform routes authenticated
  users to their worker but does not independently constrain every raw path.
- Existing project/session directories are absolute strings. The frontend groups
  projects and sessions using `samePath`/`pathKey`; research tasks and CLI native
  history also depend on persisted directories.
- Project metadata is workspace-controlled. `source_path` and registered external
  projects are legitimate desktop features but cannot authorize Web access beyond
  the account's trusted root.
- `git_snapshot.rs` executes Git in user repositories. `osd server` watches its
  active workspace; a recursive account-root watch currently queues snapshots of
  that root, not necessarily the changed nested project's own repository.
- `cli-profile.mjs` copies administrator authentication/configuration into private
  CLI profiles. These copies are still readable by code running as their owner.
- The shared working tree changed during this audit: an independent attachment
  implementation added `attachments.mjs`, `attachment-turns.mjs`, browser upload
  controls, and native image-input handling. A final source refresh incorporated
  these paths. This review does not establish that work's tests or deployment.
  `AttachmentStore.materialize` currently creates per-session working copies
  beside the original store; those copies require explicit sandbox delivery.
- The same refresh found `platform-test` included in the guarded task dispatcher
  and the platform test package script wired to it. Preserve and verify that
  in-progress guard integration; do not repeat the initial outdated observation.
- The deployed probe binary is `osd 0.5.2` with OpenCode `1.18.18`. The source fetch
  script currently defaults to OpenCode `1.18.32`; deployed/source parity must be
  explicit in implementation and acceptance.

### Controlled local experiments

Experiments used synthetic A/B directories under
`.deploy/tenant-isolation-design-probe/`, private empty HOME/state, no administrator
credentials, no real user files, and no paid model calls. No service was restarted,
Docker runtime registration changed, or binary installed system-wide.

A checksum-verified, temporary `runsc release-20260928.0` ran with Systrap on this
host's Linux 5.15 kernel without `/dev/kvm`. Sandbox/application processes
were started in a verified outer cgroup. The probe mounted selected host tool
and system-library trees read-only; production uses the immutable image instead. `--ignore-cgroups=true` was used only
because the enclosing probe scope already imposed the recorded limits; production
must never use it without equivalent verified whole-job enforcement.

- 26/26 filesystem/runtime checks passed: unchanged absolute workspace path,
  sibling account invisibility, external-link rejection, internal relative links,
  no host HOME or Docker socket, nested writes, rename/delete, binary bytes,
  project JSON, notebook JSON, SQLite WAL, Git initialization/staging/commit with
  no remote, private loopback HTTP, host loopback separation, and executable
  startup for Node/Python/Git/osd/OpenCode/Claude/Codex.
- 14/14 real worker checks passed: osd and OpenCode readiness, project create/list,
  project-scoped session creation, account file listing, preview ticket, binary
  download, traversal/external-link/foreign-directory rejection, and a positive
  own-file raw-API read paired with an unsuccessful foreign-file raw-API read.
  The foreign raw read returned 500; production policy must reject it cleanly
  before forwarding rather than treating this response as the desired API.
- The real worker probe's observed enclosing-cgroup peak was 486,068,224 bytes
  (approximately 463.6 MiB). This includes probe activity and charged file cache;
  it is not a production per-user capacity estimate or a real-model benchmark.
- Probe limits were 768 MiB for basic checks and 1,024 MiB for worker checks,
  with 128 MiB swap. Runtime version commands do not establish complete CLI
  compatibility: model turns, Codex's nested restrictions, streamed adapters,
  attachment delivery, cancellation, controlled external networking, and
  filesystem-change notifications remain release gates.

Local JSON results are retained in the ignored probe `results/` directory. No
probe sandbox processes remained after the successful run. These experiments
support proceeding with the design; they do not establish production readiness.

## Options and decision

| Option | Benefit | Limitation | Decision |
| --- | --- | --- | --- |
| Tool permissions and path checks alone | Small application changes | Shell, plugins, raw APIs, and child programs remain outside this boundary | Defense in depth only |
| Complete bubblewrap policy per account | Locally available and filesystem probes worked | Shared host kernel; mount/network policy must be maintained correctly | Explicit internal fallback candidate only; never automatic downgrade |
| gVisor sandbox per account | Extra kernel boundary and successful local worker prototype | Requires launcher, transport, controlled egress, and adapter acceptance | Selected Web target |

Use gVisor Systrap and a trusted, immutable runtime image. Pin image and runtime
versions/checksums; assess security support before deploying the prototype version.
Do not introduce Kubernetes for this host. Firecracker is not selected because
this host has no KVM device. Do not register runsc with or restart the currently
running Docker daemon as part of the compatibility investigation.

## Complete file and project capability inventory

The observations below refer to the audited working tree. Existing uncommitted
changes are preserved; source capability does not imply deployed acceptance.

| Capability | Current Web behavior / implementation evidence | Isolation design and acceptance |
| --- | --- | --- |
| Account file explorer, breadcrumbs, folder navigation | `FilesPage`, `listDir`, `/v1/fs/list`; base scope includes account projects/sessions | Retain base scope with trusted account root; directory results stay root-relative; hidden-file filters remain |
| Viewed-session file explorer | `SessionFiles`, explicit session directory | Require owned session/directory; switching browsers or sessions cannot change another client's scope |
| Artifact basename resolution | `resolveArtifactPath`, `locate_under` searches the selected tree | Keep scope and search bounds; never fall back to another account or platform state |
| File previews, including PDF/images/text/tables/office/science formats | Web ticket URLs and browser renderers in `FilePreviewInspector` | Retain MIME/byte behavior and per-view directory; supported previews must pass browser tests, unsupported formats still download |
| Raw original downloads | Ticket-backed stream, download response header rewriting | Stream with backpressure, no whole-file buffering; identical bytes for text/binary and refreshed tickets |
| HTML/SVG and active content | HTML server CSP sandbox; browser-specific renderers | Opaque-origin sandbox or inert text, never same-origin scripts; audit SVG as well as HTML; no credentials in URLs |
| Copy relative file path | File context menu | Retain; native absolute/reveal/open commands stay hidden |
| File content refresh after agent writes | Viewer reloads; desktop auto-save has conflict tracking | Web remains read-only except separately implemented features; re-read the same owned scope |
| Text/code editing and save | `writeWorkspaceFile` is Tauri-only; Web editor toggle hidden | Do not silently add writes. Keep read-only Web preview; hide unsupported save/edit affordances |
| Manual file/folder create, rename, move, copy, delete | Mostly native helpers or agent tools; no general Web mutation API in audited gateway | Agent actions run inside sandbox; do not invent a file-manager CRUD feature. Future APIs must reuse the bounded contract |
| New Markdown/Notebook helpers | `newFile.ts`, native workspace writes and panes | Remain desktop-only; inspect command palette/tab menus for exposed dead controls |
| Notebook viewing | `NotebookEditor.readRaw` supports Web ticket fetch | Preserve raw notebook data/output rendering; enforce read-only cells and hide run/save/add/delete controls in Web |
| Notebook execution/Jupyter/native interpreter selection | Tauri kernel/Jupyter helpers | Stay hidden; agent Python execution remains available inside sandbox without adding a host kernel API |
| Large-file inspection | `probeLargeFile` is Tauri-only | Download remains available; hide native probe/external-open actions. Agent probes run sandboxed and bounded |
| Project creation | `createProject` Web route seeds metadata/harness and best-effort Git | Keep `/v1/projects`; execute scaffold/Git in sandbox; preserve ID and actual directory |
| Project listing/search/recent ordering | Project gateway list; UI groups session directories | Keep metadata and grouping; reject external source roots even if project JSON calls them registered |
| Project open and new conversation in project | Browser-scoped workspace/draft; no host workspace switch | Validate selected path, retain client-local scope and session directory; no implicit global workspace mutation |
| Project display rename | Tauri-only helper; project page hides native actions, sidebar still has related menu | Add bounded metadata PATCH by owned project ID; rename display only, do not move directory/history |
| Project pin/unpin | Tauri-only helper; sidebar contains pin control | Same metadata PATCH; persist pin and test refresh, touch, and failure handling |
| Project removal | Native implementation: created-project marker removal; imported-copy deletion; in-place stub deletion | Web removal is explicitly metadata-only with file preservation; do not reuse imported-copy recursive deletion in Web |
| Native project import, copy/in-place, folder picker | Native helpers and sidebar import workflow | Keep hidden. No host paths or arbitrary external mounts. Future browser upload/archive import is a separate feature |
| Legacy account-root projects | Rust scans both base and `projects/` | Preserve without relocation; mark external in-place imports unavailable, never mount their source automatically |
| Move conversation into project | SDK sends `moveChanges:false`; CLI updates directory | Preserve metadata-only move; owned source/destination, reject active turns, update children/associations consistently; files stay put |
| Session create/fork/title/archive/delete/history | SDK and managed CLI routes | Ownership on every ID, keep native IDs and persistence; deleting chat does not implicitly delete project files |
| Fresh session workspaces | Native dated workspaces; Web loose drafts currently use account base | Preserve current Web behavior; adding dated Web workspaces is outside this migration |
| Browser/session/project path matching | Absolute paths and `pathKey` | Preserve current account absolute prefixes inside sandbox and public metadata for compatibility; paths confer no authority |
| Git initialization/checkpoints | Core Git helpers and osd watcher | Run all Git in tenant sandbox; preserve refs/index/branch behavior, no remote or push; checkpoint the actual changed project/session root |
| Provenance/environment lockfiles/artifact versions | Core `.openscience` files; many UI calls remain Tauri-only | Preserve data/schema; no automatic expansion of Web version APIs; environment probes run sandboxed |
| Research briefs/reports/artifact hashes | Platform `ResearchTasks` currently reads/writes host workspace | Move workspace I/O and hashing to tenant file service; retain platform task ownership/lease data outside sandbox |
| Runs query/log browsing | Web `/v1/runs`, `/v1/runs/query`, `/v1/runs/log` | Keep only account index/logs; hash or metadata never authorizes an arbitrary filesystem path |
| Skills discovery/install/project ancestor traversal | OpenCode/native CLI catalogs; `skills.mjs` uses per-user HOME and workspace ancestry | Built-ins read-only, personal skills private, project traversal stops at account root; location links stay inside mapped mounts |
| MCP/hooks/plugins/browser/artifact generators | Config and agent tool execution | Local processes in sandbox; no host filesystem MCP or host browser profile fallback; external services require approved scoped broker |
| Session Markdown export / mirror and import | History export uses native folder picker; native mirror helpers | Keep native-only controls hidden, preserve existing mirrored data; no new browser archive/export feature |
| Conversation uploads and history attachments | Separate approved spec; in-progress `attachments.mjs`, attachment routes/turns and browser controls added during audit | Original store/metadata outside sandbox; deliver only owned working copies; preserve current stdin/image/history/lifecycle contracts and verify deployment separately |
| Temporary files/dependency caches/installed environments | Agent/native tool scratch and per-user directories | Private tmp/cache/HOME; installs confined to tenant and require applicable approvals; no writable shared dependency cache |
| Native reveal/default app/base-folder change/SSH host integration | Tauri functions | Stay hidden in Web; no sandbox workaround that grants host access |

The audit found specific Web gaps: sidebar project metadata controls lack Web
backends; notebook rendering supports Web reads but retains native editing/run
code paths; some large-file error controls are native-only. This migration repairs
those exposed controls where needed and adds the small project metadata API.
It does not implement full desktop feature parity.

## Trust boundaries and process placement

1. **Platform outside the sandbox:** authentication, user-to-sandbox registry,
   managed model catalog, task lease records, CLI conversation envelope storage,
   original attachment storage, and authenticated public HTTP routing.
2. **Minimal host launcher outside the sandbox:** creates a sandbox from a fixed
   image and trusted account registry, configures private networking/cgroups,
   starts the fixed worker/runner, and stops/reaps the account's processes.
3. **Tenant sandbox:** osd/OpenCode plus a small private runner for Claude/Codex,
   local MCP/hooks/plugins, Git, file service, artifact hashing, and computation.
4. **Model/egress services outside:** narrowly scoped inference proxy and public
   network proxy. Their sockets are not general platform or launcher interfaces.

The launcher is the privileged component, not the general Web request router.
Use a local authenticated Unix interface with restricted filesystem permissions.
Requests name a validated account and permitted action, never caller-supplied OCI
configuration, host mount source, executable, shell command, image, or namespace.
Generate mounts from a private registry, verify source ownership/real directory,
reject unexpected nested mounts, and create empty intermediate parent paths.
Expose no Docker socket, launcher socket, host `/proc`, device nodes, or cgroup
control files to agent processes. Avoid giving the Web service the Docker group
or unrestricted `sudo` as its production orchestration mechanism.

Mount creation must resist replacement of a source between checking and mounting:
trusted ancestors are not tenant-writable; securely acquire and verify the exact
source inode under an already-open trusted root; use held handles/the selected
mount API rather than re-resolving an untrusted source string.

## Storage and path compatibility

Keep existing account workspace contents and absolute paths. For example, mount
only `.../workers/instances/user-A/workspace` at that exact absolute destination,
not `.../workers`, `.../instances`, or the whole platform data directory. The
parent tree inside the sandbox is newly created empty image/mount structure;
B's workspace and the host repository do not become visible through it.

A trusted per-account mount manifest distinguishes:

- workspace: account-owned persistent files;
- runtime state: OpenCode database/cache and mutable native CLI histories;
- private HOME: skills/cache and CLI discovery paths;
- sanitized per-runtime configuration: only this runtime's validated fields;
- image resources: read-only pinned tools, harness, libraries, and built-in skills;
- bounded tmp and job scratch.

Preserve necessary same-account absolute symlink targets between private skills,
profile/history directories, and HOME by mounting only the referenced private
subtrees at their original destinations. Do not mount `cli-runtime/users/<id>`
as a whole: its platform-owned `sessions.json` is not agent-authoritative state.
Introduce a separated native-state layout if existing paths cannot safely be
mounted individually. Preserve native session IDs and test resume.

Do not mount old secret-bearing configurations until sanitized. Existing source
configurations remain in a restricted migration backup outside agent mounts.
Retained workspaces may contain scripts/venvs with external absolute paths; keep
bytes/history, report inaccessible dependencies, and recreate environments from
lockfiles inside tenant storage. Never grant an extra host mount to make one work.

Filesystem service roots are explicit: account base or an owned session/project
subdirectory. No host active-workspace fallback may redirect a viewed session.
Web project metadata cannot widen the root with `source_path` or a forged ID.
The managed account root comes from the trusted launcher manifest; runtime files
such as `base-workspace.txt` and `active-workspace.txt` are not authority. Pin the
base read-only and constrain every session scope independently. Registered-project
exceptions remain available for desktop only.

Allow internal data symlinks only when secure resolution remains in the selected
root. Reject absolute/magic links and external targets for public file access.
Control/metadata files require no-follow resolution and a trusted registry or
validated schema; workspace metadata is not security authority. File reads must
select regular files, not FIFOs/devices/sockets.

Use directory-descriptor-relative operations with `openat2` restrictions on Linux
(or an equivalent race-safe helper) in the sandbox file service. Open the file
before issuing a ticket or re-resolve it securely on redemption; do not check a
path, retain it indefinitely, and later open an unchecked substituted target.
Writes/deletions use securely opened parents and bounded relative names.
Platform code must not read/write/hash user workspace paths directly after cutover.

## Gateway and transport contracts

Create a positive route/method contract derived from `OpenCodeClient` and current
Web helpers. Unknown raw runtime routes are denied by default.

| Public route group | Required validation |
| --- | --- |
| `/v1/whoami`, `/v1/projects`, project metadata PATCH/removal | Authenticated account, scoped project registry, schema and length limits |
| `/v1/fs/list`, `/v1/fs/ticket`, `/v1/fs/read` | Explicit account/session root, bounded file name, regular file, owned ticket |
| `/v1/runs`, `/v1/runs/query`, `/v1/runs/log` | Account store, bounded queries, known log hash |
| `/session`, `/experimental/session`, `/session/:id` and used descendants | Owned IDs, runtime, directory, operation-specific body |
| Move-session endpoint | Owned source/children/destination; idle requirement; `moveChanges:false` |
| `/event`, `/question`, `/permission` and reply/reject endpoints | Account and optional owned directory/request ID; no foreign event forwarding |
| `/agent`, `/command`, `/skill`, provider/model catalog reads | Sanitized per-account response; no credential/config files |
| `/global/config` model-only write | Administrator-enabled model only; reject extra fields |
| `/instance/dispose` if Web reconnect needs it | Owned idle instance; cannot tear down another task; otherwise hide the caller |
| `/api/research/*`, `/api/runtime`, future attachment APIs | Platform-owned user/session identity and their existing explicit contracts |

Session shell, slash-command, summarize, revert, fork and prompt routes stay
available only where the SDK/Web actually needs them and receive the same
ownership/schema checks. Prompt file parts accept approved data/attachment
representations, not arbitrary `file://`, host paths or remote fetch URLs.
Raw `/file/*`, `/find/*`, `/path`, native-auth/config writes, PTY, and unneeded
control-plane endpoints are blocked; the current SDK does not need raw file
reads for its Web file explorer. Directory-capable query, body and header inputs
(including runtime-specific directory headers) are checked or removed, not merely
one `directory` query parameter. Normalize/decode routes once; reject ambiguous
encodings and conflicting inputs. Cookie-authenticated writes enforce origin/CSRF
protection; client Bearer tokens do not replace authenticated account ownership.

Preview tickets are short-lived, random, account-bound and single-file scoped.
The outer platform still requires the current user's authentication and routes
the ticket to that user's worker. Keep preview credentials out of URLs; bound
streaming and MIME/CSP headers remain mandatory. Web project removal is an
explicit metadata-only operation that preserves original files and conversations.

Private sandbox networking makes host `127.0.0.1` different from sandbox
`127.0.0.1`. OpenCode continues to bind its sandbox loopback. Add a restricted
explicit bind-address option for the osd gateway and runner to listen on the
sandbox's assigned private interface; the host platform connects only to those
ports. Do not solve this by using host networking or public `--lan` binding.
Fixed, launcher-managed veth/namespace routes and firewall rules allow platform
inbound traffic, proxy traffic, and responses; deny peer tenants, other host
services, private networks and metadata endpoints, for IPv4 and IPv6.

The private runner accepts only platform-authenticated, account-scoped jobs:
validated runtime/model, server-selected cwd/config, prompt input, timeout, and
cancel. It starts fixed image binaries, preserves stdout/stderr/exit streaming,
and owns process groups/job bookkeeping. No public arbitrary-exec endpoint.
Native history stays sandboxed; platform session-envelope/history records remain
outside. Tenant code can tamper with its own work, but cannot control the host
launcher or select another tenant.

## Credentials and external networking

Replace copying administrator secrets with sanitized runtime profiles pointing
to an inference broker. Broker credentials are revocable and restricted to the
account, runtime/provider, enabled models, API operations, concurrency and quota.
The upstream key stays outside tenant mounts/env. Treat the restricted token as
visible to arbitrary code in that tenant; it must confer no administrative rights.

Preserve SSE/streaming and API compatibility needed by each configured provider
(Anthropic Messages/OpenAI Responses or compatible endpoints). Strip conflicting
upstream authorization; reject arbitrary upstream URLs and unsupported routes.
Profile revision and native-session identity logic must distinguish model/catalog
changes, token renewal, and true upstream identity changes; rotating a restricted
broker token alone must not silently strand existing native history.

Legacy OAuth/subscription profiles must be tested against the broker contract.
If a configured credential mode cannot be proxied safely, mark that assistant
unavailable with a clear administrator-facing explanation. Do not expose its
shared credential or silently fall back to unrestricted execution.

Public scientific HTTP(S), package registries, and model inference are separate
capabilities. A proxy resolves public destinations itself and rejects private,
loopback, link-local, metadata, IPv4-mapped IPv6 and rebound addresses on every
connection/redirect. Direct tenant egress bypass is blocked. Preserve TLS for
public destinations; model proxy handles only its configured protocol. Validate
package installers/tool/browser clients that ignore proxy variables. SSH, Modal,
GPU, native computer use and host browser profiles receive no automatic access;
existing remote-compute capabilities require an explicit separately scoped
connector and applicable approval. Browser/local MCP processes stay sandboxed.

## Resource limits and lifecycle

One scheduler owns live sandboxes and executing jobs across OpenCode/Claude/Codex.
On this 3.3 GiB host, start with one admitted active tenant sandbox and one active
agent job; other requests wait with a visible queue or receive a retriable capacity
response. File operations share the tenant slot; login/static pages stay available.
This initial capacity is a design default, not a measured multi-user guarantee.

Initial per-tenant combined budget: `memory.high=640 MiB`, `memory.max=1,024 MiB`,
`memory.swap.max=128 MiB`, `pids.max=256`, and a bounded execution timeout.
Verify limits on the whole sandbox/runner/gofer/children before accepting a job.
An unavailable controller, insufficient host reserve (at least 600 MiB available),
or excessive memory pressure prevents admission. CPU quota must be verified in
the actual launcher/service cgroup; the current user scope did not expose cpu.max,
so setting a property alone cannot establish enforcement. Use a launcher-owned
cgroup with enabled controllers or reject deployment until enforcement works.

Enforce disk/inode quota with a real quota-capable tenant volume before public
rollout; workspace usage scans alone do not stop an agent filling host storage.
If a quota volume is needed, back up and migrate the account data into it while
mounting it at the same existing workspace destination. Verify filesystem quota
support on this host before proposing a production cutover; the current probes
did not establish it.
Set limits for upload/preview/hash/list/probe concurrency and request bodies.
Container memory limits alone do not bound disk or all process creation.

Coordinate admissions with the existing guarded-build lock/reserve: no Web build
competes with an admitted heavy agent job on this host. All implementation builds,
tests, typechecks and lint still run through verified bounded package scripts.
The final source refresh includes the guarded `platform-test` package path;
verify its actual cgroup limits before running platform tests and preserve the
in-progress integration. A configured script is not evidence of enforced limits.

Cold-start health requires osd gateway AND OpenCode health, not `/v1/whoami` alone:
the real probe observed a ready gateway before the sidecar accepted requests.
Runner health and broker policy are required for managed CLI execution. Sandbox
failure, missing runtime, quota exhaustion and cancellation never cause host
fallback or a more permissive container. Preserve files/history across shutdown.

Idle eviction happens only without active jobs, protected streaming requests,
pending uploads or required ownership claims. Cancel closes the job process group
and verifies descendants have stopped. Disable/delete user stops sandbox jobs
and invalidates its broker capabilities. Registry records include sandbox identity
and generation; after restart reconcile actual launcher state without trusting
stale PIDs or briefly attaching one user's requests to another worker.

## Reproducibility and concurrent file management

Keep Git and environment capture inside tenant limits, because repository config,
filters/hooks and tool execution can run code. Use bounded internal worker tasks
for project initialization/checkpoint requests. Preserve dedicated snapshot refs,
separate index, branch and user staging behavior; never set a remote or push.

Fix snapshot dispatch for Web account trees: translate a changed path to its
validated project/session workspace root, debounce per root, and avoid writing an
account-root repository instead of the nested repo. Test inotify support, external
agent writes and ignored `.git` activity under gVisor. Trigger a bounded checkpoint
on job completion as a fallback, for all three runtimes; do not claim every file
write is durably committed when checkpoints are best-effort.

Concurrent sessions may intentionally share a project. File operations must be
atomic where applicable; metadata writes serialized by project; session movement
refused during active execution. Project rename changes only display metadata.
Project removal drops the registry/marker without deleting workspace data in Web.
A running job is never silently redirected to a different directory.

Research protocol creation/read/update/hashing uses tenant file RPC with owned
session scope. Platform-owned lease/mode/checkpoint records remain outside agent
mounts. Treat reported artifact paths/content as untrusted data and keep byte/
time limits; no host subprocess is invoked to inspect a research artifact.

## Attachment integration boundary

The approved conversation-attachment design remains separate and must be
implemented against this boundary, not against arbitrary host workspace paths.
Keep originals and authoritative user/session/message associations outside the
sandbox; allow only explicit, owned attachment IDs. Deliver original bytes or
runtime-required working copies through scoped materialization, not by mounting
the entire original store. The in-progress materializer uses
`attachments/users/<user>/working/<session>`; migrate that writable working tree
into sandbox-owned storage at a compatible destination, or copy through file RPC.
Do not mount `attachments/users/<user>` (it also contains original blobs and
authoritative metadata), and do not leave privileged host copy/stat operations
following a tenant-writable working tree. The platform reads originals via its
private store, then the tenant file service creates/opens working copies safely.
Preserve Claude streamed JSON stdin and Codex `--image` path delivery as well as
OpenCode image parts; success of upload alone is insufficient. Preserve refresh/download/retry/removal semantics and
native image input verification for each runtime.

Generic file/project endpoints cannot enumerate or download original attachment
storage. Metadata-only session moves retain original attachment owner IDs and
update working-reference resolution deliberately. Deleting a conversation cleans
its attachments, not a shared project directory. Runtime-visible working copies
are untrusted/account-visible files; this per-account sandbox does not enforce
mutual isolation of arbitrary code running in same-account conversations. If
that stronger property is required, split execution/storage per conversation and
review the attachment spec rather than claiming directory naming enforces it.

## Rollout and failure handling

1. Add positive route/path/ownership policy and exposed-control repairs under
   existing Web contracts. Keep a failing synthetic cross-account regression.
2. Implement launcher/image/private runner/transport and verified quotas in a
   test deployment, with no production user traffic. Both manager entry points
   must use the same sandbox authority.
3. Integrate sanitized broker profiles, public-egress policy, file RPC, research,
   skills and correctly scoped snapshots. Run all acceptance gates below.
4. For each account, drain active turns/uploads, stop the old worker, snapshot
   state, sanitize secrets, validate private mounts and start the sandbox with
   the same directories/native IDs. Back up privately before any state rewrite.
5. Route that account only after joint health and functional checks pass. Keep
   logs free of keys, prompt-derived secrets, credential bodies and full private
   launcher configurations. Do not log worker gateway tokens (the legacy server
   prints one on startup); redact or remove the behavior for managed workers.
6. Failed migration leaves the account temporarily unavailable and its data
   recoverable. UI/data rollback is possible; unrestricted host agent execution
   is not an automatic rollback mode. Never serve an incomplete Web build.

A public release cannot precede an unimplemented network/broker/resource gate.
Local offline filesystem success is sufficient to design, not to deploy.

## Acceptance matrix

| Area | Required result |
| --- | --- |
| Positive controls | A's own reads/writes/projects work in the same test that rejects B |
| Filesystem boundary | Absolute/relative traversal, symlink chains/swap races, magic links, special files, forged metadata, mount-source replacement and external in-place projects cannot widen account scope |
| Raw/API boundary | Unknown routes/methods, file/find/path, directory headers/body/query, encoded routes, config/auth, PTY and control-plane requests fail before arbitrary forwarding |
| Process boundary | Python/Shell/hooks/MCP/plugins/Git filters cannot see host/peer files, process namespace, control sockets, credential originals or cgroup controls |
| Network boundary | Real platform-to-worker SSE works; peer/host/private/metadata IPv4/IPv6 and redirect/rebinding bypasses fail; approved public fetches and package clients work |
| Model adapters | Real bounded OpenCode/Claude/Codex turn writes/reads a synthetic owned file, streams, cancels and resumes; nested Codex restrictions tested without implicit unsafe downgrade |
| Credentials | Shared API/OAuth credentials absent from mounts/env/output; broker rejects foreign tenant/model/URL/route, quota bypass and stale revoked tokens |
| UI compatibility | File tree, scoped preview, binary download, project create/open/grouping, metadata rename/pin/remove and session move at 1280px/390px; no native-only dead controls |
| History/data | Existing absolute paths, metadata, OpenCode SQLite and native histories reopen after cold restart; filename/Unicode/link cases preserve byte content |
| Reproducibility | New/legacy project snapshot refs stay correct; actual nested job writes checkpoint inside sandbox; no remote, branch or staging mutation |
| Research/attachments | Correct session report/hash and approved attachment delivery/history; generic APIs cannot access private originals or platform task state |
| Resources | Actual cgroup/CPU/disk/inode enforcement, queue and idle eviction; controlled OOM/disk-full/process exhaustion cannot break login or deployed Web bundle |
| Failure isolation | Launcher/broker outage, startup timeout, stale registry, cancellation, runtime switch and migration failure never execute on host or route to another tenant |

Automated tests use synthetic users/fixtures and the package memory guard.
Actual runtime/container and browser acceptance run serially in verified bounded
scopes. Real-model acceptance uses configured scoped test credentials and bounded
requests after the broker is implemented, not shared administrator keys in probes.

## Implementation ownership and decomposition

One design covers the isolation contract; implement it as dependent bounded work:

- Platform policy and file/project contracts: platform router, SDK helpers, small
  metadata endpoints, hidden Web controls, synthetic ownership tests.
- Sandbox lifecycle: new launcher/runner, pinned image, cgroups/quotas/network,
  `WorkerManager` and `CliRuntimeManager` adapters; no direct spawn fallback.
- Broker and workspace integration: sanitized profiles, scoped egress, research
  file RPC, skills/history links, previews/tickets, Git dispatch, attachments.
- Acceptance and staged migration: offline and real-model gates, browser evidence,
  per-account drain/backup/cutover/recovery, progress milestone.

Likely existing paths: `services/platform/src/{main,worker-manager,cli-runtime,
cli-profile,platform-server,research-tasks,skills}.mjs`, `crates/osd-core/src/
{gateway,project,artifact_file,git_snapshot,runtime}.rs`, `crates/osd-cli/src/
{args,server}.rs`, `apps/desktop/src/lib/{tauri,runtime,artifactFile}.ts`, and the
corresponding project/sidebar/notebook/preview controls and tests. Coordinate
`services/platform/src/{attachments,attachment-turns,attachment-input,
attachment-routes}.mjs` and the new browser attachment helpers with the
independent in-progress attachment work; do not overwrite those changes. New launcher,
runner, file-policy and broker modules need separate narrow responsibilities;
do not expand the existing request router into an orchestration framework.

Implementation-plan preparation follows written-spec review under Superpowers.
Preserve other working-tree changes; commit only approved design/progress work.

## Primary references reviewed on 2026-10-02

- https://gvisor.dev/docs/architecture_guide/security/
- https://gvisor.dev/docs/architecture_guide/intro/
- https://gvisor.dev/docs/user_guide/install/
- https://gvisor.dev/docs/user_guide/production/
- https://github.com/google/gvisor/releases/tag/release-20260928.0
- https://kubernetes.io/docs/concepts/security/multi-tenancy/
- https://docs.docker.com/engine/security/
- https://docs.docker.com/engine/security/rootless/
- https://github.com/containers/bubblewrap
- https://man7.org/linux/man-pages/man2/openat2.2.html
- https://www.anthropic.com/engineering/how-we-contain-claude
- https://opencode.ai/docs/permissions/

The gVisor sources describe its kernel boundary, resource grants, and workload
limitations. The OCI/cgroup/network policies above are SciKeel design choices,
not capabilities automatically supplied by installing runsc.
