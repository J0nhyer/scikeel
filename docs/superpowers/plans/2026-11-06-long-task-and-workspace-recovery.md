# Long-task latency and workspace recovery — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stabilize the local SciKeel stack against the undici crash, make a
restarted workspace recover without manual repair, give the Web client one
actionable recovery card (including cold login), and remove the blocked
font/network/startup work that inflates long research tasks.

**Architecture:** Pin `undici@8.12.4` and import a fetch polyfill first in the
platform entrypoint (Node 22 LTS stays), retire an observed idle worker only
on recovery-enabled admission, provision a CJK font plus a managed instruction
block through the worker's bind-mounted home/state, and restore the Web
recovery card with a login-overlay handoff. No `runtime/sandbox/*` source
changes; the local startup flags go through the bootstrap-written
`worker-overrides/cli-jobs.mjs`.

**Tech Stack:** Node 22 + undici 8.12.4, Docker Compose, Node test runner,
React + Zustand + Vitest, Radix Dialog, fontTools, matplotlib.

**Spec:** `docs/superpowers/specs/2026-11-06-long-task-and-workspace-recovery-design.md`

## Global Constraints

- Work only on the local Docker stack (`127.0.0.1:18080`). Do not deploy to
  production; record production prerequisites instead.
- Do **not** create any `runtime/sandbox/*` source change. The local startup
  flags live in the bootstrap-written `worker-overrides/cli-jobs.mjs`.
- Do not rebuild the worker/science image. Rebuild only `scikeel-platform:local`
  and `scikeel-sandbox-backend:local`.
- Commit each task separately (the user explicitly requires per-task commits).
  Stage only the files owned by that task; never include the unrelated pending
  notice changes or `PROGRESS.md` in a task commit. Do not push.
- All project files and code are English; discussion is Chinese.
- Run heavy tasks through `node scripts/dev/safe-desktop-task.mjs ...`.
- Preserve workspace files, conversations, credentials, and recoverable state.
- A failed build must leave the running stack untouched.
- `allowRecovery === false` callers must never trigger a worker stop/start.
- The recovery card must not silently restart; the destructive action stays
  user-confirmed.

## Review Focus

- A worker that starts executing between the idle probe and the stop: the stop
  must be limited to `allowRecovery` admission and must fail closed on an
  unverified cleanup.
- A `MEMORY.md` the user edited: the managed block must be replaced in place
  and all user text outside the markers preserved.
- A font whose internal family is `Noto Sans CJK SC`, not `Noto Sans SC`: the
  rc file and instruction must use the family read from the font name table.
- A cold login while the worker is busy: the server overlay must hand off to
  the SPA and the boot gate must show the card, not the generic busy screen.
- A structured workspace failure while an SPA is already open: the card must
  appear in the session pane after the sticky boot gate has stopped covering.

---

### Task 1: Contain the undici crash

**Files:**
- Modify: `services/platform/package.json` (add `"undici": "8.12.4"`)
- Modify: `pnpm-lock.yaml` (lockfile update)
- Create: `services/platform/src/fetch-polyfill.mjs`
- Modify: `services/platform/src/main.mjs` (first import)
- Modify: `services/platform/src/sandbox-control-plane.mjs:245-249`

**Interfaces:**
- Consumes: existing `configureWorker` fetch of `${access.runnerUrl}/profile`;
  `main.mjs` as the platform entrypoint.
- Produces: the platform's global `fetch` is npm undici 8.12.4 (the
  paused-parser fix); the `/profile` response body is always consumed. Node 22
  LTS base images stay unchanged.

- [ ] **Step 1: Record the RED evidence on the bundled fetch**

Run the 70 KB unread-body repro in the repository root with both Node
images and print their bundled undici versions:

```bash
for img in node:22-slim node:24-slim; do
  docker run --rm "$img" node -p "JSON.stringify({node:process.versions.node,undici:process.versions.undici})"
done
```

Then run this script with each image's built-in fetch:

```bash
docker run --rm node:22-slim node -e "
const net=require('node:net');
const s=net.createServer(socket=>{socket.write('HTTP/1.1 200 OK\r\nContent-Length: 70000\r\nConnection: close\r\n\r\n'+'x'.repeat(70000));socket.end()});
s.listen(0,'127.0.0.1',async()=>{fetch('http://127.0.0.1:'+s.address().port).then(r=>console.log('response',r.status));setTimeout(()=>{console.log('STILL_ALIVE');process.exit(0)},2500)});
" 2>&1 | tail -8
```

Repeat with `node:24-slim`. Expected: both print
`AssertionError [ERR_ASSERTION]: ... assert(!this.paused)` and exit nonzero
(measured: 22.23.4/undici 6.29.1 and 24.22.2/undici 7.30.1).

