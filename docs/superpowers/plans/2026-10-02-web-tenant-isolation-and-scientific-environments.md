# Web Tenant Isolation and Scientific Environments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not spawn agents unless the user separately authorizes delegation.

**Goal:** Prevent cloud agents from accessing the host or another account while preserving current Web file/project workflows and providing shared, reproducible scientific dependencies.

**Architecture:** Each account runs its worker and all executable tools in one gVisor sandbox. Authentication, authoritative ownership, approvals, attachment originals and credential/package brokers remain outside; a verified immutable science image is shared, while project environments and writable caches are private. A single scheduler enforces the small host's resource budget and migration never falls back to host execution.

**Tech Stack:** Existing Node.js platform, Rust osd core/CLI, React/TypeScript SDK, Linux gVisor Systrap/OCI/cgroup v2, quota-backed storage, Python 3.12/uv, a bounded devpi public mirror and existing guarded pnpm scripts.

---

## Approved scope, evidence and execution rules

The isolation direction and the request to integrate dependency planning were approved on October 2, 2026. Companion specification: `docs/superpowers/specs/2026-10-02-web-tenant-execution-isolation-design.md`. This document is a plan, not evidence that the application is isolated. The earlier synthetic probes passed 26 filesystem/runtime checks and 14 real worker checks; their approximately 464 MiB worker scope peak does not establish real-model capacity, CPU quotas, disk quotas, approval compatibility or a production networking configuration.

Work sequentially in an isolated worktree established with `superpowers:using-git-worktrees`. The original tree contains active research, skills and attachment work. Read its final interfaces before each integration task; preserve all unrelated changes. Do not revert or stage someone else's patch. Integrate the reviewed attachment/research prerequisites before Task 13 and combined acceptance. Tasks 4–10 use explicitly marked synthetic image fixtures; Task 11 produces the production runner image, and Tasks 12–18 validate the combined system. Pin the supported runtime versions actually selected by `OPENCODE_VERSION` in `scripts/dev/fetch-opencode.sh` and the CLI profile resolver, rather than treating the probe's binaries as authoritative.

All new files are English. The deliverable is the gateway Web client at desktop and phone widths; preserve shared desktop compilation and existing desktop filesystem behavior. Do not introduce a Web Jupyter kernel or broad desktop redesign. Do not create another planning document. Record actual milestones in `PROGRESS.md`, newest first, and commit only this task's lines when that file has independent edits.

Every heavy command below goes through a package script and the existing bounded guard. Task 1 adds the missing bounded Rust and sandbox-probe entrypoints; do not run raw Cargo, Vite, Vitest, parallel heavyweight tasks or an unconstrained local Docker build. Image construction runs on an isolated CI builder. Production deployment is a final separately authorized action after the reviewable implementation and all release gates exist.

The tasks form one dependency chain, not independent feature launches. Keep `managedSandbox` disabled for production until Tasks 1–18 pass. Intermediate commits are testable without making claims about production isolation.

## Ownership and fixed interfaces

| Owner | Authoritative data | Agent access |
| --- | --- | --- |
| Platform | Account-to-instance map, session envelopes, project registry, approvals, research leases, attachment originals, enabled models, upstream secrets | Through authenticated, narrow operations only |
| Launcher | Installed image digests, derived mount manifests, container generations, networking/cgroups/quota records | No control socket or configuration mount |
| Sandbox | Workspace, private runtime history/SQLite, private HOME/skills/cache, job scratch | Account-local read/write subject to quotas and approval |
| Image | Versioned Python/tools/common libraries and built-in skills | Read only |
| Public mirror | Public PyPI index/archive artifacts | GET/HEAD via package broker; no cache filesystem access |

Account isolation permits two projects in the same account to see the account's mounted files. Do not promise OS isolation between conversations. Attachment/session authorization remains stricter at platform APIs; shared-account execution cannot make an already authorized working copy secret from arbitrary code in that same account.

Use these contracts across all tasks; implement validators beside their owner rather than passing an arbitrary host path between modules:

```js
// tenant-policy.mjs: generated from authenticated platform records only.
// context = { userId, instanceId, generation, workspaceDir, sessionId?, directory? }
// Public body/query/header data cannot override userId, instanceId or workspaceDir.

// sandbox-client.mjs, Unix socket outside every sandbox:
// register({instanceId, userId}) -> {instanceId, generation}
// start({instanceId, generation, imageDigest}) -> {endpoint, runnerEndpoint, generation}
// stop({instanceId, generation, reason}) -> {stopped:true}
// inspect({instanceId}) -> {generation, state, limits, imageDigest}
// No caller-supplied executable, environment, mount list, port or command string.

// workspace-rpc.mjs, authenticated internal runner requests:
// files.call(context, {op, root:'account'|'session'|'project', relative, ...args})
// op = list | read | writeAtomic | hash | mkdir | removeWorkCopy |
//      projectCreate | projectPatch | projectRemoveMetadata | checkpoint |
//      environmentInspect | environmentInstall
// Authority comes from context/registry, never workspace metadata.

// runner HTTP, isolated internal interface; platform-issued per-generation auth:
// GET /health -> {generation, osdReady, opencodeReady, runnerReady}
// POST /jobs -> {jobId}; body {runtime, sessionId, nativeId?, directory, prompt,
//   model, variant?, attachmentRefs?, environment, approvalRefs}
// GET /jobs/:id/events -> bounded SSE; POST /jobs/:id/cancel -> descendants stopped
// POST /files -> scoped operation above; binary reads/writes use streaming bodies.
// Runner arguments are assembled from fixed managed runtime adapters, never a
// public raw command/exec endpoint. Model tools still execute inside the sandbox.
```

File operations allow at most 1 MiB JSON control bodies, 10,000 list entries, 128 KiB research JSON and a 30-second control timeout. Retain existing smaller endpoint limits. Binary transfer is streamed with its existing upload/download quotas, backpressure, cancellation and owned ticket expiry. Do not buffer whole archives in platform memory.

### File ownership map

| Unit | New files | Existing integration points |
| --- | --- | --- |
| Test/resource harness | `scripts/dev/sandbox-probe.mjs`, `services/platform/fixtures/sandbox-rig.mjs` | `package.json`, `scripts/dev/safe-desktop-task.mjs` |
| Platform policy | `services/platform/src/tenant-policy.mjs`, `services/platform/src/runtime-route-policy.mjs` | `platform-server.mjs`, SDK contracts |
| Secure file core | `crates/osd-core/src/file_policy.rs` | `artifact_file.rs`, `gateway.rs`, `project.rs`, `lib.rs`, core Cargo manifest |
| Scientific image | `runtime/sandbox/image/{Dockerfile,pyproject.toml,uv.lock,tool-lock.json}`, `runtime/sandbox/image-manifest.schema.json`, `scripts/dev/stage-sandbox-image.mjs` | New `.github/workflows/sandbox-image.yml`; root package scripts |
| Host boundary | `crates/osd-sandbox-host/{Cargo.toml,src/main.rs,src/protocol.rs,src/registry.rs,src/lifecycle.rs,src/network.rs,src/quota.rs}`, `services/platform/src/{sandbox-manifest,sandbox-client}.mjs` | Root Cargo workspace and lock; new systemd unit |
| Brokers | `services/platform/src/{egress-broker,model-broker,package-broker}.mjs`, `services/platform/infra/scikeel-package-mirror.service`, `services/platform/infra/scikeel-sandbox-host.service` | `main.mjs`, `cli-profile.mjs` |
| Runner | `runtime/sandbox/{runner,file-rpc,cli-jobs}.mjs` | osd CLI args/server and runtime adapters |
| Lifecycle | `services/platform/src/sandbox-scheduler.mjs` | `worker-manager.mjs`, `cli-runtime.mjs`, guarded-build coordination |
| Workspace/environment adapters | `services/platform/src/{workspace-rpc,environment-approvals,project-environments}.mjs` | Research, attachments, skills, Git and run metadata |
| Web | Corresponding behavioral tests, not a new settings subsystem | Existing project/sidebar/file/notebook/preview controls; SDK |
| Migration/acceptance | `scripts/dev/migrate-tenant-sandboxes.mjs`, focused platform/browser acceptance files | Existing operational configuration and `PROGRESS.md` |

New paths in this table are planned files, not current capabilities. Add each to its responsible task; do not create unimplemented empty scaffolding commits.

## Task 1: Establish bounded tests and a synthetic sandbox acceptance harness

**Files:** Modify `package.json`, `scripts/dev/safe-desktop-task.mjs`. Create `scripts/dev/sandbox-probe.mjs`, `services/platform/fixtures/sandbox-rig.mjs`, `services/platform/test/sandbox-harness.test.mjs`.

