# Web Default Model Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task in one isolated worktree. Steps use checkbox syntax for tracking. Delegation is optional only when separately authorized; run heavy checks serially.

**Goal:** Make Settings reliably save the current user's default model, keep its picker usable after reconnection, and make new conversations inherit it without changing existing conversation choices.

**Architecture:** Preserve the SDK config endpoint and the existing per-user runtime persistence. Publish catalog availability independently of a default switch, while keeping default ownership and existing context/version protections. Add localized default semantics and consume selection failures at the Settings control.

**Tech Stack:** React, TypeScript, Zustand, i18next, Vitest, Node test runner, Playwright; existing bounded package scripts and Web release workflow.

---

## Approved scope and execution baseline

Spec: `docs/superpowers/specs/2026-10-11-web-default-model-settings-design.md`.

At planning time the running platform source is `/opt/open-science-desktop/.deploy/web-releases/2026-10-10T19-23-38-323Z-ba133012/source`. This supersedes the release inspected in the spec. Its `runtime.ts`, `WebModelPicker.tsx`, and `GatewayModelsPanel.tsx` are byte-identical to the diagnosed release, so the diagnosed defect still exists in its source. Re-inspect production at execution time; these paths are recorded evidence, not an instruction to overwrite a newer release.

The main checkout has extensive unrelated edits. Do not build or publish it for this fix. Do not change model APIs, storage schemas, source CLI profiles, provider adapters, stream timeouts, or desktop UX. Do not probe Claude live. Do not treat the generated diagnostic extraction test as sufficient product acceptance.

## File map

| File | Responsibility |
| --- | --- |
| `apps/desktop/src/lib/runtime.ts` | Default-save lifecycle, stale-response protection, catalog publication |
| `apps/desktop/src/lib/runtime.store.test.ts` | Real-store race, save failure, model inheritance and context regressions |
| `apps/desktop/src/components/thread/WebModelPicker.tsx` | Default-specific accessible label and consumed save rejection |
| `apps/desktop/src/components/thread/WebModelPicker.test.tsx` | Settings versus conversation selection and error interaction |
| `apps/desktop/src/components/settings/GatewayModelsPanel.tsx` | Default description and persistent failure presentation |
| `apps/desktop/src/components/settings/GatewayModelsPanel.test.tsx` | New focused panel tests |
| `apps/desktop/src/i18n/locales/{en,zh-Hans,de,es,fr,ja,ko}/settings.json` | Four localized default-model strings |
| `services/platform/test/platform-server.test.mjs` | Existing authenticated managed-default persistence/isolation fixture |
| `apps/desktop/src/test/webSessionContinuity.acceptance.test.mjs` | Extend existing candidate browser gate with Settings/default scenarios |
| `PROGRESS.md` | One new line per verified milestone, newest first |

No new production module is needed. Keep changes to the large runtime file localized. No new release-tool integration is needed: the existing session browser group already runs `webSessionContinuity.acceptance.test.mjs` when `runtime.ts` changes.

## Task 1: Establish an isolated production-compatible baseline

- [x] **1. Read superpowers:using-git-worktrees and inspect the active deployment.** Use the current package release workflow for read-only inspection:

```bash
pnpm web:release inspect --source /opt/open-science-desktop
systemctl show osd-platform.service -p WorkingDirectory --value
```

Record the active release ID, manifest fingerprint, source directory and rollback release. Do not print credentials or environment files. Expected: inspection identifies the active source and distinguishes main-checkout changes from deployed source.

- [x] **2. Create `/opt/open-science-desktop/.worktrees/web-default-model-settings` on branch `fix/web-default-model-settings` using the worktree skill.** Overlay only the active release's source inventory into this newly created worktree, remove source-allowed baseline files absent from that inventory only inside the new worktree, and validate pinned installed dependencies before staging their views. Use the following Node program from the main checkout; arguments are the active manifest path and the new worktree path:

```js
import { readFile, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { inventorySource, dependencyIdentity, freezeSource, fingerprintFiles }
  from '/opt/open-science-desktop/scripts/dev/web-release-source.mjs';
const manifest = JSON.parse(await readFile(process.argv[2], 'utf8'));
const destination = resolve(process.argv[3]);
if (destination !== '/opt/open-science-desktop/.worktrees/web-default-model-settings') {
  throw new Error('Unexpected worktree destination');
}
const source = manifest.source.root;
const files = await inventorySource(source, { git: false });
if (fingerprintFiles(files) !== manifest.source.fingerprint) {
  throw new Error('Deployed source differs from its manifest');
}
const keep = new Set(files.map(file => file.path));
for (const file of await inventorySource(destination, { git: false })) {
  if (!keep.has(file.path)) await unlink(join(destination, file.path));
}
const dependencies = await dependencyIdentity(source, {
  references: manifest.source.dependencies.references,
});
if (dependencies.fingerprint !== manifest.source.dependencies.fingerprint) {
  throw new Error('Pinned dependencies changed');
}
await freezeSource(source, destination, files, { dependencies });
if (fingerprintFiles(await inventorySource(destination, { git: false })) !== manifest.source.fingerprint) {
  throw new Error('Worktree baseline differs from production');
}
```

Save this operational program as `/opt/open-science-desktop/.deploy/verification/model-default-2026-10-11/prepare-worktree.mjs`, then invoke it with:

```bash
active_source=$(systemctl show osd-platform.service -p WorkingDirectory --value)
active_manifest_path="${active_source%/source}/manifest.json"
node /opt/open-science-desktop/.deploy/verification/model-default-2026-10-11/prepare-worktree.mjs "$active_manifest_path" /opt/open-science-desktop/.worktrees/web-default-model-settings
```
 Do not reinstall dependencies or remove the resource guard. Expected: exact source/dependency identity match. If production changes during preparation, rebuild the isolated baseline from the newly inspected release.

- [x] **3. Commit the isolated baseline locally, then copy only this spec and plan into its docs directory.** Check the staged file list before committing. Do not push or attach a remote. Run `pnpm web:release inspect --source /opt/open-science-desktop/.worktrees/web-default-model-settings`; before product edits, source changes against production must be empty. Record the baseline milestone in the one progress file.

## Task 2: Reproduce the race through the real store

**Files:** `apps/desktop/src/lib/runtime.store.test.ts`.

- [x] **1. Add deterministic gates to the existing mock.** Add and reset `defaultModelGate: Promise<void> | null`. Change its default read to capture the return value before awaiting the gate, so an old request can complete after a newer write:

```ts
async getDefaultModel() {
  const model = mocks.currentModel;
  if (mocks.defaultModelGate) await mocks.defaultModelGate;
  return model;
}
```

Use this helper within the new describe block:

```ts
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
function primeDefaultSettings() {
  mocks.isGatewayWeb = true;
  mocks.isTauri = false;
  mocks.providers = [{ id: 'fixture', name: 'Fixture', models: [
    { id: 'old', name: 'Old model' }, { id: 'new', name: 'New model' },
  ] }];
  mocks.currentModel = 'fixture/old';
  useRuntimeStore.setState({
    gatewayRuntime: 'opencode', gatewayCatalogState: 'ready',
    providers: mocks.providers, defaultModel: 'fixture/old',
    switching: false, modelSwitching: false,
    gatewayRuntimes: [{ runtime: 'opencode', kind: 'opencode', label: 'OpenCode',
      managed: false, enabled: true, models: [], defaultModel: null,
      selectedModel: null, status: 'ready', catalogRevision: null }],
  });
}
```

- [x] **2. Add this race regression using the actual `setDefaultModel` and `loadCatalog`.** Only control the recovery boundary; do not mock catalog publication or copy the production condition into the assertion:

```ts
it.each(['catalog-first', 'reconnect-first'])('settles the default catalog: %s', async order => {
  primeDefaultSettings();
  const original = useRuntimeStore.getState().connectRetry;
  const gate = deferred();
  let loading: Promise<void> | undefined;
  useRuntimeStore.setState({ connectRetry: vi.fn(async () => {
    if (order === 'reconnect-first') mocks.providerGate = gate.promise;
    loading = useRuntimeStore.getState().loadCatalog();
    if (order === 'catalog-first') await loading;
    return true;
  }) });
  try {
    await useRuntimeStore.getState().setDefaultModel('fixture/new');
    gate.release();
    await loading;
    expect(useRuntimeStore.getState()).toMatchObject({
      defaultModel: 'fixture/new', gatewayCatalogState: 'ready',
      switching: false, modelSwitching: false,
    });
    expect(mocks.currentModel).toBe('fixture/new');
  } finally {
    gate.release();
    await loading;
    mocks.providerGate = null;
    useRuntimeStore.setState({ connectRetry: original });
  }
});
```

- [x] **3. Add a stale-read case and a catalog-failure case.** These exercise the existing request/publication boundaries:

```ts
it('excludes a stale default response after a newer save', async () => {
  primeDefaultSettings();
  const original = useRuntimeStore.getState().connectRetry;
  const gate = deferred();
  mocks.defaultModelGate = gate.promise;
  const oldRead = useRuntimeStore.getState().loadCatalog();
  useRuntimeStore.setState({ connectRetry: vi.fn(async () => true) });
  try {
    await useRuntimeStore.getState().setDefaultModel('fixture/new');
    gate.release();
    await oldRead;
    expect(useRuntimeStore.getState().defaultModel).toBe('fixture/new');
    mocks.defaultModelGate = null;
    await useRuntimeStore.getState().loadCatalog();
    expect(useRuntimeStore.getState().gatewayCatalogState).toBe('ready');
  } finally {
    gate.release();
    await oldRead;
    mocks.defaultModelGate = null;
    useRuntimeStore.setState({ connectRetry: original });
  }
});
it('keeps a failed current catalog unavailable', async () => {
  primeDefaultSettings();
  mocks.providerGate = Promise.reject(new Error('Fixture catalog failure'));
  void mocks.providerGate.catch(() => {});
  try {
    await useRuntimeStore.getState().loadCatalog();
    expect(useRuntimeStore.getState().gatewayCatalogState).toBe('unavailable');
  } finally { mocks.providerGate = null; }
});
```


- [x] **4. Run the focused reproduction and confirm the intended failure.** From the isolated worktree:

```bash
pnpm test src/lib/runtime.store.test.ts -t 'settles the default catalog|stale default'
```

Expected before the fix: catalog-first fails because the catalog remains loading; the stale-read case identifies whether the old catalog can still replace the saved default. Import/fixture failures do not count as reproduction. Commit only the reproduction test changes: `test: reproduce default model catalog race`.

## Task 3: Fix publication and preserve default-save ownership

**Files:** `apps/desktop/src/lib/runtime.ts`, `apps/desktop/src/lib/runtime.store.test.ts`, seven `apps/desktop/src/i18n/locales/{en,zh-Hans,de,es,fr,ja,ko}/settings.json` files.

- [x] **1. Publish successful current catalog availability during switching.** Replace the successful models publication callback in `loadCatalog` with this localized change:

```ts
set((state) => {
  if (isGatewayWeb && assistant === 'opencode') {
    const configured = state.switching ? state.defaultModel : defaultModel;
    return { providers, ...reconcileGatewayModels(
      { ...state, providers, defaultModel: configured }, state.gatewayRuntimes,
    ) };
  }
  return state.switching ? { providers } : { defaultModel, providers };
});
```

Keep `current()`, client identity checks, retry bounds, availability enrichment and dangling-model rules. Do not settle catalog status from a switch's `finally` or a timer.

- [x] **2. Invalidate old Web model reads when a new default save begins.** Extend the existing Web invalidation in `setDefaultModel`:

```ts
if (isGatewayWeb) {
  ++gatewayCatalogVersion;
  ++modelCatalogVersion;
}
set({ modelSwitching: true, switching: true, modelSwitchError: null });
```

Preserve the existing successful write → `defaultModel` update → required reconnection ordering and diagnostic probes. This invalidates reads started before the accepted write without changing desktop publication behavior.