- [ ] **Step 2: Prove the npm undici fix on Node 22 (GREEN)**

```bash
rm -rf /tmp/undici-test && mkdir -p /tmp/undici-test && cd /tmp/undici-test
npm init -y >/dev/null && npm i undici@8.12.4 >/dev/null
cat > repro.mjs <<'EOF'
import { fetch } from 'undici';
import net from 'node:net';
const s=net.createServer(socket=>{socket.write('HTTP/1.1 200 OK\r\nContent-Length: 70000\r\nConnection: close\r\n\r\n'+'x'.repeat(70000));socket.end()});
s.listen(0,'127.0.0.1',async()=>{fetch('http://127.0.0.1:'+s.address().port).then(r=>console.log('response',r.status));setTimeout(()=>{console.log('STILL_ALIVE');process.exit(0)},2500)});
EOF
docker run --rm -v /tmp/undici-test:/test -w /test node:22-slim node repro.mjs
```

Expected: `response 200` and `STILL_ALIVE`, exit 0. (Measured: passes.)

- [ ] **Step 3: Add the dependency and update the lockfile**

Add to `services/platform/package.json` dependencies (exact version, no
caret):

```json
"undici": "8.12.4"
```

Update the lockfile from the repository root:

```bash
npx --yes pnpm@9.4.0 install --lockfile-only --ignore-scripts
```

Expected: `pnpm-lock.yaml` contains an `undici@8.12.4` resolution. If the
lockfile update rewrites unrelated entries, revert those and keep only the new
dependency; record the decision.

- [ ] **Step 4: Create the fetch polyfill**

Create `services/platform/src/fetch-polyfill.mjs`:

```js
import { fetch } from "undici";

globalThis.fetch = fetch;
```

- [ ] **Step 5: Import the polyfill first in the entrypoint**

Make it the first import in `services/platform/src/main.mjs`:

```js
import "./fetch-polyfill.mjs";
```

Keep every other import unchanged. Do not change the Docker CMD or the start
script: all `fetchImpl = fetch` defaults are evaluated at construction, after
this import runs, and the production source entrypoint is the same file.

- [ ] **Step 6: Consume the `/profile` response body**

In `configureWorker`, immediately after the `/profile` fetch (before the `ok`
check), add:

```js
await response.body?.cancel();
```

This is defense in depth for the exact unread-body shape. Keep the existing
`if (!response.ok) throw new Error("managed profile unavailable");`.

- [ ] **Step 7: Rebuild the platform image**

```bash
docker build --platform linux/amd64 -f Dockerfile.platform -t scikeel-platform:local .
```

Expected: exit 0. The image's `pnpm install` installs the pinned undici. Do
not rebuild the sandbox-backend or worker image.

- [ ] **Step 8: Recreate the platform and verify the fix**

```bash
docker compose --env-file .env.docker up -d --no-deps platform
docker exec scikeel-platform node -p "require('undici/package.json').version"
docker exec scikeel-platform node --import ./services/platform/src/fetch-polyfill.mjs -e "
const net=require('node:net');
const s=net.createServer(socket=>{socket.write('HTTP/1.1 200 OK\r\nContent-Length: 70000\r\nConnection: close\r\n\r\n'+'x'.repeat(70000));socket.end()});
s.listen(0,'127.0.0.1',async()=>{fetch('http://127.0.0.1:'+s.address().port).then(r=>console.log('response',r.status));setTimeout(()=>{console.log('STILL_ALIVE');process.exit(0)},2500)});
"
```

Expected: `8.12.4`, `response 200`, `STILL_ALIVE`, exit 0, no assertion. (The
`--import` uses the same polyfill the platform entrypoint imports.)

- [ ] **Step 9: Verify the platform still serves the workspace**

```bash
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18080/health
```

Expected: 200. If the workspace status is not healthy, use the confirmed
restart path once and record it.

---

### Task 2: Retire an observed idle orphan on recovery-enabled admission

**Files:**
- Modify: `services/platform/src/managed-worker-manager.mjs` (`#observe`,
  `#start`, `ensureWorker`, new `#retireObservedIdle`)
- Test: `services/platform/test/managed-worker-manager.test.mjs`

**Interfaces:**
- Consumes: `this.client.inspect`, `this.client.stop`, `this.#retired`,
  `this.#idleState`, `this.#context`.
- Produces: `record.observed: boolean`; `#retireObservedIdle(record):
  Promise<boolean>`; `ensureWorker` starts a fresh generation after a verified
  idle retirement. `allowRecovery: false` rejects with
  `workspace_recovery_required` and performs no stop/start.

- [ ] **Step 1: Write the failing idle-orphan test**

Add to `managed-worker-manager.test.mjs`:

```js
test("an observed idle orphan is retired and replaced on recovery admission", async t => {
  const f = fixture(); t.after(() => f.manager.close());
  f.records.set("user-a", { instanceId: "user-a", userId: "a", generation: 4, status: "ready" });
  f.manager.fetchImpl = async () => ({ ok: true, json: async () => ({}) }); // every session idle
  const worker = await f.manager.ensureWorker({ instanceId: "user-a", userId: "a" });
  assert.deepEqual(f.calls.filter(([op]) => op === "stop").map(([, args]) => args),
    [{ instanceId: "user-a", generation: 4, reason: "managed-retire" }]);
  assert.equal(f.calls.filter(([op]) => op === "start").length, 1);
  assert.equal(worker.status, "running");
  assert.equal(worker.generation, 5);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run:

```bash
node scripts/dev/safe-desktop-task.mjs platform-test test/managed-worker-manager.test.mjs
```

Expected: FAIL — today the observed record is reported `unresponsive` and no
stop occurs.

- [ ] **Step 3: Add the observed flag**

In `#observe`, after `record.generation = inspected.generation`, set
`record.observed = true`. In `#start`, after the health check succeeds and
`record.status = "running"`, set `record.observed = false`.

- [ ] **Step 4: Implement `#retireObservedIdle`**

Add the private method:

```js
async #retireObservedIdle(record) {
  let inspected;
  try { inspected = await this.client.inspect({ instanceId: record.id }, { timeoutMs: 3000 }); }
  catch { return false; }
  if (inspected?.instanceId !== record.id || inspected.generation !== record.generation ||
      inspected.status !== "ready" || typeof inspected.endpoint !== "string" ||
      typeof inspected.internalToken !== "string") return false;
  const probe = { ...record, url: inspected.endpoint, token: inspected.internalToken, status: "running" };
  try { if ((await this.#idleState(probe)).state !== "idle") return false; }
  catch { return false; }
  const context = this.#context(record);
  try { await this.client.stop({ instanceId: record.id, generation: record.generation, reason: "managed-retire" }); }
  catch { throw recoveryError("workspace_cleanup_unverified", { context }); }
  if (!(await this.#retired(record.id))) throw recoveryError("workspace_cleanup_unverified", { context });
  record.generation = null; record.status = "stopped"; record.observed = false;
  delete record.token; delete record.url; delete record.runnerUrl;
  return true;
}
```

`#idleState` already accepts a record-shaped object with `url`, `token`,
`userId`, `instanceId`, `generation`.

- [ ] **Step 5: Call it from `ensureWorker`**

After `await this.#observe(record)` and before the `record.generation === null`
branch:

```js
if (record.observed) {
  if (!allowRecovery) throw recoveryError("workspace_recovery_required", { context: this.#context(record) });
  if (await this.#retireObservedIdle(record)) return this.#start(record);
}
```

- [ ] **Step 6: Add the busy, disabled-recovery, and failed-stop tests**

```js
test("a busy observed orphan is not stopped", async t => {
  const f = fixture(); t.after(() => f.manager.close());
  f.records.set("user-a", { instanceId: "user-a", userId: "a", generation: 4, status: "ready" });
  f.manager.fetchImpl = async () => ({ ok: true, json: async () => ({ ses: { type: "busy" } }) });
  await assert.rejects(f.manager.ensureWorker({ instanceId: "user-a", userId: "a" }),
    error => error.code === "runtime_unresponsive");
  assert.equal(f.calls.filter(([op]) => op === "stop").length, 0);
});

test("recovery-disabled admission never stops an observed orphan", async t => {
  const f = fixture(); t.after(() => f.manager.close());
  f.records.set("user-a", { instanceId: "user-a", userId: "a", generation: 4, status: "ready" });
  await assert.rejects(f.manager.ensureWorker({ instanceId: "user-a", userId: "a", allowRecovery: false }),
    error => error.code === "workspace_recovery_required");
  assert.equal(f.calls.filter(([op]) => op === "stop").length, 0);
  assert.equal(f.calls.filter(([op]) => op === "start").length, 0);
});

test("an unverified orphan stop fails closed", async t => {
  const f = fixture(); t.after(() => f.manager.close());
  f.records.set("user-a", { instanceId: "user-a", userId: "a", generation: 4, status: "ready" });
  f.manager.fetchImpl = async () => ({ ok: true, json: async () => ({}) });
  f.manager.client.stop = async () => { throw new Error("stop refused"); };
  await assert.rejects(f.manager.ensureWorker({ instanceId: "user-a", userId: "a" }),
    error => error.code === "workspace_cleanup_unverified");
});
```

- [ ] **Step 7: Run the manager tests**

```bash
node scripts/dev/safe-desktop-task.mjs platform-test test/managed-worker-manager.test.mjs
```

Expected: PASS. If the fixture's `stop` increments the generation, the final
generation is 5; adjust only the test expectation if the fixture differs.