- [ ] Write the first harness test. Export `assertScopeLimits(actual)` from the probe: accept numeric parsed cgroup values, not systemd command success. Reject `max`, missing controllers and a child outside the owned cgroup.

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertScopeLimits } from '../../../scripts/dev/sandbox-probe.mjs';
test('a successful command is insufficient without enforced limits', () => {
  assert.throws(() => assertScopeLimits({memoryMax:'max'}), /unenforced/);
  assert.throws(() => assertScopeLimits({memoryMax:1073741824,
    swapMax:134217728, pidsMax:256, cpuMax:'max 100000', childrenOwned:true}), /unenforced/);
  assert.doesNotThrow(() => assertScopeLimits({memoryMax:1073741824,
    swapMax:134217728, pidsMax:256, cpuMax:'100000 100000', childrenOwned:true}));
});
```

- [ ] Run `pnpm platform:test test/sandbox-harness.test.mjs`. Expect FAIL because the exported validator does not exist; this is a cheap guarded test, not a launch.
- [ ] Add root scripts `sandbox:core:test`, `sandbox:core:check`, `sandbox:probe`, `sandbox:image:stage`. Extend the guard with fixed `core-test`, `core-check`, `sandbox-probe`, `sandbox-image-stage` branches. Rust test/check allow only `osd-core`, `osd-cli`, `osd-sandbox-host`; no desktop Cargo build. Preserve the lock, existing limits and host-pressure stop. Implement validator:

```js
export function assertScopeLimits(v) {
  if (!Number.isSafeInteger(v.memoryMax) || v.memoryMax > 1073741824 || v.memoryMax <= 0 ||
      !Number.isSafeInteger(v.swapMax) || v.swapMax > 134217728 || v.swapMax < 0 ||
      !Number.isSafeInteger(v.pidsMax) || v.pidsMax > 256 || v.pidsMax <= 0 ||
      !/^\d+ \d+$/.test(v.cpuMax ?? '') || !v.childrenOwned) {
    throw new Error('unenforced sandbox limits');
  }
}
```

- [ ] Implement the rig using temporary synthetic account roots under `.deploy/tenant-sandbox-acceptance`, with A/B canary files, image configuration from a root-owned test config and generation-checked cleanup in `finally`. Its exported `createSandboxRig({caseName})` returns `{a,b,client,files,brokers,close,evidence}` after verifying configured services. `a/b` contain platform-owned contexts; all launch/files/model calls use the real planned interfaces. Refuse production paths, missing config, missing quota/controller or real admin credentials. Never silently skip a requested integration case. The CLI case registry initially supports `preflight`; Tasks 4–18 add cases named in their commands. Keep imports free of CLI side effects by checking `import.meta.url` against argv.
- [ ] Run the harness test again: PASS. Run `pnpm sandbox:probe --case preflight`: expect either verified controller/filesystem evidence or an explicit nonzero prerequisite failure, never fabricated PASS. Commit only these files with `test: add bounded tenant sandbox acceptance harness`.

## Task 2: Make tenant, directory and runtime-route authority explicit

**Files:** Create `services/platform/src/tenant-policy.mjs`, `services/platform/src/runtime-route-policy.mjs`, `services/platform/test/tenant-policy.test.mjs`, `services/platform/test/runtime-route-policy.test.mjs`. Modify `services/platform/src/platform-server.mjs`, `packages/sdk/src/OpenCodeClient.ts` only if route inventory reveals an actual SDK mismatch.

- [ ] Add tests for ownership, lexical input rejection, unknown routes, ambiguous encodings and directory-bearing query/body/header inputs. A lexical validator filters input; Task 3 supplies the filesystem boundary.

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { relativeInput } from '../src/tenant-policy.mjs';
import { classifyRuntimeRoute } from '../src/runtime-route-policy.mjs';
test('reject traversal, raw files and ambiguous paths', () => {
  for (const value of ['../b', '/etc/passwd', 'x/../../b', 'x\0y', 'x\\..\\b'])
    assert.throws(() => relativeInput(value));
  assert.equal(relativeInput('papers/实验.csv'), 'papers/实验.csv');
  for (const path of ['/file/content', '/find/file', '/path', '/pty',
    '/global/config/auth', '/session/%2e%2e', '/session/a%252fb'])
    assert.equal(classifyRuntimeRoute('GET', path), null);
  assert.equal(classifyRuntimeRoute('GET', '/session/synthetic-a').operation, 'sessionRead');
});
```

- [ ] Run `pnpm platform:test test/tenant-policy.test.mjs test/runtime-route-policy.test.mjs`: expected missing-module FAIL.
- [ ] Implement `relativeInput` and positive route classification. Define/export ownership checks against platform records; session IDs copied from a runtime response must be registered before public access. Unknown session => 404 without existence disclosure; a supplied foreign directory => 403. Do not use metadata `source_path`, active-workspace markers or public `userId` to generate authority.

```js
export function relativeInput(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') ||
      value.includes('\\') || value.startsWith('/') ||
      value.split('/').some(p => p === '..' || p === '.' || p === '')) {
    throw Object.assign(new Error('invalid relative path'), {statusCode:400});
  }
  return value;
}
```

- [ ] Populate a finite method/path table from current SDK callers: session CRUD/list/fork/message/prompt_async/abort/summarize/revert/unrevert/shell/command; used move endpoint; event/permission/question; agent/command/skill; sanitized model catalog/config. Each classified operation declares its ID fields, directories, body schema and approval requirements. Do not forward the original URL after classifying a differently decoded path. Normalize once; reject encoded separators, dot components, extra decoding, duplicate conflicting directories and unsupported headers. Prompt file inputs accept owned attachment references/approved inline representations only. Block raw file/find/path/auth/config/PTY/unneeded control-plane APIs. Validate origin for cookie writes and scrub event/config secrets.
- [ ] Extend authenticated proxy tests with synthetic A/B IDs and invalid directory sources. Run `pnpm platform:test test/tenant-policy.test.mjs test/runtime-route-policy.test.mjs test/platform-server.test.mjs`: PASS, existing required SDK operations still route. Commit `fix: enforce tenant authority and positive runtime routes`.

## Task 3: Implement race-safe managed file access and owned tickets

**Files:** Create `crates/osd-core/src/file_policy.rs`. Modify `crates/osd-core/{Cargo.toml,src/lib.rs,src/artifact_file.rs,src/gateway.rs,src/project.rs}`. Add unit tests in `file_policy.rs` and integration tests in `services/platform/test/workspace-file-boundary.test.mjs`.

- [ ] Add Rust tests using temporary synthetic roots: internal relative link allowed for a data read, outside/absolute/magic link denied, FIFO/socket/device denied promptly, root/session prefix collision denied, rename/symlink swapping cannot read B. Tickets bind account, generation, selected root and relative path; redemption securely opens the file again.

```rust
#[test]
fn rejects_escape_and_non_regular_files() {
    let fixture = FileBoundaryFixture::new();
    fixture.write_owned("note.txt", b"owned");
    fixture.link_owned("internal", "note.txt");
    fixture.link_owned("escape", "../peer/secret");
    assert_eq!(fixture.read("internal").unwrap(), b"owned");
    assert!(fixture.read("escape").is_err());
    assert!(fixture.read("../peer/secret").is_err());
    fixture.create_fifo("pipe");
    assert!(fixture.read("pipe").is_err());
}
```

- [ ] Define `FileBoundaryFixture` in the test module: use `std::env::temp_dir()` with getrandom IDs, owned/peer sibling directories, Unix symlink/mkfifo, and Drop cleanup. Run `pnpm sandbox:core:test --package osd-core file_policy`: expected FAIL before the module is implemented.
- [ ] Add Linux-only `libc` dependency/use and managed policy carrying already-open root descriptors. `openat2` uses `RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS`, `O_CLOEXEC | O_NONBLOCK`; check returned descriptor is a regular file and enforce byte limits. Managed mode rejects absolute paths before syscall. Metadata/control writes additionally prohibit symlinks and use securely opened parent descriptors with `renameat`/`unlinkat`. Non-Linux desktop keeps its existing policy. Essential syscall contract:

```rust
#[cfg(target_os = "linux")]
fn open_regular_beneath(root: &std::fs::File, relative: &str) -> std::io::Result<std::fs::File> {
    use std::os::fd::{AsRawFd, FromRawFd};
    #[repr(C)]
    struct OpenHow { flags: u64, mode: u64, resolve: u64 }
    if relative.is_empty() || relative.starts_with('/') ||
       relative.split('/').any(|p| p == ".." || p == "." || p.is_empty()) {
        return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "invalid path"));
    }
    let path = std::ffi::CString::new(relative)
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "NUL path"))?;
    let how = OpenHow { flags: (libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NONBLOCK) as u64,
        mode: 0, resolve: 0x08 | 0x02 };
    let fd = unsafe { libc::syscall(libc::SYS_openat2, root.as_raw_fd(), path.as_ptr(),
        &how, std::mem::size_of::<OpenHow>()) };
    if fd < 0 { return Err(std::io::Error::last_os_error()); }
    let file = unsafe { std::fs::File::from_raw_fd(fd as i32) };
    if !file.metadata()?.file_type().is_file() {
        return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "not a regular file"));
    }
    Ok(file)
}
```

- [ ] Introduce the file-policy interface to list/read/tickets/project metadata paths without redesigning desktop import behavior. Preserve `/v1/runs`, `/v1/runs/query`, `/v1/runs/log` with account-owned indexes and bounded query/log-hash lookup; a log hash never authorizes a public arbitrary path. Preserve artifact basename resolution within the selected owned tree with current search bounds and hidden-file filters. No managed host `canonicalize` fallback. Stream tickets from opened descriptors; bind expiry and account at issuance/redemption, returning 404/403 instead of leaking another root. Inventory/directory pagination also uses descriptor-relative iteration, bounded names and no-follow metadata checks. Public roots come from trusted startup policy, not editable workspace marker files.
- [ ] Run guarded core tests and `pnpm platform:test test/workspace-file-boundary.test.mjs`. Expect PASS for traversal/link/special-file/ticket tests. Task 7's real probe must establish `openat2` support in gVisor; if unavailable, implement an equivalently race-safe descriptor-walk resolver and repeat the same behavioral tests before rollout. Commit `fix: use scoped descriptor based file operations`.

