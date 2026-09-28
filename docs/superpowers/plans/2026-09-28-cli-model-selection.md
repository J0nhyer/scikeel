# CLI and Model Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let every Web user choose OpenCode, Claude Code, or Codex and then choose an administrator-enabled model for that CLI, while only administrators can edit Claude Code/Codex model catalogs and defaults.

**Architecture:** Extend the existing private `runtime.json` store to version 3 and keep per-user runtime/model choices in `CliRuntimeManager`. The managed CLI facade exposes the existing OpenCode model protocol (`/global/config` and `/config/providers`), so the SDK, settings model browser, and composer model picker work without a second model subsystem. A focused admin-only settings card edits Claude Code and Codex catalogs through `/api/admin/runtime`.

**Tech Stack:** Node.js ESM control plane, Node test runner, React 18, TypeScript, Zustand, Vitest, Testing Library, i18next, existing `OpenCodeClient` SDK.

---

## File Structure

- `services/platform/src/cli-runtime.mjs` — version 3 configuration, model validation, per-user model choices, CLI arguments, and managed model endpoints.
- `services/platform/src/platform-server.mjs` — authenticated user selection and administrator-only catalog APIs.
- `services/platform/fixtures/fake-cli.mjs` — deterministic model-argument validation.
- `services/platform/test/cli-runtime.test.mjs` — migration, fallback, persistence, and command tests.
- `services/platform/test/platform-server.test.mjs` — API authorization and model-surface integration tests.
- `apps/desktop/src/lib/runtime.ts` — gateway role/catalog state.
- `apps/desktop/src/components/settings/ManagedRuntimeModelsCard.tsx` — admin editor.
- `apps/desktop/src/components/settings/ManagedRuntimeModelsCard.test.tsx` — admin editor tests.
- `apps/desktop/src/app/routes/SettingsPage.tsx` — CLI/model controls and admin composition.
- `apps/desktop/src/app/routes/SettingsPage.web.test.tsx` — user/admin visibility tests.
- `apps/desktop/src/components/session/SessionView.tsx` — managed CLI model-picker visibility.
- `apps/desktop/src/components/session/SessionView.launch.test.tsx` — managed CLI composer visibility test.
- `apps/desktop/src/components/thread/ModelPicker.test.tsx` — managed model selection test.
- `apps/desktop/src/i18n/locales/*/settings.json` — managed-catalog text.
- `docs/rfc/internal-multi-user-platform.md` and `PROGRESS.md` — verified result.

### Task 1: Persist Version 3 Managed Model Configuration

**Files:**
- Modify: `services/platform/test/cli-runtime.test.mjs`
- Modify: `services/platform/src/cli-runtime.mjs`

- [ ] **Step 1: Write failing migration and selection tests**

Add these behaviors to `cli-runtime.test.mjs`:

```js
test("migrates version 2 runtime choices and seeds managed model catalogs", async () => {
  const { root, manager } = await makeManager("opencode");
  await mkdir(join(root, "runtime"), { recursive: true });
  await writeFile(
    join(root, "runtime", "runtime.json"),
    `${JSON.stringify({
      version: 2,
      defaultRuntime: "opencode",
      userRuntimes: { usr_a: "codex" },
    })}\n`,
  );
  await manager.init();
  assert.equal(manager.describe("usr_a").runtime, "codex");
  assert.deepEqual(manager.adminDescribe().managedRuntimes, {
    claude: { models: ["admin-model"], defaultModel: "admin-model" },
    codex: { models: ["admin-model"], defaultModel: "admin-model" },
  });
  const saved = JSON.parse(await readFile(join(root, "runtime", "runtime.json"), "utf8"));
  assert.equal(saved.version, 3);
  assert.equal(saved.userRuntimes.usr_a, "codex");
});

test("remembers one enabled managed model per user and runtime", async () => {
  const { manager } = await makeManager("opencode");
  await manager.init();
  await manager.setManagedRuntime("codex", ["gpt-fast", "gpt-deep"], "gpt-fast");
  await manager.setManagedRuntime("claude", ["sonnet", "opus"], "sonnet");
  await manager.setUserRuntime("usr_a", "codex", "gpt-deep");
  await manager.setUserModel("usr_a", "claude", "opus");
  assert.equal(manager.describe("usr_a").model, "gpt-deep");
  assert.equal(manager.modelForUser("usr_a", "claude"), "opus");
});

test("falls back to the new default when an administrator removes a selected model", async () => {
  const { manager } = await makeManager("opencode");
  await manager.init();
  await manager.setManagedRuntime("codex", ["gpt-fast", "gpt-deep"], "gpt-fast");
  await manager.setUserRuntime("usr_a", "codex", "gpt-deep");
  await manager.setManagedRuntime("codex", ["gpt-fast"], "gpt-fast");
  assert.equal(manager.modelForUser("usr_a", "codex"), "gpt-fast");
  assert.equal(manager.describe("usr_a").model, "gpt-fast");
});
```