---

### Task 3: Stop the five-second monitor timeout storm

**Files:**
- Modify: `services/platform/src/platform-server.mjs:1918` (timeout) and the
  tick logger at `:694-696`
- Test: `services/platform/test/platform-server.test.mjs`

**Interfaces:**
- Produces: `RESEARCH_REQUEST_TIMEOUT_MS = 15000`;
  `createMonitorErrorLogger({ now = Date.now, write, intervalMs = 60000 })`
  returns `(error) => void` that writes at most once per interval for the same
  message.
- Consumes: the tick catch calls the logger instead of `this.logger` directly.

- [ ] **Step 1: Write the dedupe failing test**

Add a focused test in `platform-server.test.mjs` (import
`createMonitorErrorLogger` from `../src/platform-server.mjs`):

```js
test("identical monitor failures are logged at most once per interval", () => {
  let now = 1000; const lines = [];
  const log = createMonitorErrorLogger({ now: () => now, write: message => lines.push(message), intervalMs: 60000 });
  log(new Error("The operation was aborted due to timeout"));
  now += 2000; log(new Error("The operation was aborted due to timeout"));
  now += 60000; log(new Error("The operation was aborted due to timeout"));
  now += 2000; log(new Error("different failure"));
  assert.deepEqual(lines, [
    "The operation was aborted due to timeout",
    "The operation was aborted due to timeout",
    "different failure",
  ]);
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
node scripts/dev/safe-desktop-task.mjs platform-test test/platform-server.test.mjs
```

Expected: FAIL — `createMonitorErrorLogger` is not exported.

- [ ] **Step 3: Implement the logger and timeout**

Export `createMonitorErrorLogger` from `platform-server.mjs` with the signature
above. Use it in the tick catch:

```js
const monitorLog = createMonitorErrorLogger({
  write: message => logger({ type: "research.monitor_error", error: message }),
});
```

Replace the direct `logger(...)` in the tick catch with
`monitorLog(error)`.

Change the `AbortSignal.timeout(5000)` at
`#workerResearchRequest` to `AbortSignal.timeout(RESEARCH_REQUEST_TIMEOUT_MS)`
with `export const RESEARCH_REQUEST_TIMEOUT_MS = 15000;`.

- [ ] **Step 4: Run the platform tests**

```bash
node scripts/dev/safe-desktop-task.mjs platform-test
```

Expected: PASS (the full platform suite; no new failures).

---

### Task 4: Provision the CJK font and the managed instruction block

**Files:**
- Create: `runtime/fonts/NotoSansCJKsc-Regular-subset.otf`
- Create: `runtime/fonts/OFL.txt`
- Create: `services/platform/src/worker-assets.mjs`
- Create: `services/platform/test/worker-assets.test.mjs`
- Modify: `Dockerfile.platform` (add `COPY runtime/fonts runtime/fonts`)
- Modify: `services/platform/src/sandbox-control-plane.mjs` (`configureWorker`)

**Interfaces:**
- Produces:
  - `export function upsertManagedBlock(existing: string, block: string): string`
  - `export function managedInstructionBlock(fontPath: string): string`
  - `export function matplotlibrc(fontFamily: string): string`
  - `export async function provisionWorkerAssets({ dataDir, roots, context, sourceDir }): Promise<void>`
  - Fixed paths: `<roots.instances>/<instanceId>/state/runtime/xdg-config/opencode/MEMORY.md`,
    `<roots.native>/<userId>/home/.local/share/fonts/NotoSansCJKsc-Regular-subset.otf`,
    `<roots.native>/<userId>/home/.cache/matplotlib/matplotlibrc`.
- Consumes: `configureWorker` calls `provisionWorkerAssets` before posting the
  profile.

- [ ] **Step 1: Download and subset the font**

Use the host proxy and the science environment's fontTools:

```bash
curl -x http://127.0.0.1:7897 -L --max-time 120 -o /tmp/NotoSansCJKsc-Regular.otf \
  https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf
WORKER=scikeel-worker-user-usr_266aff73fb8a09b836dbc10d-g28
docker cp /tmp/NotoSansCJKsc-Regular.otf "$WORKER:/tmp/font.otf"
docker exec "$WORKER" /opt/scikeel/science/bin/python3 -m fontTools.subset /tmp/font.otf \
  --unicodes='U+0020-007E,U+00A0-00FF,U+2000-206F,U+3000-303F,U+4E00-9FFF,U+FF00-FFEF' \
  --layout-features='*' --output-file=/tmp/subset.otf
docker cp "$WORKER:/tmp/subset.otf" runtime/fonts/NotoSansCJKsc-Regular-subset.otf
```

If the subset exceeds 8 MB, generate a GB2312-level-1 character text file and
use `--text-file=...` instead of the `4E00-9FFF` range. Record the final size.