## Task 4: Build and identify one immutable scientific baseline

**Files:** Create `runtime/sandbox/image/{Dockerfile,pyproject.toml,uv.lock,tool-lock.json}`, `runtime/sandbox/probe-entry.mjs`, `runtime/sandbox/image-manifest.schema.json`, `scripts/dev/stage-sandbox-image.mjs`, `.github/workflows/sandbox-image.yml`, `services/platform/test/science-image.test.mjs`. Modify `package.json` for the staging script wired through Task 1's guard.

- [ ] Add tests rejecting a floating image, missing tool hash, changed rootfs digest and a build context containing a canary credential. Define/export `validateImageManifest(manifest)` in the staging script. Valid manifests require schema 1, architecture `linux/amd64` or verified supported host architecture, immutable SHA256 rootfs and tool identities, Python patch, uv version and baseline lock hash. The tool list includes osd, OpenCode and enabled native CLIs; its OpenCode version equals the repository's configured pinned version.

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateImageManifest } from '../../../scripts/dev/stage-sandbox-image.mjs';
test('floating versions cannot become a managed image', () => {
  assert.throws(() => validateImageManifest({schema:1, name:'science-v1',
    image:'science:latest', rootfsSha256:'', tools:{}}), /immutable/);
});
```

- [ ] Run `pnpm platform:test test/science-image.test.mjs`: expected missing-export FAIL. Create the baseline input below, resolve the exact compatible lock on CI with Python 3.12, and commit the resulting lock and tool hashes. No invented digest, empty hash or floating tool version may pass staging.

```toml
[project]
name = "scikeel-science-baseline"
version = "1.0.0"
requires-python = ">=3.12,<3.13"
dependencies = [
  "numpy", "pandas", "scipy", "matplotlib", "scikit-learn",
  "statsmodels", "sympy", "nbformat"
]
[tool.uv]
package = false
```

- [ ] Build from digest-pinned Python and uv inputs loaded from `tool-lock.json`. `ARG PYTHON_IMAGE` and `UV_IMAGE` below must be validated digest references by the CI script. Stage only explicitly listed runtime binaries/resources into the build context. Install runtime-required system packages from a pinned snapshot or record the exact base digest/package inventory; resolve required native libraries by running each binary's version command. Do not copy the entire checkout or HOME.

```dockerfile
ARG PYTHON_IMAGE
ARG UV_IMAGE
FROM ${UV_IMAGE} AS uv
FROM ${PYTHON_IMAGE}
COPY --from=uv /uv /usr/local/bin/uv
COPY pyproject.toml uv.lock /opt/scikeel/baseline/
ENV UV_PYTHON_DOWNLOADS=never UV_LINK_MODE=copy
ENV UV_PROJECT_ENVIRONMENT=/opt/scikeel/science
WORKDIR /opt/scikeel/baseline
RUN uv sync --locked --no-dev --no-install-project
COPY tools/ /opt/scikeel/tools/
ENV PATH=/opt/scikeel/science/bin:/opt/scikeel/tools/bin:/usr/local/bin:/usr/bin:/bin
ENV OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 MKL_NUM_THREADS=1 NUMEXPR_NUM_THREADS=1
ENV PYTHONDONTWRITEBYTECODE=1
USER 1000:1000
ENTRYPOINT ["/opt/scikeel/tools/bin/osd", "--version"]
```

- [ ] Add a synthetic-only `probe-entry.mjs`: a fixed set of local import/file/network/resource exercises driven by a root-owned case manifest, with no production route registration. Stage it only in a test image variant; production image validation rejects that test marker. Tasks 6–10 can test primitives using this entrypoint before the production runner exists. Their primitive checks cannot satisfy production joint-readiness or real-runtime release gates. Task 11 adds the production runner to the explicit build context and replaces the image entrypoint with the pinned Node runner command. CI builds with bounded dedicated runner resources, imports the baseline offline, runs version probes, exports the rootfs and a machine-readable manifest, and records SHA256 before publication. The host staging script validates manifest/signature provenance, file count/size, archive entries, links/device restrictions and available storage; extracts into a root-owned new digest directory and atomically marks it ready. It never overlays a running image or executes archive hooks. Production rootfs is read-only and includes trusted shared Python symlinks. Protect installed manifest/binaries from the platform account's writes. Support keeping referenced previous images and refusing mismatched architecture.
- [ ] Run the new unit test: PASS. Run `pnpm sandbox:image:stage --manifest .deploy/tenant-sandbox-acceptance/image-manifest.json --dry-run`: expected verified staging report or explicit missing-artifact failure; fetching CI artifacts is a prerequisite, not a hidden local build. Register/run `pnpm sandbox:probe --case science-image` when runner lifecycle exists: offline imports plus figure output, immutable image write rejected, no tenant venv created. Commit `feat: define locked shared scientific sandbox image`.

## Task 5: Generate trusted manifests and provide a narrow launcher client

**Files:** Create `services/platform/src/sandbox-manifest.mjs`, `services/platform/src/sandbox-client.mjs`, `services/platform/test/sandbox-manifest.test.mjs`, `services/platform/test/sandbox-client.test.mjs`. Modify `services/platform/src/main.mjs` for configuration validation without enabling cutover.

- [ ] Test that mount sources and destinations derive only from trusted account records and configured roots. Test that the manifest excludes administrator HOME, shared platform data, original attachments and session envelopes. `sandbox-manifest.mjs` exports `deriveTenantLayout({roots, record, image})`; `sandbox-client.mjs` exports `SandboxClient` with the fixed interface above.

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveTenantLayout } from '../src/sandbox-manifest.mjs';
test('public mount injection cannot enter a tenant layout', () => {
  const roots = {instances:'/srv/scikeel/instances', native:'/srv/scikeel/native',
    images:'/srv/scikeel/images'};
  assert.throws(() => deriveTenantLayout({roots,
    record:{id:'../peer', userId:'a'}, image:{digest:'bad'}}));
  assert.throws(() => deriveTenantLayout({roots,
    record:{id:'a', userId:'a', mounts:[{source:'/etc', destination:'/host'}]},
    image:{digest:'sha256:' + 'a'.repeat(64)}}), /unexpected/);
});
```

- [ ] Run `pnpm platform:test test/sandbox-manifest.test.mjs test/sandbox-client.test.mjs`: missing modules FAIL.
- [ ] Use strict nonempty ID syntax matching current generated instance IDs, reject unknown input keys, and keep account/user binding in the external registry. Derive workspace at its current absolute path; mount only private runtime state/HOME/native-history subtrees and bounded scratch at required historical destinations. Never mount `cli-runtime/users/<id>` wholesale. Profile files are newly sanitized broker profiles, not copied administrator credentials. Implement length-capped newline JSON messages on a Unix socket with a request ID, timeout, response schema and generation check.

```js
export const LAUNCHER_OPERATIONS = Object.freeze(['register','start','stop','inspect']);
export function launcherRequest(op, args, requestId) {
  if (!LAUNCHER_OPERATIONS.includes(op)) throw new Error('unsupported launcher operation');
  if (!requestId || typeof requestId !== 'string' || requestId.length > 128)
    throw new Error('invalid launcher request ID');
  return {schema:1, requestId, op, args};
}
```

- [ ] The host validates independently; a Node manifest is explanatory/test evidence, not privileged authority. `start` returns only launcher-derived endpoint identity; reject stale generation, foreign instance, malformed response, oversized message, timeout and unavailable launcher. No fallback spawn. Fixture socket tests exercise partial frames, duplicate responses and disconnects without launching anything.
- [ ] Run both tests: PASS. Confirm no current worker launch path changed. Commit `feat: add trusted tenant layouts and narrow sandbox client`.

## Task 6: Enforce launcher process, memory, CPU and storage boundaries

**Files:** Create `crates/osd-sandbox-host/{Cargo.toml,src/main.rs,src/protocol.rs,src/registry.rs,src/lifecycle.rs,src/quota.rs}`, `services/platform/infra/scikeel-sandbox-host.service`. Modify `Cargo.toml`, `Cargo.lock`. Tests reside in the new crate and `services/platform/test/sandbox-lifecycle.test.mjs`.

- [ ] Add protocol tests for unsupported exec, caller mount injection, oversized requests and wrong peer UID. Add lifecycle tests for generation reuse, partial start cleanup, idempotent stop and incomplete quota/controller support. `Peer` stores Linux `SO_PEERCRED`; `Request` is a serde internally tagged enum with `deny_unknown_fields`; peer credentials are checked before parsing account operations.

```rust
#[derive(serde::Deserialize)]
#[serde(tag = "op", content = "args", rename_all = "camelCase", deny_unknown_fields)]
enum Operation {
    Register { instance_id: String, user_id: String },
    Start { instance_id: String, generation: u64, image_digest: String },
    Stop { instance_id: String, generation: u64, reason: String },
    Inspect { instance_id: String },
}
#[test]
fn arbitrary_execution_is_not_a_launcher_operation() {
    let request = r#"{"op":"exec","args":{"command":"cat /etc/shadow"}}"#;
    assert!(serde_json::from_str::<Operation>(request).is_err());
}
```