- [ ] **Step 2: Run RED test**

Run: `node --test services/platform/test/cli-runtime.test.mjs`

Expected: FAIL because version 3 model methods do not exist.

- [ ] **Step 3: Add model normalization and version 3 state**

Add:

```js
const MANAGED_RUNTIMES = new Set(["claude", "codex"]);
const MAX_MODEL_ID_LENGTH = 160;

function normalizeModelId(value) {
  if (typeof value !== "string") throw issue("invalid_model", "model must be a string");
  const model = value.trim();
  if (!model || model.length > MAX_MODEL_ID_LENGTH || /[\r\n\0]/.test(model)) {
    throw issue("invalid_model", "model must be 1-160 characters on one line");
  }
  return model;
}

function normalizeModelList(values) {
  if (!Array.isArray(values)) throw issue("invalid_models", "models must be an array");
  return [...new Set(values.map(normalizeModelId))];
}
```

Initialize `userModels` and `managedRuntimes`. Load version 3 directly. Migrate version 2 while preserving `defaultRuntime` and `userRuntimes`; seed Claude from `settings.json.model` and Codex from the first top-level `model = "value"` in `config.toml`. Persist:

```js
const snapshot = {
  version: 3,
  defaultRuntime: this.defaultRuntime,
  userRuntimes: Object.fromEntries([...this.userRuntimes].sort(([a], [b]) => a.localeCompare(b))),
  userModels: Object.fromEntries([...this.userModels].sort(([a], [b]) => a.localeCompare(b))),
  managedRuntimes: structuredClone(this.managedRuntimes),
};
```

- [ ] **Step 4: Add catalog and selection methods**

Implement:

```js
modelForUser(userId, runtime = this.runtimeForUser(userId)) {
  assertUserId(userId);
  if (!MANAGED_RUNTIMES.has(runtime)) return null;
  const config = this.managedRuntimes[runtime];
  const selected = this.userModels.get(userId)?.[runtime];
  return selected && config.models.includes(selected) ? selected : config.defaultModel;
}

async setUserModel(userId, runtime, model) {
  await this.init();
  assertUserId(userId);
  if (!MANAGED_RUNTIMES.has(runtime)) throw issue("invalid_runtime", "OpenCode manages its own models");
  const selected = normalizeModelId(model);
  const config = this.managedRuntimes[runtime];
  if (!config.models.includes(selected)) {
    throw issue("model_not_enabled", `model ${selected} is not enabled for ${runtime}`);
  }
  this.userModels.set(userId, { ...(this.userModels.get(userId) ?? {}), [runtime]: selected });
  await this.persistRuntime();
  return this.describe(userId);
}

async setManagedRuntime(runtime, models, defaultModel) {
  await this.init();
  if (!MANAGED_RUNTIMES.has(runtime)) throw issue("invalid_runtime", "only Claude Code and Codex are managed here");
  const normalized = normalizeModelList(models);
  const selectedDefault = normalized.length === 0 ? null : normalizeModelId(defaultModel);
  if (selectedDefault && !normalized.includes(selectedDefault)) {
    throw issue("invalid_default_model", "defaultModel must be included in models");
  }
  const previousRuntime = structuredClone(this.managedRuntimes[runtime]);
  const previousUserModels = new Map(
    [...this.userModels].map(([userId, choices]) => [userId, { ...choices }]),
  );
  this.managedRuntimes[runtime] = { models: normalized, defaultModel: selectedDefault };
  for (const [userId, choices] of this.userModels) {
    if (choices[runtime] && !normalized.includes(choices[runtime])) {
      const next = { ...choices };
      if (selectedDefault) next[runtime] = selectedDefault;
      else delete next[runtime];
      this.userModels.set(userId, next);
    }
  }
  try {
    await this.persistRuntime();
  } catch (error) {
    this.managedRuntimes[runtime] = previousRuntime;
    this.userModels = previousUserModels;
    throw error;
  }
  return this.adminDescribe();
}
```