- [x] **3. Make errors phase-aware and protect superseded contexts.** First add `model.defaultRecoveryFailed` to all seven settings locales using the exact values in Task 4's table, so the new recovery assertion tests real localized copy. Capture the client and existing Web context generation at setter entry. Move the disconnected-client check inside its try block so failure is recorded for the Settings UI. Track write acceptance locally; no new persisted state is needed:

```ts
const source = client;
const context = webContextVersion;
const current = () => !isGatewayWeb || context === webContextVersion;
let saved = false;
// Inside the existing try, replacing the direct client write:
if (!source) throw new Error('The AI assistant is disconnected.');
await source.setDefaultModel(model);
if (!current()) return;
saved = true;
set({ defaultModel: model });
const connected = await get().connectRetry();
if (!current()) return;
if (!connected) {
  throw new Error(get().error ?? 'AI assistant reconnection failed.');
}
// Inside catch, before recording the error:
if (!current()) return;
const detail = err instanceof Error ? err.message : String(err);
set({ modelSwitchError: isGatewayWeb && saved
  ? i18n.t('settings:model.defaultRecoveryFailed', { detail })
  : detail });
throw err;
// Inside finally:
if (current()) set({ switching: false, modelSwitching: false });
```

Keep the successful error clear and existing desktop diagnostics. The old operation cannot publish errors or clear a new context's switch flags. Use the existing context cancellation path on disconnect/assistant/workspace change; do not create a second recovery owner. Context cancellation must relinquish the old save's model-specific busy/error state, and explicit disconnect must clear both busy flags. Add at the end of `cancelWebRecovery` and in the disconnect state publication, respectively:

```ts
if (useRuntimeStore.getState().modelSwitching) {
  useRuntimeStore.setState({ modelSwitching: false, modelSwitchError: null });
}
// Additional fields in disconnect's set object:
switching: false,
modelSwitching: false,
```

Assistant/workspace operations retain ownership of their existing `switching` lifecycle. Preserve a saved default after reconnection failure rather than reporting an imaginary rollback.

- [x] **4. Expand store regression cases.** Extend the existing model-switch failure describe block with these explicit outcomes:

| Trigger | Required assertions |
| --- | --- |
| Reject config write | Old default and server mock unchanged; busy flags clear; error recorded |
| Accept write then fail reconnect | New default and server mock retained; localized detail says saved but recovery failed |
| Begin another attempt after an error | Error clears at attempt start, then success clears it permanently |
| Old catalog resolves after the new write | New default remains selected |
| Old setter resolves/rejects after `disconnect()` | Active context, catalog and error remain the disconnected/new-context values |
| Catalog rejects after accepted write | Saved default remains; catalog unavailable; no false-ready publication |

Use deferred promises for context/order tests, and `vi.spyOn` on the existing mock prototype for one-shot read rejection. Restore spies/gates in `finally`. Run:

```bash
pnpm test src/lib/runtime.store.test.ts src/lib/zenModels.test.ts src/lib/webModelCatalog.test.ts
```

Expected: race and failure assertions pass, existing catalog/recovery tests remain green. Commit: `fix: settle model catalog during default changes`.

## Task 4: Explain defaults and show Settings failures

**Files:** `WebModelPicker.tsx`, `WebModelPicker.test.tsx`, `GatewayModelsPanel.tsx`, new `GatewayModelsPanel.test.tsx`, seven `settings.json` locale files.

- [x] **1. Add failing interaction assertions.** In picker tests, seed two available models and `defaultModel`, render `<WebModelPicker defaultMode />`, choose the second model, and assert the default setter receives its full key while the session map remains unchanged. Repeat for desktop menu and phone sheet roles. Reject the setter after recording `modelSwitchError`; assert the rejection is consumed and the panel displays its detail. Retain existing conversation-selector tests and effort behavior.

A complete Settings selection test using the existing fixture is:

```tsx
it('saves the default without changing explicit session choices', async () => {
  const user = userEvent.setup();
  const save = vi.fn(async () => {});
  const sessions = { ses_existing: 'codex/gpt-fast' };
  act(() => useRuntimeStore.setState({
    gatewayRuntime: 'codex', gatewayCatalogState: 'ready',
    defaultModel: 'codex/gpt-fast', sessionModels: sessions,
    setDefaultModel: save,
    gatewayRuntimes: [{ runtime: 'codex', kind: 'server', managed: true,
      label: 'Codex', enabled: true, models: ['gpt-fast', 'gpt-deep'],
      defaultModel: 'gpt-fast', selectedModel: 'gpt-fast' }],
  }));
  render(<WebModelPicker defaultMode />);
  await user.click(screen.getByRole('button', { name: 'Default model: gpt-fast' }));
  await user.click(screen.getByRole('menuitem', { name: 'gpt-deep' }));
  expect(save).toHaveBeenCalledWith('codex/gpt-deep');
  expect(useRuntimeStore.getState().sessionModels).toEqual(sessions);
});
```

Use the existing test's state reset pattern to restore overridden setters after the test. For the new panel test, mock only `ManagedAgentsCard` and seed store role `user`; use real picker/rendering.

- [x] **2. Add the remaining three keys under the existing `model` object in every settings locale.** Preserve all existing keys, including `defaultRecoveryFailed` added in Task 3. The new values are:

| Locale | `defaultTitle` | `defaultDescription` | `defaultSaveProblem` | `defaultRecoveryFailed` |
| --- | --- | --- | --- | --- |
| en | Default model | New conversations use this model for your account and current assistant. Existing conversation choices stay the same. | Could not finish changing the default model | The default model was saved, but the assistant could not reconnect: {{detail}} |
| zh-Hans | 默认模型 | 当前账号在此助手中新建的对话将使用这个模型。已有对话的模型选择保持不变。 | 默认模型切换未完成 | 默认模型已保存，但助手重新连接失败：{{detail}} |
| de | Standardmodell | Neue Unterhaltungen verwenden dieses Modell für dein Konto und den aktuellen Assistenten. Die Modellauswahl bestehender Unterhaltungen bleibt erhalten. | Das Standardmodell konnte nicht vollständig geändert werden | Das Standardmodell wurde gespeichert, aber der Assistent konnte sich nicht erneut verbinden: {{detail}} |
| es | Modelo predeterminado | Las conversaciones nuevas usan este modelo para tu cuenta y el asistente actual. Las conversaciones existentes conservan su modelo. | No se pudo completar el cambio de modelo predeterminado | El modelo predeterminado se guardó, pero el asistente no pudo reconectarse: {{detail}} |
| fr | Modèle par défaut | Les nouvelles conversations utilisent ce modèle pour votre compte et l’assistant actuel. Les conversations existantes conservent leur modèle. | Le changement de modèle par défaut n’a pas pu être terminé | Le modèle par défaut a été enregistré, mais l’assistant n’a pas pu se reconnecter : {{detail}} |
| ja | デフォルトモデル | このアカウントで現在のアシスタントとの新しい会話に使用するモデルです。既存の会話のモデル選択は変わりません。 | デフォルトモデルの変更を完了できませんでした | デフォルトモデルは保存されましたが、アシスタントに再接続できませんでした：{{detail}} |
| ko | 기본 모델 | 현재 계정과 어시스턴트의 새 대화에서 이 모델을 사용합니다. 기존 대화의 모델 선택은 유지됩니다. | 기본 모델 변경을 완료하지 못했습니다 | 기본 모델은 저장되었지만 어시스턴트에 다시 연결하지 못했습니다: {{detail}} |

- [x] **3. Handle default-selection rejection in `WebModelPicker`.** Add the settings namespace and use the following handler and label; leave reasoning/conversation behavior intact:

```tsx
const { t } = useTranslation(['session', 'settings']);
const selectModel = async (key: string) => {
  if (!defaultMode) {
    if (sessionId) await setSession(sessionId, key);
    return;
  }
  try { await setDefault(key); }
  catch { /* The store records the current save failure for Settings. */ }
};
// On the model WebChoiceMenu:
label={defaultMode ? t('model.defaultTitle', { ns: 'settings' }) : t('composer.runtime.modelLabel')}
onSelect={selectModel}
```