- [ ] Run `pnpm sandbox:core:test --package osd-sandbox-host`: expected missing-crate FAIL; create its Linux-only service binary using workspace serde/serde_json and libc. Desktop packaging must not depend on this service. Reject non-Linux launch with an explicit unsupported-host error.
- [ ] Implement root-owned fixed configuration and socket permissions `0660` for the platform service identity; inspect `SO_PEERCRED`, never trust a user field. Own the registry and accept existing account/instance IDs through the platform identity only. Derive mount paths from fixed roots. Securely open source roots without following attacker-controlled links; preserve descriptors into launcher-owned staging mounts so the source cannot be substituted between validation and runsc launch. Sandbox processes cannot replace their mounted root's outside parent.
- [ ] Execute a checksum-pinned runsc with argv arrays inside a dedicated per-tenant systemd unit/cgroup. Initial limits: high 640 MiB, max 1024 MiB, swap max 128 MiB, pids 256, CPU one core, fixed start/stop timeouts. Verify actual `memory.*`, `pids.max`, `cpu.max`, runtime/gofer/runner ownership before readiness. Drop tenant capabilities, set no-new-privileges, isolate PID/IPC/mount/network, no host devices/control sockets/cgroup writes. Rootfs is immutable, scratch/private HOME are explicit writable mounts; avoid a memory-backed writable overlay over the whole image. The privileged daemon and brokers have separate measured limits/reserve.
- [ ] Probe the host filesystem for enforceable byte/inode quota. Use project quota on a verified supported filesystem; otherwise create a reserved, bounded dedicated quota-capable data volume before cutover. Preserve absolute mount destinations. Start with configurable 2 GiB / 100,000 inode synthetic tenant quotas and test exact kernel enforcement; choose production quotas against actual existing user data and disk capacity, not those fixture numbers. A usage scan or sparse file without an enforced backing-store budget is insufficient. Refuse start if storage/quota/controller readiness fails.
- [ ] Add service hardening while retaining only the narrowly necessary mount/net/cgroup operations. Install service binaries/config root-owned outside the editable checkout. Register `lifecycle` probe. Run guarded Rust tests: PASS. `pnpm sandbox:probe --case lifecycle` must show enforced limits, blocked peer/host process access, controlled OOM/disk-full/inode-full, no orphan runsc/gofer and healthy platform login. Commit `feat: enforce bounded tenant sandbox lifecycle`.

## Task 7: Establish internal transport and approved network egress

**Files:** Create `crates/osd-sandbox-host/src/network.rs`, `services/platform/src/egress-broker.mjs`, `services/platform/test/egress-broker.test.mjs`. Modify `crates/osd-cli/src/{args,server}.rs`, launcher lifecycle and `services/platform/src/main.mjs`.

- [ ] Add tests denying loopback/private/link-local/metadata destinations, IPv4-mapped IPv6, disallowed ports, rebinding and redirects to a denied destination. Export `isPublicAddress(address)` and `EgressBroker` with platform-owned time-limited connection grants. Include public IPv4/IPv6 positive cases; parse addresses with a maintained IP parser, not string-prefix matching.

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { isPublicAddress } from '../src/egress-broker.mjs';
test('mapped and metadata addresses cannot bypass egress checks', () => {
  for (const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','::1',
    '::ffff:127.0.0.1','fe80::1','fc00::1']) assert.equal(isPublicAddress(ip), false);
  assert.equal(isPublicAddress('1.1.1.1'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
});
```

- [ ] Run `pnpm platform:test test/egress-broker.test.mjs`: missing module FAIL. Implement resolution at broker connection time, reject any nonpublic answer, connect to the validated address without a second library DNS lookup, preserve TLS hostname, revalidate each redirect/new CONNECT and cap duration/bytes. Connection grants are bound to account/generation, approved destination policy and expiration. Broker tests use controlled resolver/transport injection; never probe actual cloud metadata.
- [ ] Give each sandbox a private network namespace/veth. Install rules only in a launcher-owned nftables table: host platform may reach the tenant's designated gateway/runner ports; tenants may reach only the fixed package/model/egress broker endpoints. Drop tenant-to-tenant traffic, direct internet, host/private/metadata, UDP and unsupported IPv6. Never flush host/Docker rules or expose osd on a public listener. Add explicit `--bind-address` managed CLI option; existing desktop loopback/LAN semantics remain unchanged.
- [ ] Set HTTP(S)_PROXY/NO_PROXY from trusted config, not inherited process env. Approved tools requiring network must demonstrably use the broker; a tool ignoring proxies remains blocked until an adapter exists. Never grant raw network because a package client failed. Internal broker identities map to authenticated tenant/generation; do not infer ownership from public forwarded headers. Protect osd/runner endpoints with their internal tokens; scrub logs.
- [ ] Register `network` probe: platform SSE reaches its owned worker, public fetch succeeds only with grant, A cannot reach B or host listeners, CONNECT/DNS/redirect bypasses fail for IPv4/IPv6. Run unit test: PASS. Run `pnpm sandbox:probe --case network`: PASS with real nft/cgroup/sandbox evidence. Also establish the managed file helper's `openat2` support here; ENOSYS is a release blocker until Task 3's equivalent secure resolver passes. Commit `feat: constrain tenant network to approved brokers`.

## Task 8: Add a bounded public package mirror without writable sharing

**Files:** Create `services/platform/src/package-broker.mjs`, `services/platform/infra/scikeel-package-mirror.service`, `services/platform/test/package-broker.test.mjs`, `runtime/sandbox/image/package-mirror.lock`. Modify broker startup/config and the synthetic rig for a tiny local fixture wheel/index.

- [ ] Test a public-only mirror route classifier: GET/HEAD simple-index/archive requests allowed, POST/PUT/DELETE, replica/admin/user/upload APIs, encoded escape, unrelated indexes and arbitrary upstream query parameters denied. Define/export `packageRoute(method, path)` and `PackageBroker`; the service's only upstream is a configured trusted mirror base URL.

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { packageRoute } from '../src/package-broker.mjs';
test('mirror access cannot upload or reach replica/admin APIs', () => {
  assert.equal(packageRoute('GET','/root/pypi/+simple/numpy/').kind, 'index');
  assert.equal(packageRoute('HEAD','/root/pypi/+f/abc/def/example.whl').kind, 'archive');
  for (const [method,path] of [['POST','/root/pypi/'], ['DELETE','/root/pypi/'],
    ['GET','/+changelog/0'], ['GET','/root/private/+simple/'],
    ['GET','/root/pypi/+f/../secret']]) assert.equal(packageRoute(method,path), null);
});
```

- [ ] Run `pnpm platform:test test/package-broker.test.mjs`: missing module FAIL. Resolve/pin devpi-server and transitive dependencies in `package-mirror.lock` on the isolated builder. Official documentation reviewed for this plan reported 6.20.3; reverify security/compatibility before locking, rather than claiming that remains the latest at implementation time.
- [ ] Install the mirror outside tenant mounts under its own OS identity. Initialize only the public `root/pypi` mirror, with no tenant accounts/uploads. Bind to its private service endpoint and route tenant access solely through the broker. Proxy only the fixed methods/paths, strip cookies/auth/forwarded headers, enforce granted account/generation and bound concurrent archive streams. Preserve content/hash/cache headers needed by uv; cap responses and downloads with stream backpressure. Public fixture mode is allowed only in the synthetic rig, never from a tenant URL.

```ini
[Service]
User=scikeel-mirror
Group=scikeel-mirror
ExecStart=/usr/lib/scikeel/mirror/bin/devpi-server --serverdir /var/lib/scikeel/package-mirror --host 127.0.0.1 --port 3141
MemoryHigh=192M
MemoryMax=256M
MemorySwapMax=64M
TasksMax=64
CPUQuota=50%
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/var/lib/scikeel/package-mirror
```

- [ ] Enforce a 2 GiB cache quota via Task 6's verified storage mechanism; record cache byte/inode usage outside tenant budgets. Retry deadlines and archive-size limits are explicit configuration, initially 60 seconds and 200 MiB for the small-package acceptance workload. Serve a retriable 503 on unhealthy/full service; no host install fallback. Allow approved direct upstream download only through Task 7's same constrained public broker, with visible cache-bypass status and hash verification. Do not expose arbitrary private-index credentials or globally cache locally built/private wheels.
- [ ] Implement maintenance as drain streams, stop service, clear/reinitialize the entire disposable public store and restart, under the same hard quota; no live-file deletion or simultaneous second full store. Prefer supported selective GC only after a verified devpi capability test. Disable per-tenant mutation of cache service settings and keep `UV_CACHE_DIR` private with `UV_LINK_MODE=copy`.
- [ ] Register/run `pnpm sandbox:probe --case package-cache`: two synthetic tenants install the same tiny wheel through the real mirror with one upstream artifact fetch; metadata checks may occur separately. Private environments differ; upload/delete/pollution attempts fail; outage/quota failures are bounded. Unit test and probe PASS within service memory budget or retain an explicit release blocker. Commit `feat: provide bounded public dependency artifact reuse`.

## Task 9: Keep upstream credentials outside sandboxes and preserve model streams

**Files:** Create `services/platform/src/model-broker.mjs`, `services/platform/test/model-broker.test.mjs`. Modify `services/platform/src/{cli-profile,main}.mjs`, `services/platform/test/cli-runtime.test.mjs` and image/profile acceptance fixtures.

- [ ] Test short-lived scoped tokens, exact provider/model/path allowlists, foreign tenant/generation, revoked token, arbitrary upstream URL, quota bypass and streaming cancellation. Export `ModelBroker` and `authorizeModelRequest({capability,request,policy,now})`; the policy is platform-owned, not in mounted config.

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeModelRequest } from '../src/model-broker.mjs';
test('a tenant token cannot select another model or upstream', () => {
  const capability = {userId:'a', generation:2, expiresAt:2000,
    provider:'fixture', models:['approved-model'], routes:['/v1/responses']};
  const policy = {enabledModels:['approved-model'], revoked:false};
  assert.throws(() => authorizeModelRequest({capability, policy, now:1000,
    request:{userId:'b', generation:2, path:'/v1/responses', model:'approved-model'}}));
  assert.throws(() => authorizeModelRequest({capability, policy, now:1000,
    request:{userId:'a', generation:2, path:'/v1/responses', model:'other',
      upstream:'http://127.0.0.1'}}));
});
```

- [ ] Run `pnpm platform:test test/model-broker.test.mjs`: missing module FAIL. Implement high-entropy revocable bearer capabilities stored as hashes, bound to account/generation/provider, exact enabled models and route set. Their possession is expected inside the tenant and must not confer platform rights. Strip user upstream/authorization/credential fields and attach the administrator secret only at the final fixed upstream hop. Authorize before opening a stream and enforce per-account request/token/byte/concurrency budgets throughout it.
- [ ] Support the pinned managed runtimes' needed Anthropic Messages and OpenAI-compatible Responses/chat shapes, SSE backpressure and abort. Do not implement an arbitrary HTTP passthrough. Use injected synthetic upstream for offline tests; use separately scoped real test credentials only for Task 17. No prompts, authorization headers or full provider errors in logs.
- [ ] Change CLI profile resolution and OpenCode config generation to emit sanitized broker URLs/tokens and enabled catalog fields. Keep upstream identity separate from token revision; rotation must not abandon resumable native histories. Verify existing OAuth/subscription modes explicitly; unsupported safe proxy/approval modes are unavailable with an administrator-facing reason, never a copied shared credential. Drain active sessions before identity changes requiring handover.
- [ ] Register `model-broker` probe: secret-pattern canary absent from image/mounts/env/logs; fake stream/cancel/resume works; foreign/revoked capabilities denied. Run new tests and affected CLI tests: PASS. Run `pnpm sandbox:probe --case model-broker`: PASS. Commit `feat: broker scoped inference without exposing upstream secrets`.

## Task 10: Select private environments and make approved installs transactional

**Files:** Create `services/platform/src/environment-approvals.mjs`, `services/platform/src/project-environments.mjs`, `services/platform/test/project-environments.test.mjs`, `services/platform/test/environment-approvals.test.mjs`. Modify platform routes/approval integration and `runtime/sandbox/file-rpc.mjs` when introduced in Task 11.

- [ ] Add pure approval tests and selector tests with injected file-RPC descriptors. Export `EnvironmentApprovals`, `selectPythonEnvironment(info)` and `ProjectEnvironments`. `info` comes from sandbox secure inspection and includes `basePython`, `venvState`, `venvPython`, `owned` and `imageDigest`, not unchecked public paths.

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { selectPythonEnvironment } from '../src/project-environments.mjs';
test('new accounts use the image, broken private environments fail visibly', () => {
  const base = {basePython:'/opt/scikeel/science/bin/python',
    imageDigest:'sha256:'+'a'.repeat(64), owned:true};
  assert.equal(selectPythonEnvironment({...base,venvState:'absent'}).kind, 'base');
  assert.throws(() => selectPythonEnvironment({...base,venvState:'broken'}), /rebuild/i);
  assert.throws(() => selectPythonEnvironment({...base,venvState:'external'}));
});
```