Change `setUserRuntime(userId, runtime, model)` to reject a managed CLI with no enabled models, validate an optional model even when the runtime is unchanged, and otherwise restore the remembered/default model.

- [ ] **Step 5: Add model metadata to descriptions**

Each runtime option must include `enabled`, `models`, `defaultModel`, and `selectedModel`. `describe(userId)` includes the selected runtime's `model`. `adminDescribe()` includes `managedRuntimes` and command paths only.

- [ ] **Step 6: Run GREEN test**

Run: `node --test services/platform/test/cli-runtime.test.mjs`

Expected: all tests pass.

- [ ] **Step 7: Commit Task 1**

```bash
git add services/platform/src/cli-runtime.mjs services/platform/test/cli-runtime.test.mjs
git commit -m "feat(platform): persist managed CLI model choices"
```

### Task 2: Pass the Selected Model to Claude Code and Codex

**Files:**
- Modify: `services/platform/fixtures/fake-cli.mjs`
- Modify: `services/platform/test/cli-runtime.test.mjs`
- Modify: `services/platform/src/cli-runtime.mjs`

- [ ] **Step 1: Make fake CLIs require `--model`**

Add:

```js
function requiredModel(args) {
  const index = args.indexOf("--model");
  const model = index >= 0 ? args[index + 1] : null;
  if (!model) {
    process.stderr.write("fake cli: missing --model\n");
    process.exit(2);
  }
  return { index, model };
}
```

Include the selected model in fake response text. For Codex, fail when the model option appears after `resume`.

- [ ] **Step 2: Add failing two-turn model assertions**

Select `gpt-deep`, run two Codex turns, and assert response text contains `Codex[gpt-deep]` on both turns. Add the equivalent one-turn Claude assertion.

- [ ] **Step 3: Run RED test**

Run: `node --test --test-name-pattern="runs Claude|runs Codex" services/platform/test/cli-runtime.test.mjs`

Expected: FAIL with `missing --model`.

- [ ] **Step 4: Add model arguments before resume**

Claude arguments include:

```js
"-p", text, "--model", model, "--output-format", "stream-json"
```

Codex arguments use this order:

```js
const args = [
  ...this.codexArgs,
  "exec",
  "--json",
  "--skip-git-repo-check",
  "-C",
  session.directory,
  "-s",
  "workspace-write",
  "--model",
  model,
  ...(session.nativeSessionId ? ["resume", session.nativeSessionId] : []),
  text,
];
```

Resolve `model` with `modelForUser(session.userId, session.runtime)` on every turn and return `runtime_unconfigured` when none exists.

- [ ] **Step 5: Run GREEN and mutation tests**

Run the full CLI test. In a temporary copied directory, move `--model` after `resume` and confirm the Codex test fails. Do not mutate the working tree.

- [ ] **Step 6: Commit Task 2**

```bash
git add services/platform/fixtures/fake-cli.mjs services/platform/test/cli-runtime.test.mjs services/platform/src/cli-runtime.mjs
git commit -m "feat(platform): pass user-selected models to CLIs"
```

### Task 3: Add User and Administrator Model APIs

**Files:**
- Modify: `services/platform/test/platform-server.test.mjs`
- Modify: `services/platform/src/platform-server.mjs`
- Modify: `services/platform/src/cli-runtime.mjs`

- [ ] **Step 1: Write failing API tests**