Do not add a generic catch to every `WebChoiceMenu` consumer, and do not emit a second toast for the same failure.

- [x] **4. Present the description and error in `GatewayModelsPanel`.** Subscribe to `modelSwitchError`, use `model.defaultTitle` instead of `model.title` for the default row, and place the description immediately below it. Reuse the deployed `StateNotice` component:

```tsx
const modelError = useRuntimeStore(s => s.modelSwitchError);
// Below the default row:
<p className="text-xs text-muted">{t('model.defaultDescription')}</p>
{modelError && <StateNotice issueId={`default-model:${runtime}:${modelError}`}
  summary={t('model.defaultSaveProblem')} detail={modelError} />}
```

Keep unavailable-catalog retry controls. Users can retry a save by selecting the desired model again once the runtime/catalog is usable. Catalog refresh alone must not be presented as retrying a rejected model write.

- [x] **5. Run targeted UI/localization checks and commit.**

```bash
pnpm test src/components/thread/WebModelPicker.test.tsx src/components/settings/GatewayModelsPanel.test.tsx src/app/routes/SettingsPage.web.test.tsx src/i18n/parity.test.ts src/i18n/config.test.ts
```

Expected: English/Chinese accessible labels, menu/sheet selection, visible failure, default/session separation and locale parity pass. Commit: `fix: explain default model settings and save failures`.

## Task 5: Verify inheritance, persistence and browser behavior

**Files:** `runtime.store.test.ts`, `services/platform/test/platform-server.test.mjs`, `webSessionContinuity.acceptance.test.mjs`.

- [x] **1. Add real-store send assertions.** Reuse `primeDefaultSettings`, mock successful recovery, change to `fixture/new`, then call the existing `sendPrompt('default inheritance fixture')` from an unbound draft. Assert `sendPromptFullSpy.mock.calls.at(-1)?.[3]` is `fixture/new`. For an explicit draft, set `sessionModels[DRAFT_KEY] = 'fixture/old'` before sending and expect the old model. For an existing session, seed its explicit model and make it the active layout leaf using the existing per-session test helpers; changing the default must leave that record intact. Assert `abortSession`, `sendPromptSpy` and `createSessionSpy` receive no calls merely from changing the default. Snapshot `runningSessions` before the change and assert its entries remain unchanged.

```ts
expect(mocks.sendPromptFullSpy.mock.calls.at(-1)?.[3]).toBe('fixture/new');
expect(useRuntimeStore.getState().sessionModels.ses_existing).toBe('fixture/old');
expect(mocks.abortSession).not.toHaveBeenCalled();
```

Keep send assertions separate from the no-send assertion so previous test activity cannot invalidate their meaning. If a failing test reveals that opening a draft silently pins a default, change only that pinning site to retain an absent model until explicit selection or actual first send; do not clear explicit draft keys or historical session models.

- [x] **2. Strengthen the existing deterministic platform fixture.** Capture the existing student login result as `const studentLogin = await login(student, 'student', 'student-password')` in the managed-CLI test so its user ID is available. In `platform-server.test.mjs`, after `patchAdminModel` changes the admin's Codex default, reread the student's `/global/config` and assert its value remains `codex/gpt-fast`; read the admin's `/api/runtime` and assert its Codex `selectedModel` is the saved ID. To make isolation distinguishable, switch the student to `gpt-deep` before the admin PATCH and assert the student stays deep afterward. Recreate the fixture `CliRuntimeManager` with its same temporary persisted runtime directory using the test's existing construction arguments, call `init()`, and assert `modelForUser(adminLogin.user.id, 'codex')` and `modelForUser(studentLogin.user.id, 'codex')` retain their distinct values. Close the recreated manager in `finally`. Use this complete reconstruction after the isolation assertion:

```js
const restored = new CliRuntimeManager({
  rootDir: join(root, 'cli-runtime'), runtime: 'opencode',
  claudeCommand: process.execPath, claudeArgs: [fakeCli, 'claude'],
  codexCommand: process.execPath, codexArgs: [fakeCli, 'codex'],
  claudeConfigDir: adminClaude, codexHome: adminCodex, turnTimeoutMs: 5_000,
});
try {
  await restored.init();
  assert.equal(restored.modelForUser(adminLogin.user.id, 'codex'), 'gpt-fast');
  assert.equal(restored.modelForUser(studentLogin.user.id, 'codex'), 'gpt-deep');
} finally { await restored.close(); }
```

Do not stop a production service or read production runtime persistence for this test.

Use the existing authenticated `request()` helper and JSON assertions:

```js
await student.request('/global/config', {
  method: 'PATCH',
  headers: { accept: 'application/json', 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'codex/gpt-deep' }),
});
// Run the existing admin PATCH to codex/gpt-fast after this setup.
const studentDefault = await student.request('/global/config', {
  headers: { accept: 'application/json' },
});
assert.deepEqual(await json(studentDefault), { model: 'codex/gpt-deep' });
```

Existing deterministic Claude fixtures remain allowed; no live Claude/provider request is part of this suite.

- [x] **3. Extend the existing candidate continuity browser test.** Make its fixture HTML route accept `/settings` as well as `/` and `/live`. After its existing continuity assertions, run new fresh contexts at widths 1280 and 390 against the same fake server. Intercept `/global/config` and `/config/providers` at the page layer with an in-memory default and two fixture models; all writes remain local fixtures. A complete route handler for saved config is:

```js
let configured = 'fixture/model';
let failWrite = false;
await page.route('**/global/config', async route => {
  if (route.request().method() === 'PATCH') {
    if (failWrite) {
      await route.fulfill({ status: 503, json: { error: 'Fixture save failure' } });
      return;
    }
    configured = route.request().postDataJSON().model;
  }
  await route.fulfill({ json: { model: configured } });
});
await page.route('**/config/providers', route => route.fulfill({ json: {
  providers: [{ id: 'fixture', name: 'Fixture', models: {
    model: { id: 'model', name: 'Fixture model' },
    next: { id: 'next', name: 'Next model' },
  } }], connected: ['fixture'], default: { fixture: 'model' },
} }));
await page.goto(`${origin}/settings/models`);
const picker = page.getByRole('button', { name: 'Default model: Fixture model', exact: true });
await expect.poll(() => picker.isEnabled()).toBe(true);
await picker.click();
await page.getByRole(width === 390 ? 'button' : 'menuitem', {
  name: 'Next model', exact: true,
}).click();
const savedPicker = page.getByRole('button', { name: 'Default model: Next model', exact: true });
await expect.poll(() => savedPicker.isEnabled()).toBe(true);
await page.reload();
await expect.poll(() => savedPicker.isEnabled()).toBe(true);
expect(configured).toBe('fixture/next');
expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
```

Create each context with locale `en` stored via `addInitScript`; instantiate `page` before routes. Collect `pageerror` messages and assert none. Run the rejection route once, verify the visible error and unchanged configured default, clear `failWrite`, select again, and assert recovery. Capture only public UI screenshots into release verification artifacts. Close contexts and fake server/SSE resources using the existing `finally` cleanup. Store tests prove both precise race orderings; the browser scenario verifies the complete user interaction and reload without a paid model call.

- [x] **4. Run deterministic checks.**

```bash
pnpm test src/lib/runtime.store.test.ts src/components/thread/WebModelPicker.test.tsx src/components/settings/GatewayModelsPanel.test.tsx
pnpm platform:test test/platform-server.test.mjs test/cli-runtime.test.mjs
```

Expected: inheritance, distinct-user persisted defaults, existing sessions and running turns pass. Browser execution belongs to the prepared-candidate stage in Task 6 so it tests the actual bounded build, not stale assets. Commit: `test: verify default model inheritance and persistence`.

## Task 6: Validate the candidate and prepare release evidence

- [x] **1. Run the standard release inspection from the isolated checkout.**

```bash
pnpm web:release inspect --source /opt/open-science-desktop/.worktrees/web-default-model-settings
```