- [ ] Run `pnpm platform:test test/project-environments.test.mjs test/environment-approvals.test.mjs`: missing modules FAIL. Implement explicit base/private choice:

```js
export function selectPythonEnvironment(info) {
  if (!info.owned) throw new Error('environment is outside the owned project');
  if (info.venvState === 'absent')
    return {kind:'base', python:info.basePython, imageDigest:info.imageDigest};
  if (info.venvState !== 'valid' || !info.venvPython)
    throw new Error('private environment is invalid; approve a rebuild');
  return {kind:'private', python:info.venvPython, imageDigest:info.imageDigest};
}
```

- [ ] Store approvals outside sandbox storage: `{id,userId,sessionId,projectId,inputHash,operation,expiresAt,used}`. Accept only an authenticated manual approval; consume once under a serialized platform transaction. User-modified input, foreign session, expired/replayed approval => 403 before install execution. Native tool command approvals remain required independently; checking the string `pip` cannot establish policy. Surface pending approval through existing permission/question UI rather than introducing a parallel approval screen.
- [ ] Implement project install locking and sandbox-side secure input read/hash. For declared uv projects resolve and capture the actual lock, then create a standalone staging `.venv` at a private same-filesystem path. Never use `--system-site-packages`. Disable automatic Python downloads and require approved source build/network capabilities. Use `uv sync --locked` with the approved resolved input; validate actual inventory/imports and lock hash, then swap while no active job holds an environment lease. Staged path and previous venv are quota-counted. Ensure shebangs/venv configuration target the final environment path: build at an atomic replacement layout with stable final interpreter path, or rewrite/revalidate generated scripts before publication. A renamed venv with stale staging shebangs is a failing install.
- [ ] Restore previous environment, lock and record on failure; release install lock on timeout/cancel. Existing user-managed uv/pip workflows remain possible inside sandbox with command approval and actual-state inventory, without mislabeling them as managed installs. Private `.venv` interpreter links may point to verified image Python, but environment/site-packages links cannot escape into another mount/user. Install routines cannot edit the baseline or global mirror.
- [ ] Record schema-1 environment identity in platform run metadata: image digest, Python/uv/runtime versions, OS/arch, resolved lock SHA256, selection kind and actual package inventory. Report incomplete imported requirements distinctly. Register `project-environments` probe: conflicting tiny fixture versions in A/B, standalone scientific dependencies declared explicitly, changed-input replay denied, failed install retains old interpreter, baseline remains unchanged. Tests PASS; run probe after Task 11: PASS. Commit `feat: manage private approved reproducible project environments`.

## Task 11: Run all CLI tools and file RPC inside the tenant

**Files:** Create `runtime/sandbox/{runner,file-rpc,cli-jobs}.mjs`, `services/platform/test/sandbox-runner.test.mjs`. Modify `crates/osd-cli/src/{args,server}.rs` if runner/file operations need managed policy startup; update the image's explicitly whitelisted runner contents.

- [ ] Add fake subprocess tests for private environment allowlist, current project directory, binary/image inputs, streamed output, cancellation/descendant cleanup, resume identity and native approval requests. Export `buildJobEnvironment({privateHome,environment,brokers})` and `CliJobs`; runner routes use the fixed contracts above. The fake subprocess lives in `services/platform/fixtures/sandbox-cli.mjs` and emits deterministic SSE/approval/image/resume events, never real model calls.

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildJobEnvironment } from '../../../runtime/sandbox/cli-jobs.mjs';
test('host credentials and mutable global Python paths are not inherited', () => {
  process.env.SCIKEEL_ADMIN_CANARY = 'must-not-leak';
  const env = buildJobEnvironment({privateHome:'/private-home',
    environment:{kind:'base',python:'/opt/scikeel/science/bin/python'}, brokers:{}});
  assert.equal(env.SCIKEEL_ADMIN_CANARY, undefined);
  assert.equal(env.HOME, '/private-home');
  assert.equal(env.UV_PYTHON_DOWNLOADS, 'never');
  assert.equal(env.OPENBLAS_NUM_THREADS, '1');
  delete process.env.SCIKEEL_ADMIN_CANARY;
});
```

- [ ] Run `pnpm platform:test test/sandbox-runner.test.mjs`: missing module FAIL. Implement fixed runtime argv adapters, JSON stdin/output handling, scoped native session state and runner auth. Do not copy `process.env`. Set private HOME/UV_CACHE_DIR/MPLCONFIGDIR, pinned tool/base or owned venv PATH, scientific thread limits, approved proxy endpoints and sanitized provider variables. Preserve runtime-specific supported model/variant flags and attachment/image delivery semantics.
- [ ] Use pinned runtime native permission events to pause commands/deletions/install/connections until platform approval replies. Translate them to existing Web permission/question events with owned request/session/generation IDs. Unsupported protocol/approval flow fails closed and reports unavailable mode. Test nested Codex restrictions in gVisor with the actual binary: no implicit unsafe downgrade or retry outside sandbox. An explicit outer-sandbox configuration can be used only if its command approval contract passes the same acceptance tests.
- [ ] Implement process groups, bounded output queues, SSE replay/cursors appropriate to current session events, deadline, abort and verified descendants stopped. Fail a job if runner/container generation changes; no automatic rerun that duplicates work. Scope local MCP/plugin/hook/browser/Git child execution to this same environment. Runner startup health waits for gateway, OpenCode sidecar and its own authenticated service; do not accept a job after gateway-only health.
- [ ] Implement file RPC by dispatching only the fixed operations to Task 3's secure core inside the sandbox. Resolve each selected root from the trusted manifest plus owned session/project context. Binary uploads stream to securely opened temporary files and atomically publish; hash/read use an opened descriptor; removeWorkCopy can remove only the authorized working-copy subtree. Forbid public raw exec and platform registry reads. Record operation status without credential/content logging.
- [ ] Run unit test: PASS. Register/run `pnpm sandbox:probe --case runner`: real version/startup/file operations, fake CLI stream/image/cancel/resume plus native permission pause, and no host child process. Rebuild the CI image with exact runner source hash before this probe. Commit `feat: execute managed jobs and workspace rpc inside sandboxes`.

## Task 12: Admit jobs through one scheduler and replace host spawns

**Files:** Create `services/platform/src/sandbox-scheduler.mjs`, `services/platform/test/sandbox-scheduler.test.mjs`. Modify `services/platform/src/{worker-manager,cli-runtime,main}.mjs`, their existing tests and `scripts/dev/safe-desktop-task.mjs`.

- [ ] Test initial capacity one sandbox/one job, FIFO bounded queue, two requests for the same account sharing startup, build coordination, protected downloads/streams/uploads, abort/removal and restart generation reconciliation. Export `SandboxScheduler` with `acquire({context,kind,signal}) -> lease`; lease offers `release()` and `generation`. Set fixture reserve through injected pressure reader/clock; default production admission requires at least 600 MiB available after platform/mirror/launcher accounting.

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { SandboxScheduler } from '../src/sandbox-scheduler.mjs';
test('only one job is admitted until its lease is released', async () => {
  const scheduler = new SandboxScheduler({maxSandboxes:1,maxJobs:1,
    pressure:async () => ({availableBytes:2**30, buildActive:false})});
  const context = {userId:'a',instanceId:'a',generation:1};
  const first = await scheduler.acquire({context,kind:'job'});
  let entered = false;
  const second = scheduler.acquire({context,kind:'job'}).then(x => {entered=true;return x;});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(entered,false);
  first.release();
  (await second).release();
  await scheduler.close();
});
```