Assert admin POST to `/api/admin/runtime` saves `{runtime, models, defaultModel}`, ordinary users receive 403, `/api/runtime` accepts `{runtime, model}`, GET `/global/config` returns the selected model, PATCH `/global/config` changes only the model, and `/config/providers` returns only enabled models.

Use this admin request body:

```js
{
  runtime: "codex",
  models: ["gpt-fast", "gpt-deep"],
  defaultModel: "gpt-fast"
}
```

Use the administrator and ordinary-user accounts to select different enabled models and assert each account's `/global/config` returns its own choice. Submit an administrator update whose default is absent from its model list, assert HTTP 400, then GET `/api/admin/runtime` and prove the previous catalog is unchanged.

- [ ] **Step 2: Run RED test**

Run: `node --test --test-name-pattern="keeps OpenCode per user" services/platform/test/platform-server.test.mjs`

Expected: FAIL because admin POST is 405 and managed model endpoints are empty/read-only.

- [ ] **Step 3: Implement administrator POST**

Keep `#requireAdmin` before the handler and call:

```js
await this.cliRuntime.setManagedRuntime(payload.runtime, payload.models, payload.defaultModel)
```

Return 400 for validation errors and advertise `Allow: GET, POST`.

- [ ] **Step 4: Accept optional model on `/api/runtime`**

Call:

```js
await this.cliRuntime.setUserRuntime(user.id, payload.runtime, payload.model)
```

- [ ] **Step 5: Implement the OpenCode-shaped managed model surface**

The SDK expects a `provider/model` key, while the platform stores a raw model identifier under an already-selected runtime. Add:

```js
function managedModelKey(runtime, model) {
  return model ? `${runtime}/${model}` : null;
}

function modelFromManagedKey(runtime, value) {
  const key = normalizeModelId(value);
  const prefix = `${runtime}/`;
  if (!key.startsWith(prefix) || key.length === prefix.length) {
    throw issue("invalid_model", `model must start with ${prefix}`);
  }
  return key.slice(prefix.length);
}
```

`GET /global/config` returns `{model: managedModelKey(runtime, this.modelForUser(userId, runtime))}`. `PATCH /global/config` accepts only a single string `model` field, removes the selected runtime prefix with `modelFromManagedKey`, and calls `setUserModel`. `GET /config/providers` returns:

```js
{
  providers: [{
    id: runtime,
    name: runtimeDescriptor(runtime).label,
    models: Object.fromEntries(models.map((model) => [
      model,
      { name: model, variants: {}, limit: { context: 0 } },
    ])),
  }],
}
```

Provider credentials and unrelated config writes remain forbidden.

- [ ] **Step 6: Run GREEN test**

Run: `pnpm platform:test`

Expected: all platform tests pass.

- [ ] **Step 7: Commit Task 3**

```bash
git add services/platform/src/platform-server.mjs services/platform/src/cli-runtime.mjs services/platform/test/platform-server.test.mjs
git commit -m "feat(platform): add managed model APIs"
```

### Task 4: Load Gateway Role and Managed Runtime Metadata

**Files:**
- Modify: `apps/desktop/src/lib/runtime.ts`
- Modify: `apps/desktop/src/lib/runtime.store.test.ts`

- [ ] **Step 1: Write failing store tests**

Mock `/api/me` and `/api/runtime`, connect the store, and assert:

```ts
expect(useRuntimeStore.getState().gatewayUserRole).toBe("admin");
expect(useRuntimeStore.getState().gatewayRuntimes).toEqual([
  expect.objectContaining({ runtime: "opencode", enabled: true }),
  expect.objectContaining({
    runtime: "codex",
    enabled: true,
    models: ["gpt-fast", "gpt-deep"],
    selectedModel: "gpt-deep",
  }),
]);
```

Add a test proving a disabled runtime is rejected without POSTing.

- [ ] **Step 2: Run RED test**

Run: `pnpm --filter @ai4s/desktop exec vitest run src/lib/runtime.store.test.ts`

Expected: FAIL because gateway role/model metadata are absent.

- [ ] **Step 3: Extend gateway types**

Use:

```ts
export interface GatewayRuntimeOption {
  runtime: GatewayRuntimeId;
  kind: "opencode" | "server";
  managed: boolean;
  label: string;
  enabled: boolean;
  models: string[];
  defaultModel: string | null;
  selectedModel: string | null;
}

type GatewayUserRole = "admin" | "user";
```

Add `gatewayUserRole: GatewayUserRole | null` to the store and initialize it to `null`.

- [ ] **Step 4: Fetch role and runtime metadata together**

During gateway connect:

```ts
const [meResponse, runtimeResponse] = await Promise.all([
  fetch(`${baseUrl}/api/me`, { credentials: "same-origin" }),
  fetch(`${baseUrl}/api/runtime`, { credentials: "same-origin" }),
]);
```

Parse `me.user.role`, normalize each runtime option, and retain the older-gateway fallback.

- [ ] **Step 5: Reject disabled runtime choices**

Resolve the selected option before POSTing. If `enabled` is false, set a clear error and return. Send the remembered model when present:

```ts
body: JSON.stringify({
  runtime,
  ...(option.selectedModel ? { model: option.selectedModel } : {}),
}),
```

- [ ] **Step 6: Run GREEN tests**

Run:

```bash
pnpm --filter @ai4s/desktop exec vitest run src/lib/runtime.store.test.ts
pnpm typecheck
```

Expected: tests and TypeScript pass.

- [ ] **Step 7: Commit Task 4**

```bash
git add apps/desktop/src/lib/runtime.ts apps/desktop/src/lib/runtime.store.test.ts
git commit -m "feat(web): load managed runtime model metadata"
```

### Task 5: Add the Administrator-Only Catalog Editor

**Files:**
- Create: `apps/desktop/src/components/settings/ManagedRuntimeModelsCard.tsx`
- Create: `apps/desktop/src/components/settings/ManagedRuntimeModelsCard.test.tsx`
- Modify: `apps/desktop/src/app/routes/SettingsPage.tsx`
- Modify: `apps/desktop/src/app/routes/SettingsPage.web.test.tsx`
- Modify: `apps/desktop/src/i18n/locales/de/settings.json`
- Modify: `apps/desktop/src/i18n/locales/en/settings.json`
- Modify: `apps/desktop/src/i18n/locales/es/settings.json`
- Modify: `apps/desktop/src/i18n/locales/fr/settings.json`
- Modify: `apps/desktop/src/i18n/locales/ja/settings.json`
- Modify: `apps/desktop/src/i18n/locales/ko/settings.json`
- Modify: `apps/desktop/src/i18n/locales/zh-Hans/settings.json`

- [ ] **Step 1: Write failing admin editor tests**

Test that the card loads both catalogs, edits newline-separated IDs, selects a default, and POSTs one runtime at a time:

```tsx
it("saves the administrator-managed Codex catalog", async () => {
  render(<ManagedRuntimeModelsCard />);
  const models = await screen.findByLabelText("Codex enabled models");
  await user.clear(models);
  await user.type(models, "gpt-fast\ngpt-deep");
  await user.selectOptions(screen.getByLabelText("Codex default model"), "gpt-deep");
  await user.click(screen.getByRole("button", { name: "Save Codex models" }));
  expect(fetch).toHaveBeenCalledWith(
    expect.stringContaining("/api/admin/runtime"),
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        runtime: "codex",
        models: ["gpt-fast", "gpt-deep"],
        defaultModel: "gpt-deep",
      }),
    }),
  );
});
```

In `SettingsPage.web.test.tsx`, assert ordinary users do not see the admin heading and administrators do.

- [ ] **Step 2: Run RED tests**

Run:

```bash
pnpm --filter @ai4s/desktop exec vitest run \
  src/components/settings/ManagedRuntimeModelsCard.test.tsx \
  src/app/routes/SettingsPage.web.test.tsx
```

Expected: FAIL because the card and role gate do not exist.

- [ ] **Step 3: Implement the focused admin card**

The card must GET `/api/admin/runtime`, keep separate Claude/Codex drafts, normalize lines with `split(/\r?\n/)`, trim/deduplicate IDs, choose the first model when the draft removes its default, POST only `{runtime, models, defaultModel}`, retain failed drafts, and expose an independent saving state per runtime. It must contain no credential fields.