Expected change list: only this plan's product/test/localization paths. Review any extra file before preparation. A `runtime.ts` change correctly selects broad frontend/platform checks, session browser acceptance and live OpenCode verification; do not narrow the release gates to hide failures. The patch does not require a new sandbox image.

- [x] **2. Prepare a candidate through the package release workflow.**

```bash
pnpm web:release prepare --source /opt/open-science-desktop/.worktrees/web-default-model-settings
```

Use the release workflow's validated browser settings. It runs bounded lint/typecheck/tests/build and candidate browser acceptance serially. If locks are occupied, report the lock and continue lightweight review; never launch a second unbounded build or bypass serialization. If the bounded build runs out of memory, optimize footprint and preserve the existing guard/reserve. A failed candidate must leave production assets untouched.

Expected: a prepared manifest with recorded check results, candidate artifact hashes, successful desktop/phone Settings scenario, and the existing conversation continuity scenario. Inspect browser results to ensure the added default scenario actually ran rather than being skipped.

- [x] **3. Prepare a concise reviewable release result.** Record the candidate ID, complete source diff, test totals, retained screenshots, and rollback release. Add one progress milestone for verified candidate readiness. This task ends with a prepared candidate; publishing requires the user's instruction to deploy or existing explicit deployment authorization.

When publication is authorized, use the exact prepared ID:

```bash
pnpm web:release deploy --release "$candidate_release_id"
```

Then verify live health and Settings rendering at desktop/phone widths. If performing a reversible live default write, read the original first, choose an available alternative, verify readback/reload, and restore the original in `finally`; do not send a paid model turn or probe Claude. If deployment/live acceptance fails, rollback to the recorded prior release using the existing workflow and preserve logs/state. Record deployment as complete only after those checks pass.

## Spec coverage and completion criteria

| Spec requirement | Tasks |
| --- | --- |
| R1: Explicit defaults, draft inheritance, preserve session/turn choices | 4, 5 |
| R2: Truthful availability, both race orders, stale-response exclusion | 2, 3 |
| R3: Existing SDK persistence and user isolation | 3, 5 |
| R4: Save versus recovery failure, visible errors, retry | 3, 4, 5 |
| Bounded checks, phone/desktop Web acceptance, deployment integrity | 1, 6 |

Implementation is complete when the real-store regression passes for both response orders, default persistence/inheritance and user isolation pass, errors remain visible/retryable without an unhandled rejection, and candidate browser/build gates pass. Candidate readiness and publication are separate recorded milestones. This planning turn has made no product change or deployment.


## Live acceptance correction (2026-10-11)

The first frontend release's live Settings save returned HTTP 404 in the production sandbox gateway. Managed CLI fixture success did not prove the managed sandbox path: `runtime-route-policy.mjs` denied `PATCH /global/config`. Extend the approved implementation with a platform-handled model-only route, validate model membership in the authenticated account's sanitized catalog, enforce current account generation and owned root directory, forward only the model, and sanitize the response. Reject extra config fields, directory query overrides, foreign origins and unlisted models; test two-user isolation, upstream failure and retry. Rerun the full bounded publication workflow with the backend change and verify desktop/phone live save, reload and original-default restoration before declaring completion.


Startup correction: the runner regenerates the managed profile, so runtime config alone cannot preserve an account default across worker restart. Atomically persist only the accepted model in private per-account platform storage and restore it while issuing the next managed profile, provided it remains enabled. Test reconstructed reads, two-user separation and retired/foreign fallback. Verify a real service restart after saving at desktop width, then verify phone save/reload and restore the original model in cleanup. This adds no credential storage or sandbox image change.


Completion evidence (2026-10-11): release `2026-10-11T06-04-04-295Z-c82d78f1` is published. Original frontend checks passed 1,961 tests; the final backend checks passed 424 tests with zero failures, and all 10 required candidate browser assertions passed. Live 1280/390-pixel save and reload passed, desktop service-restart persistence passed, and the original default was restored in both contexts. Live results and screenshots are retained under `.deploy/verification/model-default-2026-10-11/live/`. Product changes remain on the isolated `fix/web-default-model-settings` worktree; unrelated main-checkout changes remain preserved.