- [ ] Run `pnpm platform:test test/sandbox-scheduler.test.mjs`: missing module FAIL. Implement a maximum 100 queued operations, 120-second queue deadline and retriable capacity response/visible position; cancellation removes queued requests. Do not count static/auth requests as sandbox work. File/RPC access uses a tenant lease; never evict a running job to serve another account's file tree. Evict idle accounts only after all operation leases/streams/uploads and jobs end; protect generation through completion.
- [ ] Coordinate heavy builds and sandbox jobs with a shared resource admission protocol plus the existing `.deploy/desktop-task.lock`. A build checks/drains admitted heavy jobs and holds an exclusive admission lock; job start checks the same lock atomically. Do not use a non-atomic `buildActive` marker alone. Bound wait without hanging auth/UI; never raise guard limits into the reserve. Mirrors/platform remain live with measured budgets.
- [ ] Replace `WorkerManager.#startWorker` managed path with launcher register/start and combined health, removing direct worker spawn and inherited host env there. Replace managed `CliRuntimeManager.startReservedPrompt` spawn with runner job submission/events/cancel; keep session envelopes outside and native histories in narrowly mounted private state. Preserve model handover, reservation, attachments, fork/move behavior and status/error contracts. A disabled managed feature is allowed only before tenant cutover; once marked managed, launcher/runner failure always fails closed.
- [ ] Reconcile actual launcher state on platform restart: inspect generation/image/cgroup, invalidate stale endpoints/tokens, cancel or explicitly report interrupted jobs and reconnect no foreign stream. User disable/delete revokes capabilities and stops owned descendants. Queue waiting survives only with valid ownership; do not replay a consumed approval or duplicate a prompt.
- [ ] Run `pnpm platform:test test/sandbox-scheduler.test.mjs test/worker-manager.test.mjs test/cli-runtime.test.mjs`: PASS. Register/run `pnpm sandbox:probe --case scheduling`: login/static remain responsive under bounded agent OOM, B waits visibly, idle A can be evicted safely, active A cannot, build/job do not overlap, launcher outage creates no host runtime process. Commit `feat: schedule managed workers without host execution fallback`.

## Task 13: Move research, attachment work copies and skills to scoped RPC

**Files:** Create `services/platform/src/workspace-rpc.mjs`, `services/platform/test/workspace-rpc.test.mjs`. Modify `services/platform/src/{research-tasks,attachments,attachment-input,attachment-turns,attachment-routes,skills,platform-server,main}.mjs` and their behavioral tests. These are active independent work areas: integrate their final approved interfaces first.

- [ ] Test `WorkspaceRpc` with owned platform context and an injected runner transport; reject stale generation, foreign session, root injection and operation outside the finite contract. Test research reports/inputs with A/B canaries and a symlink-swap fixture; hashes must represent the descriptor actually read, not a second unchecked host open.

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceRpc } from '../src/workspace-rpc.mjs';
test('workspace reads carry authoritative tenant context', async () => {
  const calls=[];
  const rpc=new WorkspaceRpc({transport:async (context,op)=>{
    calls.push({context,op}); return {sha256:'owned-hash'};
  }});
  const context={userId:'a',instanceId:'a',generation:1,
    sessionId:'a-session',directory:'/owned/a/project',workspaceDir:'/owned/a'};
  assert.deepEqual(await rpc.call(context,{op:'hash',root:'session',relative:'input.csv'}),
    {sha256:'owned-hash'});
  assert.equal(calls[0].context.userId,'a');
  await assert.rejects(rpc.call(context,{op:'read',root:'session',relative:'../b/secret'}));
});
```

- [ ] Run `pnpm platform:test test/workspace-rpc.test.mjs`: missing module FAIL. Implement schema validation per operation, authenticated internal transport, generation and timeout checks, streaming binary transfer and owned file tickets. Route account/session/project scopes from platform records. There is no arbitrary URL/path fallback or host `fs` retry.
- [ ] Replace research workspace `realpath/mkdir/read/hash` with scoped file calls; task leases/decisions/ownership remain platform files outside the sandbox. Read at most 128 KiB of report JSON, validate schema and expected session/output hashes, and reject invalid report claims without treating them as authority. Preserve crash recovery, page leases, run status and human decision confirmations.
- [ ] Keep attachment originals and account/session association maps in the external protected store. Stream only approved working copies through RPC to the designated account/session-owned subtree; never mount original blobs. File parts/images reference those copies through the actual runtime's supported image/file input protocol. Preserve history cards, fork/delete/retry/abort expiry behavior from the separate attachment plan. Generic file APIs do not gain access to protected originals. Cleanup uses only scoped removeWorkCopy, while platform can delete its own original blob metadata/store normally.
- [ ] Seed built-in skills from read-only image resources inside the sandbox, preserve account-private customization and supported discovery links. Validate private link targets, not the parent native-state folder wholesale; retain Claude/Codex session resume state while excluding external session envelopes and credentials. Moving a session changes owned association/directory only when idle; `moveChanges:false`, no automatic data migration, source/children/destination all owned.
- [ ] Run workspace RPC and all affected research/attachment/skills/CLI tests through `pnpm platform:test`: PASS. Register/run `pnpm sandbox:probe --case workspace-integrations`: correct reports/hashes, image input/history, approved working-copy lifecycle, private original inaccessible, skill discovery/resume and foreign session move rejected. Commit `feat: route workspace integrations through tenant file rpc`.

## Task 14: Preserve project metadata and sandbox-local Git reproducibility

**Files:** Modify `crates/osd-core/src/{project,gateway,git_snapshot,runtime}.rs`, `services/platform/src/{platform-server,workspace-rpc}.mjs`, `packages/sdk/src/{OpenCodeClient,types}.ts`, `apps/desktop/src/lib/tauri.ts`. Create `services/platform/test/managed-projects.test.mjs`; extend Rust project/snapshot tests.

- [ ] Add project behavior tests: list/create/open nested managed project; rename metadata only; pin persists; remove metadata preserves files/history; duplicate names allowed if existing product semantics allow them; forged ID/source_path rejected. Register managed project IDs/relative directories outside editable workspace metadata. Add snapshot test preserving user HEAD/index while advancing the owning nested project's `refs/openscience/snapshots/<branch>`.

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSandboxRig } from '../fixtures/sandbox-rig.mjs';
test('metadata removal never removes project files', async () => {
  const rig=await createSandboxRig({caseName:'projects'});
  try {
    const p=await rig.client.projects.create(rig.a,{name:'Analysis'});
    await rig.files.call({...rig.a,projectId:p.id},{op:'writeAtomic',root:'project',
      relative:'keep.txt',bytes:Buffer.from('keep')});
    await rig.client.projects.removeMetadata(rig.a,p.id);
    assert.equal(await rig.client.projects.isRegistered(rig.a,p.id),false);
    assert.equal((await rig.files.call(rig.a,{op:'read',root:'account',
      relative:p.relativeDirectory+'/keep.txt'})).toString(),'keep');
  } finally {await rig.close();}
});
```

- [ ] Expose `client.projects` in the rig through authenticated real platform endpoints, not a fake directory implementation. Run `pnpm platform:test test/managed-projects.test.mjs`: expected missing managed metadata route FAIL once sandbox prerequisites exist; earlier prerequisite failures remain explicit.
- [ ] Add owned project PATCH `{name?,pinned?}` and metadata-only DELETE using existing UI/SDK helpers, schema/length constraints and Web-only managed semantics. Do not reuse desktop recursive deletion/imported-external-directory behavior. Existing desktop registration with `source_path` remains desktop-only. Create/project init goes through sandbox RPC and preserves `.git`/harness metadata.
- [ ] Make snapshot dispatch resolve the owning nested project repo for actual changed job files rather than always the account root. Git init is local-only; snapshot commits use the dedicated index and `commit-tree/update-ref` semantics already present. Do not set remotes, push, rewrite normal branches/staging or make a second metadata-only checkpoint for unrelated directories. User Git filters/hooks/subcommands execute in the sandbox with applicable approval and quota, never privileged platform callbacks.
- [ ] File watchers operate inside sandbox and serialize/settle snapshots after writes; a platform request can ask `checkpoint` with owned project/run IDs but cannot supply shell argv or a foreign directory. Keep snapshot/run environment association and expose best-effort checkpoint failure without losing user files or falsely reporting a successful snapshot.
- [ ] Run guarded project/Git Rust tests, platform metadata tests and `pnpm typecheck`: PASS. Register/run `pnpm sandbox:probe --case projects-and-git`: nested file change advances correct snapshot ref, root/HEAD/index remain intact, Git filter canary cannot reach host/B, cold reopen retains grouping/pins/name. Commit `feat: preserve managed projects and sandbox local snapshots`.