Read the family name from the font name table (expected **`Noto Sans CJK SC`**):

```bash
docker cp runtime/fonts/NotoSansCJKsc-Regular-subset.otf "$WORKER:/tmp/subset.otf"
docker exec "$WORKER" /opt/scikeel/science/bin/python3 -c \
 "from fontTools.ttLib import TTFont; print(TTFont('/tmp/subset.otf')['name'].getDebugName(1))"
```

Put the OFL license text from the Noto CJK repository into
`runtime/fonts/OFL.txt`.

- [ ] **Step 2: Write the failing asset tests**

Create `services/platform/test/worker-assets.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upsertManagedBlock, provisionWorkerAssets } from "../src/worker-assets.mjs";

const BEGIN = "<!-- scikeel:managed:begin -->";
const END = "<!-- scikeel:managed:end -->";

test("the managed block replaces in place and preserves user text", () => {
  const existing = "user top\n" + BEGIN + "\nold\n" + END + "\nuser bottom\n";
  const merged = upsertManagedBlock(existing, "new");
  assert.equal(merged, "user top\n" + BEGIN + "\nnew\n" + END + "\nuser bottom\n");
  assert.equal(upsertManagedBlock(merged, "new"), merged);
  assert.equal(upsertManagedBlock("", "new"), BEGIN + "\nnew\n" + END + "\n");
});

test("worker assets are provisioned once and stay idempotent", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "scikeel-assets-"));
  const roots = { instances: join(dataDir, "workers/instances"), native: join(dataDir, "cli-runtime/users") };
  const sourceDir = join(dataDir, "fonts"); await mkdir(sourceDir, { recursive: true });
  await writeFile(join(sourceDir, "NotoSansCJKsc-Regular-subset.otf"), "font-bytes");
  const context = { userId: "u1", instanceId: "user-u1", generation: 3 };
  await provisionWorkerAssets({ dataDir, roots, context, sourceDir });
  await provisionWorkerAssets({ dataDir, roots, context, sourceDir });
  const memory = await readFile(join(roots.instances, "user-u1/state/runtime/xdg-config/opencode/MEMORY.md"), "utf8");
  assert.equal(memory.split(BEGIN).length, 2);
  assert.match(memory, /bash has no outbound network/);
  assert.match(await readFile(join(roots.native, "u1/home/.cache/matplotlib/matplotlibrc"), "utf8"), /Noto Sans CJK SC/);
  assert.equal(await readFile(join(roots.native, "u1/home/.local/share/fonts/NotoSansCJKsc-Regular-subset.otf"), "utf8"), "font-bytes");
});
```

- [ ] **Step 3: Run the tests and confirm they fail**