- [ ] **Step 4: Compose user and admin controls**

Keep the CLI selector visible to all authenticated Web users. Disable an unavailable option:

```tsx
<option key={option.runtime} value={option.runtime} disabled={!option.enabled}>
  {option.label}
</option>
```

Show the model section for OpenCode and managed server runtimes:

```tsx
section === "models" && runtimeKind !== "acp"
```

Keep provider management limited to OpenCode. Render the new admin card only when:

```tsx
section === "models" && isGatewayWeb && gatewayUserRole === "admin"
```

- [ ] **Step 5: Add translation keys to all seven locales**

Add the same key structure everywhere. English values:

```json
{
  "managedModels": {
    "title": "Managed CLI models",
    "hint": "Only administrators can change which Claude Code and Codex models users may select.",
    "enabled": "{{runtime}} enabled models",
    "enabledHint": "One model identifier per line.",
    "default": "{{runtime}} default model",
    "save": "Save {{runtime}} models",
    "empty": "No models configured; users cannot select this CLI.",
    "saved": "{{runtime}} models saved.",
    "failed": "Could not save {{runtime}} models: {{detail}}"
  }
}
```

- [ ] **Step 6: Run GREEN, i18n, and type tests**

Run:

```bash
pnpm --filter @ai4s/desktop exec vitest run \
  src/components/settings/ManagedRuntimeModelsCard.test.tsx \
  src/app/routes/SettingsPage.web.test.tsx \
  src/app/routes/SettingsPage.i18n.test.tsx \
  src/i18n/parity.test.ts
pnpm typecheck
```

Expected: all selected tests and TypeScript pass.

- [ ] **Step 7: Commit Task 5**

```bash
git add apps/desktop/src/components/settings/ManagedRuntimeModelsCard.tsx \
  apps/desktop/src/components/settings/ManagedRuntimeModelsCard.test.tsx \
  apps/desktop/src/app/routes/SettingsPage.tsx \
  apps/desktop/src/app/routes/SettingsPage.web.test.tsx \
  apps/desktop/src/i18n/locales/*/settings.json
git commit -m "feat(web): add admin managed model editor"
```

### Task 6: Reuse the Existing Model Picker for Managed CLIs

**Files:**
- Modify: `apps/desktop/src/components/session/SessionView.tsx`
- Modify: `apps/desktop/src/components/session/SessionView.launch.test.tsx`
- Modify: `apps/desktop/src/components/thread/ModelPicker.test.tsx`
- Modify: `apps/desktop/src/app/routes/SettingsPage.web.test.tsx`

- [ ] **Step 1: Write a failing managed CLI picker test**

Populate the store with `runtimeKind: "server"`, provider `codex` containing `gpt-fast` and `gpt-deep`, and default `codex/gpt-fast`. Choose `gpt-deep` and assert `setDefaultModel("codex/gpt-deep")` is called.

Add this launch-page behavior:

```tsx
it("shows the ordinary model picker for an administrator-managed CLI", async () => {
  useRuntimeStore.setState({
    status: "ready",
    runtimeKind: "server",
    webReadOnly: false,
    providers: [{
      id: "codex",
      name: "Codex",
      models: [{ id: "gpt-fast", name: "gpt-fast" }],
    }],
    defaultModel: "codex/gpt-fast",
  });
  renderAt("/live");
  expect(await screen.findByRole("button", { name: /model/i })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run RED behavior test**

Run: `pnpm --filter @ai4s/desktop exec vitest run src/components/thread/ModelPicker.test.tsx src/components/session/SessionView.launch.test.tsx src/app/routes/SettingsPage.web.test.tsx`

Expected: the new SessionView/server-mode assertion fails because server mode currently hides the picker.

- [ ] **Step 3: Separate ACP-only and managed-server behavior**

Use:

```ts
const runtimeKind = useRuntimeStore((s) => s.runtimeKind);
const acp = runtimeKind === "acp";
const managedServer = runtimeKind === "server";
```

Pass:

```tsx
approvalMode={acp || managedServer ? undefined : approvalMode}
onApprovalModeChange={acp || managedServer ? undefined : (mode) => void setApprovalMode(mode)}
showModelPicker={connected && !webReadOnly && !acp}
configOptions={acp && !webReadOnly ? (acpConfigOptions[key] ?? []) : undefined}
```

- [ ] **Step 4: Run GREEN tests**

Run:

```bash
pnpm --filter @ai4s/desktop exec vitest run \
  src/components/thread/ModelPicker.test.tsx \
  src/components/session/SessionView.launch.test.tsx \
  src/app/routes/SettingsPage.web.test.tsx