## Task 15: Make every current Web file/project control usable or explicit

**Files:** Modify `apps/desktop/src/app/routes/{ProjectsPage,FilesPage,NotebooksPage}.tsx`, `apps/desktop/src/components/sidebar/Sidebar.tsx`, `apps/desktop/src/components/notebook/NotebookEditor.tsx`, `apps/desktop/src/components/inspector/{FilePreviewInspector,NotebookInspector}.tsx`, `apps/desktop/src/lib/{tauri,artifactFile}.ts`, relevant English/Chinese existing locale files and parity counterparts if required. Extend corresponding Web tests; create `apps/desktop/src/components/notebook/NotebookEditor.web.test.tsx` and `apps/desktop/src/test/webTenantFiles.acceptance.test.mjs`.

- [ ] Write component tests for Web rename/pin/remove through managed endpoints, remove wording explicitly preserving files, failed mutations retaining UI state, active-session move blocked, preview/download scopes and invalid ticket errors. Add notebook Web test confirming read-only notebook display with no kernel/run/add/save/native-dialog controls. Check relevant history/export/large-file viewers so no hidden native call remains reachable.

```tsx
import { render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { NotebookEditor } from './NotebookEditor';
vi.mock('@/lib/webMode', async (original) => ({
  ...await original<typeof import('@/lib/webMode')>(), isGatewayWeb:true
}));
vi.mock('@/lib/artifactFile', async (original) => ({
  ...await original<typeof import('@/lib/artifactFile')>(),
  previewUrl:async () => 'http://localhost/owned-ticket'
}));
afterEach(() => vi.restoreAllMocks());
it('views a gateway notebook without exposing native execution', async () => {
  vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({
    cells:[{cell_type:'code',source:["print('owned')"],outputs:[],metadata:{}}],
    metadata:{},nbformat:4,nbformat_minor:5
  })));
  render(<NotebookEditor path="owned.ipynb" />);
  await screen.findByText("print('owned')");
  expect(screen.queryByLabelText('Run cell 1')).not.toBeInTheDocument();
  expect(screen.queryByRole('button',{name:/save|add cell|delete cell/i})).not.toBeInTheDocument();
});
```

- [ ] Run focused existing package-script tests, for example `pnpm test -- src/app/routes/ProjectsPage.test.tsx src/app/routes/FilesPage.test.tsx src/components/notebook/NotebookEditor.web.test.tsx`: FAIL on currently missing Web controls or native calls. Use actual existing accessible names/mock fixtures when adding assertions, not invented translation keys.
- [ ] Wire existing frontend helpers to Task 14's owned routes. Remove Web-only action hiding for supported metadata operations; keep unsupported native kernel/edit/export-folder/host-file/native-external-project features hidden. Preserve text/HTML/image/PDF/binary preview behavior and scoped original downloads. Active HTML/SVG gets inert preview or restrictive sandbox/CSP; never execute agent-authored content in the application's origin. Phone menus/dialogs wrap within viewport and keep action targets usable.

```tsx
// Use the component's existing mode flag and its existing native control group.
{!isGatewayWeb && (
  <NotebookExecutionControls />
)}
// NotebookExecutionControls is a local extracted existing control block, not a
// new kernel API; retain established props and desktop behavior during extraction.
```

- [ ] Expand the browser test using existing authenticated fixture/browser tooling: A lists its own base/session/project roots, creates/renames/pins/removes metadata, moves an idle session, previews Unicode text/PDF/notebook/image, downloads original bytes with matching hash and sees a clear retry/error under capacity. Test A/B tickets and directories, no cross-account records, at 1280px and 390px. Record no horizontal page overflow and no failing native controls. Avoid real account files; use the rig.
- [ ] Run focused tests, `pnpm typecheck`, `pnpm lint` serially: PASS. Add guarded root `sandbox:web:acceptance` script using the existing probe wrapper and run it after Tasks 16/17. Commit `feat: complete web file and project sandbox compatibility`.

## Task 16: Verify isolation and reuse across the complete capability inventory

**Files:** Create `services/platform/test/tenant-sandbox.acceptance.test.mjs`, `services/platform/test/scientific-environments.acceptance.test.mjs`. Extend `scripts/dev/sandbox-probe.mjs`, rig, test-only synthetic fixtures and Web acceptance. No new production feature surface.

- [ ] Write complete synthetic acceptance cases using the real configured launcher/brokers/worker, not only mocks. Failing cases must leave production/static/auth intact. A deployment prerequisite failure fails the requested case; unit CI may omit explicit privileged acceptance invocation but cannot print a skipped acceptance as PASS.

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSandboxRig } from '../fixtures/sandbox-rig.mjs';
test('common science works offline and cannot mutate the shared image', async () => {
  const rig=await createSandboxRig({caseName:'scientific-environments'});
  try {
    const result=await rig.client.fixturePython(rig.a,{offline:true,source:
      'import numpy,pandas,scipy,matplotlib,sklearn,statsmodels,sympy,nbformat\n'+
      'import matplotlib.pyplot as plt\nplt.plot([1,2]);plt.savefig("plot.png")'});
    assert.equal(result.exitCode,0);
    assert.equal(await rig.client.privateVenvExists(rig.a),false);
    assert.equal(await rig.client.imageUnchanged(),true);
    assert.equal(await rig.client.peerCanaryReadable(rig.a,rig.b),false);
  } finally {await rig.close();}
});
```

- [ ] Add test-only `fixturePython`, `privateVenvExists`, `imageUnchanged`, `peerCanaryReadable` adapters to the rig via authorized runner fixture jobs/file inspection. They are not public production raw-exec endpoints. Capture canary read failure without printing sensitive bytes; generate only synthetic canaries. Run `pnpm sandbox:probe --case acceptance`: expect failing assertions until all cases are implemented and pass.
- [ ] Implement the acceptance matrix below as explicit named probe cases with JSON evidence. The scripted acceptance sequence invokes them serially; low-resource scenarios use a bounded synthetic child workload, not 100 real workers.

| Case | Positive behavior | Negative/failure behavior |
| --- | --- | --- |
| File policy | Owned absolute legacy root, Unicode, internal link, list/preview/hash/download | Traversal, prefix collision, absolute/magic/external links, race swap, FIFO/socket, forged marker/source_path/ticket |
| Raw transport | SDK-used session/event/approval/model routes | Unknown methods/routes, directory in query/header/body, encoded/conflicting inputs, raw file/auth/PTY/control plane |
| Execution | Worker, Python, Shell, plugins/local MCP, Git and managed CLIs function inside sandbox | Host/peer files/processes/sockets/cgroups invisible; no host fallback after outage |
| Network/credentials | Owned SSE, approved public HTTP/packages, model streams | Direct egress, peer/private/metadata/rebinding/IPv6 escapes, foreign/revoked token/model/route and secret exposure |
| Common image | Offline imports/plot; 100 trusted manifests reference one existing image digest/rootfs | Base writes rejected; no per-new-account installs; image hash unchanged |
| Custom dependencies | Same public wheel fetched once, private conflicting versions, source hook stays inside | Upload/mirror/cache pollution, external venv, replay/change-input, unapproved install, failed swap/shebang break |
| Resource failures | Enforced CPU/memory/pids/byte/inode quotas, queue/cancel, healthy auth/static | Controlled OOM/disk-full/fork count, excessive streams/cache, build overlap, orphan processes |
| History/project | Cold restart paths/SQLite/native resume, project metadata/session move, nested snapshot | Metadata removal deletes no data; no remote/push/normal Git state mutation |
| Integrations/UI | Research hashes/leases, attachment history/images, skill discovery; 1280px/390px workflows | Private originals/task envelopes inaccessible; no native-only controls or app-origin active previews |

- [ ] Record image identity, enforced values, fixture IDs, timing/peak cgroup memory, cache upstream artifact fetch count, byte/inode counts, resulting hashes and teardown reconciliation in `.deploy/tenant-sandbox-acceptance/results/`; redact tokens. Verify actual same baseline mount/inode/digest instead of asserting it merely from JSON. Record repeated full private site-packages as expected, not a failed dedup guarantee.
- [ ] Run `pnpm platform:test` for bounded unit/integration files, `pnpm sandbox:core:test --package osd-core`, `pnpm sandbox:core:test --package osd-cli`, `pnpm sandbox:core:test --package osd-sandbox-host`, `pnpm sandbox:probe --case acceptance`, `pnpm sandbox:web:acceptance` serially. PASS plus cleanup with no owned processes/containers/temporary quota mounts. Stop on resource prerequisite failures, keep them as release blockers. Commit `test: verify tenant isolation and scientific dependency reuse`.

## Task 17: Gate each actual runtime with real approvals, streams and resume

**Files:** Modify `scripts/dev/sandbox-probe.mjs`, `services/platform/src/cli-profile.mjs`, `services/platform/test/{sandbox-runner,cli-runtime,model-broker}.test.mjs`; modify `runtime/sandbox/cli-jobs.mjs` only for demonstrated protocol incompatibilities.

- [ ] Add a bounded real-runtime script for OpenCode/Claude/Codex individually, using an explicitly configured synthetic tenant test credential at the external broker. Exact test task: read an owned fixture CSV, run approved Python to write a tiny result/plot, attempt a denied peer-canary access, pause on an install/connection approval, reject it, then complete the local task. No shared administrator credential copied to sandbox or actual paid user session.

```js
// Real-runtime acceptance input, submitted through the ordinary authenticated API.
const prompt = 'Read fixture.csv in this project. Request approval before running '
  + 'Python to write summary.json. Do not install packages without approval. '
  + 'After the local result, stop.';