```bash
node scripts/dev/safe-desktop-task.mjs platform-test test/worker-assets.test.mjs
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement `worker-assets.mjs`**

Create the module with:

- `BEGIN`/`END` markers as above.
- `upsertManagedBlock(existing, block)`:
  - if both markers exist, replace between them (inclusive of the old body,
    exclusive of the markers) and keep everything outside;
  - if not, append `BEGIN + "\n" + block + "\n" + END + "\n"` to the existing
    text (no extra blank line handling beyond this).
- `managedInstructionBlock(fontPath)` with these exact rules:
  - "The bash tool has no outbound network. `curl`, `wget`, `pip`, `npm` and
    raw sockets fail with 403. Do not retry them."
  - "Use `webfetch`/`websearch` for network access; package installation is
    the workbench environment feature."
  - "A CJK font is available at `<fontPath>`. If matplotlib reports missing
    glyphs, call `font_manager.fontManager.addfont(path)` and include
    `Noto Sans CJK SC` in `font.sans-serif` (read the actual family name from
    the font)."
  - "After applying the publication style, re-add the family because the
    style sets `font.sans-serif`."
  - "Run a figure layout check at most twice; if it still fails, simplify the
    figure or document the limitation instead of repeating the full analysis."
- `matplotlibrc(fontFamily)` returns:
  `font.family: sans-serif\nfont.sans-serif: <family>, Inter, Helvetica Neue, Arial, sans-serif\naxes.unicode_minus: False\n`
- `provisionWorkerAssets({ dataDir, roots, context, sourceDir = fileURLToPath(new URL("../../../runtime/fonts/", import.meta.url)) })`:
  - resolve `instances = roots?.instances ?? join(dataDir, "workers/instances")`
    and `native = roots?.native ?? join(dataDir, "cli-runtime/users")`;
  - copy `sourceDir/NotoSansCJKsc-Regular-subset.otf` to
    `native/<userId>/home/.local/share/fonts/...` (mkdir 0700, file 0644);
  - write `native/<userId>/home/.cache/matplotlib/matplotlibrc` (0644);
  - read the existing MEMORY.md (empty if absent), upsert the block, write
    0644;
  - all operations idempotent; do not touch other files.
- Use `node:fs/promises`, `node:path`, and `node:url` only.

- [ ] **Step 5: Wire provisioning into `configureWorker`**

In `sandbox-control-plane.mjs`, immediately before the `runnerProtocol(access)`
call:

```js
await provisionWorkerAssets({
  dataDir,
  roots: configuration.roots,
  context,
});
```

Import `provisionWorkerAssets` at the top.

- [ ] **Step 6: Add the font to the platform image**

In `Dockerfile.platform`, after `COPY runtime/skills runtime/skills`, add:

```dockerfile
COPY runtime/fonts runtime/fonts
```

- [ ] **Step 7: Run the asset and control-plane tests**

```bash
node scripts/dev/safe-desktop-task.mjs platform-test test/worker-assets.test.mjs test/sandbox-control-plane.test.mjs
```

Expected: PASS.

---

### Task 5: Skip the blocked model-metadata fetch in local workers

**Files:**
- Modify: `scripts/dev/bootstrap-docker.mjs` (`patchedWorkerJobs`)
- Test: `scripts/dev/bootstrap-docker.test.mjs`

**Interfaces:**
- Produces: the local `worker-overrides/cli-jobs.mjs` sets
  `OPENCODE_DISABLE_MODELS_FETCH = "1"` and
  `OPENCODE_DISABLE_AUTOUPDATE = "1"` in `buildJobEnvironment`.
- Consumes: the existing sandbox-backend bind of
  `.local/data/worker-overrides/cli-jobs.mjs`.

- [ ] **Step 1: Write the failing bootstrap test**

Add to `bootstrap-docker.test.mjs`:

```js
test("the local worker override disables blocked model metadata fetches", () => {
  const patched = patchedWorkerJobs('const env = { PATH: "unchanged" };\nreturn env;\n');
  assert.match(patched, /OPENCODE_DISABLE_MODELS_FETCH = "1"/);
  assert.match(patched, /OPENCODE_DISABLE_AUTOUPDATE = "1"/);
  assert.match(patched, /PATH: "unchanged"/);
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
node scripts/dev/safe-desktop-task.mjs release-test scripts/dev/bootstrap-docker.test.mjs
```

Expected: FAIL — the flags are absent.

- [ ] **Step 3: Extend `patchedWorkerJobs`**

After the existing BLAS replacements, replace the first `return env;` with:

```js
env.OPENCODE_DISABLE_MODELS_FETCH = "1";
env.OPENCODE_DISABLE_AUTOUPDATE = "1";
return env;
```

Keep the patch idempotent (running it twice must not duplicate).

- [ ] **Step 4: Run the bootstrap test**

```bash
node scripts/dev/safe-desktop-task.mjs release-test scripts/dev/bootstrap-docker.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Rewrite the local override and restart the worker**

Run the bootstrap (idempotent) to rewrite
`.local/data/worker-overrides/cli-jobs.mjs`:

```bash
node scripts/dev/bootstrap-docker.mjs
```

Then restart the worker through the recovery API (the UI's confirmed restart
path) with the admin cookie, or wait for the next worker start. Record the
`workspace.startup_stage readiness` elapsed from the platform logs before
(17.9 s) and after. Expected: a measurable drop. If the gap remains, inspect
the OpenCode log to see whether it is the models.dev fetch (gone) or the npm
plugin install (remains); do not change `runtime/sandbox/*`.

---

### Task 6: Restore the Web recovery card and the cold-login handoff

**Files:**
- Create: `apps/desktop/src/components/session/WorkspaceRecoveryActions.tsx`
  (restore from `git show 2db54b4a^:apps/desktop/src/components/session/WorkspaceRecoveryActions.tsx`)
- Create: `apps/desktop/src/components/session/WorkspaceRecoveryActions.test.tsx`
  (adapt the same historical test)
- Modify: `apps/desktop/src/components/boot/PlatformBootGate.tsx`
- Modify: `apps/desktop/src/components/session/SessionView.tsx`
- Modify: `apps/desktop/src/lib/loginPreparation.ts`
- Modify: `services/platform/src/login-page.mjs`
- Test: `apps/desktop/src/components/boot/PlatformBootGate.test.tsx`,
  `apps/desktop/src/lib/loginPreparation.test.ts`,
  `services/platform/test/login-page.test.mjs`

**Interfaces:**
- Produces: `WorkspaceRecoveryActions({ report, waiting? })`; the
  `scikeel:login-recovery` handoff event; `PlatformBootGate` renders the card
  on a structured workspace failure; `SessionView` renders it after a live
  SPA loses the workspace.
- Consumes: `useRuntimeStore.connectRetry`,
  `useRuntimeStore.restartGatewayWorkspace`,
  `useRuntimeStore.gatewayWorkspaceReport`,
  `useRuntimeStore.gatewayWorkspaceFailure`,
  `setPlatformWorkspaceGeneration`, `isPlatformWeb`, `isGatewayWeb`.

- [ ] **Step 1: Restore the component and its test**

Restore the historical files, then update imports to the current store if
needed. The component must:

- render `null` outside platform Web;
- show the state copy from `live.recovery.states.<state>` (use
  `capacityWaiting` when `waiting` is true);
- show the cooldown copy when `retryAfterMs > 0`;
- have a retry button that resets `gatewayContext` and
  `setPlatformWorkspaceGeneration(null)` then calls `connectRetry()`;
- show the restart button only when
  `report.state === "unresponsive" && report.canRestart && report.context &&
  report.activity !== "maintenance" && report.retryAfterMs === 0`;
- confirm restart in a Radix Dialog with the existing
  `sharedImpact`/`interruptWarning`/`confirmRestart`/`cancel` copy, then call
  `restartGatewayWorkspace(context)`;
- use `z-[110]` for the dialog overlay and `z-[120]` for the content so the
  dialog sits above the boot gate's `z-[100]` surface;
- disable actions while `gatewayRestartPending` or retrying.

- [ ] **Step 2: Run the component test and confirm it fails**

```bash
node scripts/dev/safe-desktop-task.mjs test src/components/session/WorkspaceRecoveryActions.test.tsx
```

Expected: FAIL until the component exists.

- [ ] **Step 3: Render the card in the boot gate**

In `PlatformBootGate.tsx`, subscribe to `gatewayWorkspaceReport`. In the
`failed` branch:

- if `isWorkspaceReport(report)` and the report is not `healthy`, render
  `{children}` plus a fixed overlay containing
  `<WorkspaceRecoveryActions report={report} waiting={report.state === "capacity"} />`;
- otherwise keep the existing generic `live.boot.busy` + retry.

Do not cover the card with a second overlay. Keep the sticky `firstReady`
behavior. The login-page handoff removes `data-scikeel-login-preparing`; if
the gate does not re-render on that DOM change in the live check, add a
`handedOff` state set by a `scikeel:login-recovery` listener and include it in
`enabled`. Do not add it preemptively if the store update already re-renders.

- [ ] **Step 4: Render the card in the session pane**

In `SessionView.tsx`, add:

```tsx
const gatewayWorkspaceReport = useRuntimeStore((s) => s.gatewayWorkspaceReport);
```

and, before the existing disconnected-runtime card:

```tsx
{!connected && !connecting && isGatewayWeb && focused &&
  <WorkspaceRecoveryActions report={gatewayWorkspaceReport} />}
```

Import the component.

- [ ] **Step 5: Map a confirm_restart failure to an unresponsive report, then add the login handoff**

In `runtime.ts`, change `reportFailure` so a structured failure with
`action === "confirm_restart"` becomes a restartable report. Today it maps
every non-capacity failure to `state: "unknown"`, `canRestart: false`, which
hides the restart button on the cold-login path:

```ts
const reportFailure = (failure: WorkspaceFailure | null): WorkspaceReport => ({
  context: failure?.context ?? null,
  state: failure?.code === "workspace_capacity_unavailable" ? "capacity"
    : failure?.action === "confirm_restart" ? "unresponsive" : "unknown",
  activity: "unknown",
  canRestart: failure?.action === "confirm_restart" && !!failure?.context && failure.retryAfterMs === 0,
  retryAfterMs: failure?.retryAfterMs ?? 0,
});
```

In `loginPreparation.ts`:

- add `gatewayWorkspaceReport?: WorkspaceReport | null` to
  `PreparationState`;
- in `update`, before the generic error branch, add:

```ts
if (state.status === "error" && state.gatewayWorkspaceReport)
  finish("scikeel:login-recovery");
else if (state.status === "error" || ...) finish("scikeel:login-error");
```

- extend `finish` to accept `"scikeel:login-recovery"` and set
  `finished = true`, unsubscribe, and dispatch it.

In `login-page.mjs`, in `withLoginPreparation`, define the existing `handoff`
closure and add:

```js
document.addEventListener('scikeel:login-recovery', handoff, { once: true });
```

next to the `scikeel:login-ready` listener.

- [ ] **Step 6: Add the tests**

- `loginPreparation.test.ts`: a state with `status: "error"` and a valid
  report dispatches `scikeel:login-recovery`; without the report it dispatches
  `scikeel:login-error`.
- `login-page.test.mjs`: dispatching `scikeel:login-recovery` removes
  `#scikeel-login-preparation`, removes `data-scikeel-login-preparing`, and
  clears `root.inert`.
- `PlatformBootGate.test.tsx`: a store with `status: "error"` and a valid
  unresponsive report renders the recovery card; a generic error still renders
  the generic busy copy.
- `WorkspaceRecoveryActions.test.tsx`: restart is hidden without
  `canRestart`, shown with it, and confirmation calls
  `restartGatewayWorkspace` with the report context.
- `runtime.store.test.ts`: a `GatewayWorkspaceError` with `action:
  "confirm_restart"` and a context produces
  `gatewayWorkspaceReport.state === "unresponsive"` and
  `canRestart === true`; a generic failure still produces `unknown` and
  `canRestart === false`.
- `SessionView.launch.test.tsx`: with `webMode.enabled = true`, status
  `"error"`, and a disconnected unresponsive report, the pane renders the
  recovery card; restore the store state in `afterEach` like the existing
  tests.

- [ ] **Step 7: Run targeted frontend tests, typecheck, and lint**

```bash
node scripts/dev/safe-desktop-task.mjs test src/components/session/WorkspaceRecoveryActions.test.tsx src/components/boot/PlatformBootGate.test.tsx src/lib/loginPreparation.test.ts
node scripts/dev/safe-desktop-task.mjs typecheck
node scripts/dev/safe-desktop-task.mjs lint
```

Expected: PASS; lint may retain the single pre-existing warning.

- [ ] **Step 8: Build and publish the Web bundle locally**

```bash
node scripts/dev/safe-desktop-task.mjs web-build
```

Sync the printed staging directory into `apps/desktop/dist` with
`rsync -a --delete <stage>/ apps/desktop/dist/` so the existing bind mount
keeps its inode.

- [ ] **Step 9: Verify in the browser**

Use `apps/desktop:verify` for the component and the running app at
`http://127.0.0.1:18080` for the cold-login path. At minimum:

- the card renders at desktop and phone widths;
- retry and restart controls are reachable and not covered by the boot gate;
- a cold login with a structured failure hands off to the card.

---

### Task 7: Rebuild, live acceptance, and progress

**Files:**
- Modify: `PROGRESS.md` (one new line on top)

**Interfaces:**
- Consumes: all prior tasks.
- Produces: measured local acceptance and a progress entry.

- [ ] **Step 1: Rebuild and recreate the platform**

```bash
docker build --platform linux/amd64 -f Dockerfile.platform -t scikeel-platform:local .
docker compose --env-file .env.docker up -d --no-deps platform
```

If the sandbox-backend image was rebuilt in Task 1, recreate it too. Verify
`docker exec scikeel-platform node -v` and `/health`.

- [ ] **Step 2: Verify the idle orphan auto-recovery**

Ensure no turn is active. Restart the platform container only
(`docker compose --env-file .env.docker restart platform` or the maintenance
path if this were the production host). Then log in through
`http://127.0.0.1:18080` and check:

- `/api/workspace/status` becomes `healthy`;
- a new worker generation starts;
- the platform log has no repeated `runtime_unresponsive` storm.

- [ ] **Step 3: Verify the cold-login recovery card**

Start a turn that stays busy for about a minute (for example, ask the agent to
run a 60-second sleep and then answer). While it runs, restart the platform.
Open a new incognito window, log in, and confirm the login overlay hands off to
the SPA and the recovery card appears. Do not confirm a destructive restart
unless the turn is a throwaway; if you do, verify the workspace recovers.

- [ ] **Step 4: Verify the CJK figure**

Create a throwaway session and ask for a small Chinese figure, for example:
"用中文画一张简单的正弦曲线图，保存为 figure.png". Confirm:

- the agent does not attempt `curl`/`pip`/font downloads;
- the figure renders Chinese labels with the provisioned font;
- the managed instruction block is present in the worker's MEMORY.md.

- [ ] **Step 5: Verify startup and monitor behavior**

Read the latest `workspace.startup_stage readiness` elapsed; compare with
17.9 s. During the busy turn, check that `research.monitor_error` does not
recur every tick and that no 5 s timeout breaks the tick.

- [ ] **Step 6: Run the final targeted checks**

```bash
node scripts/dev/safe-desktop-task.mjs platform-test
node scripts/dev/safe-desktop-task.mjs typecheck
node scripts/dev/safe-desktop-task.mjs lint
```

Record any pre-existing failure separately.

- [ ] **Step 7: Append the progress line**

Add one line at the top of `PROGRESS.md` with the timestamp, the crash fix,
the recovery behavior, the font/instruction result, the measured startup
change, and the verification outcome. Do not claim production publication.

- [ ] **Step 8: Report**

Separate implementation, tests, local deployment, and live acceptance. State
what passed, what was measured, and what remains a production follow-up
(production must install the pinned undici, and the next worker image build
carries the startup flags).