pnpm typecheck
```

Expected: all selected tests and TypeScript pass.

- [ ] **Step 5: Commit Task 6**

```bash
git add apps/desktop/src/components/session/SessionView.tsx \
  apps/desktop/src/components/session/SessionView.launch.test.tsx \
  apps/desktop/src/components/thread/ModelPicker.test.tsx \
  apps/desktop/src/app/routes/SettingsPage.web.test.tsx
git commit -m "feat(web): show model picker for managed CLIs"
```

### Task 7: Verify, Deploy, and Record the Result

**Files:**
- Modify: `docs/rfc/internal-multi-user-platform.md`
- Modify: `PROGRESS.md`

- [ ] **Step 1: Run platform tests**

Run: `pnpm platform:test`

Expected: zero failures.

- [ ] **Step 2: Run frontend tests and static checks**

```bash
pnpm --filter @ai4s/desktop exec vitest run \
  src/components/settings/ManagedRuntimeModelsCard.test.tsx \
  src/app/routes/SettingsPage.web.test.tsx \
  src/components/thread/ModelPicker.test.tsx \
  src/app/routes/SettingsPage.i18n.test.tsx \
  src/i18n/parity.test.ts
pnpm typecheck
pnpm --filter @ai4s/desktop exec eslint \
  src/lib/runtime.ts \
  src/components/settings/ManagedRuntimeModelsCard.tsx \
  src/components/settings/ManagedRuntimeModelsCard.test.tsx \
  src/app/routes/SettingsPage.tsx \
  src/app/routes/SettingsPage.web.test.tsx \
  src/components/session/SessionView.tsx \
  src/components/thread/ModelPicker.test.tsx
git diff --check
```

Expected: zero failures. Report pre-existing warnings separately.

- [ ] **Step 3: Build the production Web bundle**

Run: `pnpm --filter @ai4s/desktop exec node --max-old-space-size=3000 node_modules/vite/bin/vite.js build`

Expected: exit 0 and a new hashed `apps/desktop/dist/assets/index-*.js`.

- [ ] **Step 4: Restart and verify migration**

```bash
sudo systemctl restart osd-platform.service
sudo systemctl is-active osd-platform.service
```

Expected: `active`. Read `runtime.json` without printing credentials and confirm version 3, OpenCode default, server-seeded Claude/Codex defaults, and the administrator still on OpenCode.

- [ ] **Step 5: Verify public permissions and UI assets**

Through `http://81.70.154.249`, verify anonymous login redirect, admin login, model metadata on `/api/runtime`, admin GET/POST access, ordinary-user 403 on admin POST, ordinary-user CLI/model selection, and the current JS asset.

- [ ] **Step 6: Verify real Codex and OpenCode turns**

Select configured Codex, complete two turns in one resumed session with condition polling, assert no CLI error, and restore OpenCode in `finally`. Then complete and delete one public OpenCode verification session and confirm `/api/runtime` remains OpenCode.

- [ ] **Step 7: Update verified records**

Update the RFC with the user/admin permission model. Add one newest-first `PROGRESS.md` line using the local timestamp and only verified results.

- [ ] **Step 8: Run final evidence commands**

```bash
pnpm platform:test
pnpm typecheck
git diff --check
sudo systemctl is-active osd-platform.service
curl -fsS http://81.70.154.249/health
```

Expected: all exit 0, service is `active`, and health is successful.

- [ ] **Step 9: Commit documentation**

```bash
git add docs/rfc/internal-multi-user-platform.md PROGRESS.md
git commit -m "docs: record managed CLI model selection"
```