// Assert server-side permission request with matching tenant/session/generation,
// absence of a result before approval, streamed completion after approval,
// artifact bytes/hash and exact environment record. Then cancel a bounded job,
// verify descendants stopped, restart sandbox and resume its native session.
```

- [ ] Run `pnpm sandbox:probe --case real-runtimes`: configured accepted runtimes must PASS; missing provider/test credentials or unsupported approval/OAuth mode is an explicit release limitation with that mode disabled. It is not evidence that all three work. Enforce one turn per configured positive case plus bounded cancel/resume cases, hard wall time, output/token/cost ceilings and no retries that amplify spend.
- [ ] Exercise original/image attachment input with actual supported runtime protocol, model selector and reasoning variant, known profile identity versus rotated broker token, native session IDs and stream termination. Confirm nested Codex sandbox can run the approved workload inside gVisor without broadening permission defaults. Approval rejection must demonstrably stop the command/install/network operation, not simply show a dialog after execution.
- [ ] Capture sanitized evidence identifying exact binary/image/provider protocol versions, owned files, approval transitions, cancel/resume and no secret patterns. A temporarily unavailable upstream can block one assistant while passing assistants remain usable, but no unavailable mode may fall back to copied credentials or host spawn. Keep a clear administrator-facing reason and avoid promising unsupported subscription-mode compatibility.
- [ ] Re-run changed adapter's guarded tests and full real-runtime case only when its protocol changes justify it. PASS for every enabled production mode. Commit `test: gate managed runtimes on real sandbox approval compatibility`.

## Task 18: Prepare reversible per-account migration and staged release

**Files:** Create `scripts/dev/migrate-tenant-sandboxes.mjs`, `services/platform/test/tenant-migration.test.mjs`. Modify existing startup/config parsing for managed tenant state, root `package.json` guarded migration dry-run script, and `docs/DEPLOYMENT.md` for exact invocation/config when the operational contract changes. Append milestone to `PROGRESS.md`.

- [ ] Test the finite migration states and crash recovery. Export `nextMigrationState(current,event)`; persist migration state outside sandbox storage. Every account has a retained source backup and manifest/checksum inventory, not a bulk destructive move.

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { nextMigrationState } from '../../../scripts/dev/migrate-tenant-sandboxes.mjs';
test('failed verification cannot make an account managed', () => {
  assert.equal(nextMigrationState('copied','verifyFailed'),'blocked');
  assert.throws(() => nextMigrationState('copied','activate'));
  assert.equal(nextMigrationState('verified','activate'),'managed');
  assert.equal(nextMigrationState('managed','runtimeFailed'),'managedUnavailable');
});
```

- [ ] Run `pnpm platform:test test/tenant-migration.test.mjs`: missing module FAIL. Implement states `pending -> drained -> backedUp -> copied -> verified -> managed`; failure before activation => `blocked` with recovery to a known previous checkpoint; failure after => `managedUnavailable`. Do not automatically return a migrated account to host execution. Every transition is atomic/idempotent with a migration generation and owned instance binding.
- [ ] Dry-run inventories existing workspaces, nested `.git`/snapshot refs, project IDs/grouping, SQLite WAL/native history/HOME/skills links, absolute path dependencies and actual usage versus quotas. Reject absent capacity/quota/controllers, unsafe mount sources, raw secret-bearing profiles, unsupported active CLI approvals and missing image/broker health. List broken external venv references for explicit repair; never add their original host directories as mounts.
- [ ] Drain jobs/streams/uploads/install/environment leases, snapshot platform metadata and cold stopped native DB state, copy bytes/history into verified quota-backed tenant storage, compare hashes/counts and old absolute destinations, generate sanitized broker config, cold-start and validate both worker/runner/sidecar plus representative files/history. Preserve originals in a restricted backup outside mounts. Environments needing repair stay visible as repair-needed rather than silently reinstalled. Protect referenced old images until accounts no longer need them.
- [ ] Use a synthetic account first, then a specifically approved pilot account; prepare the concrete migration report before requesting deployment approval. Deploy Web assets through the existing bounded staged build flow only after tests pass; a failed build leaves deployed assets untouched. Account activation is explicit and separately auditable. No unbounded batch warmup, 100 sandboxes or automatic bulk dependency install.
- [ ] Register/run `pnpm sandbox:probe --case migration` on synthetic data: interruption at every state, byte/history/snapshot preservation, failed migration remains recoverable, failed managed launcher blocks execution, original backups/keys not visible, queue/auth/static remain healthy. Run `pnpm sandbox:migrate --dry-run --synthetic`: PASS report with no production mutation. Run final `pnpm typecheck`, `pnpm lint`, `pnpm build` serially only when all source changes are integrated; keep deployed bundle untouched.
- [ ] Commit `feat: prepare reversible tenant sandbox migration`. Append a result-only milestone with exact tests and unresolved limitations. Present the migration/image/resource/browser/runtime evidence and changed-file summary for final deployment approval; do not claim production migration has happened before that action.

## Specification coverage and release gates

The existing specification's 36 capability rows map to these tasks. Use the specification as the canonical detailed inventory; this table keeps the plan auditable without creating another product document.

| Specification concern | Tasks |
| --- | --- |
| Authoritative account/session/project roots; raw proxy/routes/config/events | 2, 5, 9, 12 |
| Files, list/read/tickets/downloads/link races/HTML safety | 3, 7, 11, 13, 15, 16 |
| Project create/list/rename/pin/removal/grouping/session move | 2, 13, 14, 15 |
| Shared baseline/public downloads/private conflicting custom environments | 4, 8, 10, 11, 16 |
| Worker/CLI/MCP/hooks/plugins/Git/local browser process containment | 5–7, 9, 11, 12, 17 |
| Credential/catalog/approval/egress and unsupported remote/native capabilities | 2, 7, 9–11, 15, 17 |
| Research reports/leases, attachments/history/images, private originals, skills | 9, 11, 13, 16, 17 |
| Reproducibility/local Git/environment identity/data/history compatibility | 4, 10, 13, 14, 16–18 |
| Memory/CPU/pids/disk/inodes/cache quotas/build reserve/queue/idle/cancel | 1, 6–8, 10–12, 16 |
| Gateway desktop/phone controls and native-only Web restrictions | 14–16 |
| Safe failure, generation/reconciliation, backup/cutover/recovery | 5, 6, 9, 12, 16–18 |

Before pilot activation, all of these must be demonstrated:

- [ ] Verified immutable rootfs/tool lock and baseline imports offline, no per-account common install.
- [ ] Actual CPU/memory/pids/byte/inode quotas and whole-sandbox ownership; adequate platform/mirror/launcher/build reserve on this host.
- [ ] No host/peer/control/credential access from every executable runtime; race-safe file semantics under gVisor.
- [ ] Network allows required owned streams/public workflows and rejects direct/private/metadata/peer bypasses.
- [ ] Manual command/deletion/install/connection approval works in each enabled runtime; no production approval `off`.
- [ ] Public mirror hits verified by upstream artifact counts; private custom versions and failed transactions remain isolated.
- [ ] Original bytes, projects, native histories/SQLite, nested snapshots and environment identities survive cold restart/migration.
- [ ] Research/attachment/skills integrations and every existing Web file/project control pass at 1280px and 390px.
- [ ] Startup/outage/cancel/OOM/quota/build failures leave platform/static/login/deployed assets intact and never cause host fallback.
- [ ] Synthetic migration/rollback checkpoints verified; production changes await final deployment authorization.

## Planning self-review and known verification limits

The complete plan deliberately keeps one dependency chain because sharing image/cache paths without the tenant boundary would reopen the original vulnerability. The default baseline and download cache solve different forms of duplication; private installed package trees and process RAM are not promised to be globally deduplicated. No per-project microservice, universal environment catalog or new notebook execution UI is required.

The shared image/cache services and selected limits have not been deployed or capacity-tested in this planning turn. The earlier gVisor proofs establish a feasible direction only. Filesystem quota support, CPU controller enforcement, gVisor secure file syscalls, devpi budget/hash/path behavior, actual CLI approval/OAuth adapters, model streams and final migration remain concrete task gates rather than asserted facts.

Planning review checks: exact new/existing path ownership recorded; public versus privileged interfaces finite; foreign-account and positive compatibility tests paired; native controls accounted for; no fallback that revives host execution; dependency/tool/image identities recorded; test commands guarded; attachments/research independent edits acknowledged; deployment remains the final reviewable action. Execute Tasks 1–18 sequentially and update checkboxes only after their expected evidence exists.
