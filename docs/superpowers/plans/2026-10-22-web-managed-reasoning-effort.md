# Web Managed Assistant Reasoning Effort Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the chat composer's reasoning-effort control usable for the managed Codex assistant, by loading the model catalog the platform already serves.

**Architecture:** The platform already answers `GET /config/providers` with the managed assistant's per-model effort levels; the composer (`WebModelPicker`) and the send path (`modelForSession` → `webModelEffort`) already read that catalog. The client is the only side that skips it for a managed assistant, in two places: `loadCatalog`'s models step and `refreshGatewayRuntimes`. Both are changed to read the selected assistant's catalog, with the read contained so a failure cannot take the chat down. No component, SDK, platform, image or CLI change is involved.

**Tech Stack:** React 19 + TypeScript + Vite (`apps/desktop`), Vitest + Testing Library, Playwright (browser acceptance, `.mjs` scenarios), pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-10-22-web-managed-reasoning-effort-design.md`

## Global Constraints

- Work in `/opt/open-science-desktop/.worktrees/web-login-performance-20261021` (branch `feat/web-login-performance-20261021`). It is the checkout that produced the live bundle; the main checkout is a different, older line and is not the publication source.
- Frontend-only. Change `apps/desktop/src/**` only. Do not touch `services/platform/**`, `runtime/**`, `crates/**`, `native/**`, `packages/sdk/**` or any image input — the installed image must be reused, never rebuilt.
- All project files and code are English. Discussion may be Chinese.
- Run every test, build, typecheck and lint through the package scripts, which enforce the host's cgroup limits: `pnpm --filter @ai4s/desktop test -- <file>`. Never invoke vitest, vite or tsc directly.
- Do not run `pnpm install`. The disk has ~1.5 GB free and the worktree's `node_modules` must keep pointing at the shared store in `.worktrees/web-workspace-capacity-20261020`.
- The worktree carries unrelated uncommitted work from another line. Commit only the files this plan touches. `apps/desktop/src/lib/runtime.ts` and `apps/desktop/src/lib/runtime.store.test.ts` are already modified by that other work, so a commit of those paths would sweep it in: check `git diff` for those files before committing and stage only this plan's hunks.
- One progress file: `PROGRESS.md`. Append one line per real milestone, `YYYY-MM-DD HH:MM` + a one-sentence conclusion, newest on top.
- Claude is unusable. Exclude it from live acceptance; Codex is the only live assistant.
- The effort rule is fixed: an unset effort resolves to the lowest level the selected model exposes, and an effort is always sent explicitly. Do not add a "model default" entry, and do not change the OpenCode path's behavior.
- Publishing a change to `apps/desktop/src/lib/runtime.ts` triggers the release policy's assistant path: full frontend and platform test suites, lint, typecheck, the browser scenarios `assistants` and `session`, the assistant launcher/target/recovery stages and a live assistant acceptance with real Codex turns. The image is reused (no image input changed). Do not relabel the change to avoid that path.

## Review Focus

The five input classes most likely to bite a person using this software, each pinned to the task that owns the code:

1. A failed or empty catalog read must not cost the user their chat — the model list, the default model and sending must survive, and only the effort control disappears. (Tasks 2, 3)
2. A level the newly selected model does not expose must never reach the platform — the platform answers 400 for an unusable variant, so the turn would fail. (Task 4)
3. Switching assistants must not leave the previous assistant's levels on screen, and must not offer the new assistant a level the new catalog does not have. (Task 3)
4. Two panes of one account may hold different efforts, and a draft's choice must travel with the draft into the session it becomes. (Task 4)
5. A user who never opens the control still gets a stated, working effort — the model's lowest level — and the composer says the same thing the turn sends. (Task 4)

---

## File Structure

- Modify: `apps/desktop/src/lib/runtime.ts` — the client's catalog loading. Two regions: `loadCatalog`'s models step (the connect path, published line 4417) and `refreshGatewayRuntimes` (the assistant-change path, published line 3935). Both must read the selected assistant's catalog; both must contain a failed read.
- Modify: `apps/desktop/src/lib/runtime.store.test.ts` — deterministic coverage of the two regions, the harness's provider-read failure switch, and the end-to-end client path (catalog → control → sent effort).
- Modify: `apps/desktop/src/test/webAssistantCompatibility.acceptance.test.mjs` — the browser scenario proves in a real browser that the managed assistant's effort control is reachable and that the turn carries the level.
- Modify: `PROGRESS.md` — one milestone line per completed milestone.
- Not modified: `apps/desktop/src/components/thread/WebModelPicker.tsx` (the control exists and is correct), `apps/desktop/src/lib/webModelCatalog.ts` (the effort rule exists and is correct), `packages/sdk/**`, `services/platform/**`.

---

### Task 1: Load the managed assistant's effort catalog on connect

**Files:**
- Modify: `apps/desktop/src/lib/runtime.ts:4417-4448` (`loadCatalog`, the models step)
- Test: `apps/desktop/src/lib/runtime.store.test.ts` (inside `describe("gateway runtime selection")` → `describe("Web reasoning effort")`)

**Interfaces:**
- Consumes: `listProvidersWithAvailability(client, onAvailability?, readOptions?)` → `Promise<ProviderInfo[]>` (existing, `apps/desktop/src/lib/zenModels.ts:136`); `reconcileGatewayModels(state, options)` (existing, `apps/desktop/src/lib/runtime.ts:793`).
- Produces: the store's `providers` for a managed assistant now holds that assistant's catalog. No new exported symbol. The next task reads the same catalog; Task 4 reads the store's `providers` through the existing `webModelEffort` path.

- [ ] **Step 1: Add the provider-read failure switch to the test harness**

In `apps/desktop/src/lib/runtime.store.test.ts`, next to the other failure switches in the `mocks` object (after `failSkills`, around line 92), add:

```ts
  /** The next listProviders() read throws (the catalog endpoint is unreachable). */
  failProviders: false,
```

and reset it in the outer `beforeEach` next to `mocks.failSkills = false;` (around line 458):

```ts
  mocks.failProviders = false;
```

- [ ] **Step 2: Make the mocked provider read honor the switch**

In the same file, the mocked client's `listProviders` (around line 270) becomes:

```ts
    async listProviders() {
      const gate = mocks.providerReadGate;
      mocks.providerReadGate = null;
      if (gate) await gate;
      if (mocks.providerGate) await mocks.providerGate;
      if (mocks.failProviders) throw new Error("Load failed");
      return mocks.providers;
    }
```

- [ ] **Step 3: Write the failing test**

Inside `describe("Web reasoning effort")` (around line 1299), after its `beforeEach`, add a nested block:

```ts
    describe("managed assistant catalog", () => {
      const managedProviders = [{ id: "codex", name: "Codex", models: [
        { id: "gpt-deep", name: "GPT Deep", variants: ["low", "high"] },
        { id: "big-pickle", name: "Big Pickle", variants: [] },
      ] }];
      beforeEach(() => {
        mocks.providers = managedProviders;
        useRuntimeStore.setState({ providers: [] });
      });
      /** The connect in the outer setup starts a catalog load without awaiting
       *  it. Drain that load first, or the call under test returns the
       *  in-flight one and never runs. */
      async function loadWithManagedAssistant() {
        await useRuntimeStore.getState().loadCatalog();
        useRuntimeStore.setState({ providers: [] });
        await useRuntimeStore.getState().loadCatalog();
      }

      it("loads the managed assistant's effort catalog on connect", async () => {
        await loadWithManagedAssistant();
        expect(useRuntimeStore.getState().providers).toEqual(managedProviders);
        expect(useRuntimeStore.getState().defaultModel).toBe("codex/gpt-deep");
        expect(useRuntimeStore.getState().gatewayCatalogState).toBe("ready");
      });
    });
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm --filter @ai4s/desktop test -- src/lib/runtime.store.test.ts -t "loads the managed assistant's effort catalog on connect"`

Expected: FAIL — `providers` is `[]`, because `loadCatalog` returns before reading a catalog for a managed assistant.

- [ ] **Step 5: Implement the change**

In `apps/desktop/src/lib/runtime.ts`, the models step of `loadCatalog`. Replace the opening line (published line 4418):

```ts
    const models = (async () => {
      if (isGatewayWeb && assistant && assistant !== "opencode") return;
```

with:

```ts
    const models = (async () => {
      // A managed assistant's model list comes from /api/runtime, but its effort
      // levels live in this catalog, which the composer and the send path read.
      // It is therefore loaded for every assistant.
      const managed = isGatewayWeb && !!assistant && assistant !== "opencode";
```

Replace the `Promise.all` and the catalog-empty guard:

```ts
          const [defaultModel, providers] = await Promise.all([
            isGatewayWeb && oc ? oc.getDefaultModel(readOptions()) : source.getDefaultModel().catch(() => null),
            oc ? listProvidersWithAvailability(oc, availability, readOptions()) : Promise.resolve([]),
          ]);
          if (!current()) return;
          if (isGatewayWeb && providers.length === 0) throw new Error("Model catalog is unavailable");
```

with:

```ts
          const [defaultModel, providers] = await Promise.all([
            // A managed assistant's default model belongs to /api/runtime; it is
            // neither read nor written from here.
            managed ? Promise.resolve(null)
              : isGatewayWeb && oc ? oc.getDefaultModel(readOptions()) : source.getDefaultModel().catch(() => null),
            oc ? listProvidersWithAvailability(oc, availability, readOptions()) : Promise.resolve([]),
          ]);
          if (!current()) return;
          if (isGatewayWeb && !managed && providers.length === 0) throw new Error("Model catalog is unavailable");
```

Replace the state write:

```ts
          set((state) => {
            if (isGatewayWeb && assistant === "opencode") {
```

with:

```ts
          set((state) => {
            if (managed) return { providers };
            if (isGatewayWeb && assistant === "opencode") {
```

and add the managed early return right after that `set(...)` block, before the stale-default heal:

```ts
          if (managed) return;
          // Only an identity removed from a successful catalog can heal a stale default.
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @ai4s/desktop test -- src/lib/runtime.store.test.ts -t "loads the managed assistant's effort catalog on connect"`

Expected: PASS.

- [ ] **Step 7: Run the whole store suite to see what the change broke**

Run: `pnpm --filter @ai4s/desktop test -- src/lib/runtime.store.test.ts`

Expected: all pass. A failure in `"blocks sends after a refresh fails and discards a stale response from a previous refresh"` or `"catches an offline fetch and recovers with a new authoritative catalog"` means the managed path now fails in a way it did not before — that is the failure mode Task 2 contains; note it and continue.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/lib/runtime.ts apps/desktop/src/lib/runtime.store.test.ts
git -c user.name=J0nhyer -c user.email=J0nhyer@users.noreply.github.com commit -m "feat(web): load the managed assistant's effort catalog

The composer and the send path already read the model catalog for a
managed assistant; the client never fetched it, so the effort control
stayed hidden and no effort could be sent. The managed assistant's default
model stays owned by /api/runtime."
```

Before committing, run `git diff --cached` and confirm the staged hunks in `runtime.ts` and `runtime.store.test.ts` are only this plan's: the worktree carries unrelated uncommitted work in the same files.

---

### Task 2: Contain a failed managed catalog read

**Files:**
- Modify: `apps/desktop/src/lib/runtime.ts` (the `Promise.all` in `loadCatalog`'s models step, published line 4424)
- Test: `apps/desktop/src/lib/runtime.store.test.ts` (the nested `describe("managed assistant catalog")` from Task 1)

**Interfaces:**
- Consumes: the same `listProvidersWithAvailability` as Task 1.
- Produces: a managed catalog read that fails yields an empty catalog and no state change beyond `providers`; `gatewayCatalogState` and `defaultModel` are untouched.

Task 1 gave the managed path a failure mode the old early return did not have: the read now happens, so it can fail, and the existing catch marks the whole catalog unavailable — which hides the model list and blocks sends.

- [ ] **Step 1: Write the failing test**

Inside `describe("managed assistant catalog")`, add:

```ts
      it("keeps the chat usable when the managed catalog read fails", async () => {
        mocks.failProviders = true;
        await loadWithManagedAssistant();
        expect(useRuntimeStore.getState().gatewayCatalogState).toBe("ready");
        expect(useRuntimeStore.getState().defaultModel).toBe("codex/gpt-deep");
        expect(useRuntimeStore.getState().providers).toEqual([]);
      });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @ai4s/desktop test -- src/lib/runtime.store.test.ts -t "keeps the chat usable when the managed catalog read fails"`

Expected: FAIL — `gatewayCatalogState` is `"unavailable"`, because the failed read reached the catch that marks the catalog unavailable.

- [ ] **Step 3: Implement the containment**

In `apps/desktop/src/lib/runtime.ts`, inside the `Promise.all` of the models step, replace:

```ts
            oc ? listProvidersWithAvailability(oc, availability, readOptions()) : Promise.resolve([]),
```

with:

```ts
            // A managed assistant's model list does not come from this catalog,
            // so a failed read must not mark the catalog unavailable and take
            // the chat down with it: the effort control simply disappears.
            oc
              ? managed
                ? listProvidersWithAvailability(oc, availability, readOptions()).catch(() => [] as ProviderInfo[])
                : listProvidersWithAvailability(oc, availability, readOptions())
              : Promise.resolve([] as ProviderInfo[]),
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @ai4s/desktop test -- src/lib/runtime.store.test.ts -t "keeps the chat usable when the managed catalog read fails"`

Expected: PASS.

- [ ] **Step 5: Run the whole store suite**

Run: `pnpm --filter @ai4s/desktop test -- src/lib/runtime.store.test.ts`

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/lib/runtime.ts apps/desktop/src/lib/runtime.store.test.ts
git -c user.name=J0nhyer -c user.email=J0nhyer@users.noreply.github.com commit -m "fix(web): a failed managed catalog read no longer takes the chat down

The managed assistant's model list comes from /api/runtime, so a failed
catalog read only removes the effort control; it must not mark the
catalog unavailable and block sending."
```

---

### Task 3: Replace the catalog when the administrator changes the assistant

**Files:**
- Modify: `apps/desktop/src/lib/runtime.ts:3935-3959` (`refreshGatewayRuntimes`)
- Test: `apps/desktop/src/lib/runtime.store.test.ts` (the nested `describe("managed assistant catalog")` from Task 1)

**Interfaces:**
- Consumes: `listProvidersWithAvailability(client, onAvailability?, readOptions?)`; the `/api/runtime` response (`GatewayRuntimeOption[]`).
- Produces: after an assistant change, the store's `providers` holds the newly selected assistant's catalog instead of the previous assistant's.

The refresh currently loads a catalog only for OpenCode. For a managed assistant it leaves the previous assistant's entries in the store, so a switch would show the old assistant's levels next to the new assistant's models.

- [ ] **Step 1: Write the failing test**

Inside `describe("managed assistant catalog")`, add:

```ts
      it("replaces the catalog with the selected assistant's own when the assistant changes", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ runtime: "codex",
          available: [codexCatalog(["gpt-deep"], "gpt-deep")] }), { status: 200 })));
        useRuntimeStore.setState({ gatewayRuntime: "codex", gatewayCatalogState: "ready",
          gatewayRuntimes: [codexCatalog(["gpt-deep"], "gpt-deep")], defaultModel: "codex/gpt-deep",
          providers: [{ id: "openai", name: "OpenAI", models: [{ id: "stale", name: "Stale" }] }] });
        await useRuntimeStore.getState().refreshGatewayRuntimes();
        expect(useRuntimeStore.getState().providers).toEqual(managedProviders);
        expect(useRuntimeStore.getState().defaultModel).toBe("codex/gpt-deep");
      });

      it("does not block the chat when the managed catalog read fails during a refresh", async () => {
        mocks.failProviders = true;
        vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ runtime: "codex",
          available: [codexCatalog(["gpt-deep"], "gpt-deep")] }), { status: 200 })));
        useRuntimeStore.setState({ gatewayRuntime: "codex", gatewayCatalogState: "ready",
          gatewayRuntimes: [codexCatalog(["gpt-deep"], "gpt-deep")], defaultModel: "codex/gpt-deep" });
        await useRuntimeStore.getState().refreshGatewayRuntimes();
        expect(useRuntimeStore.getState().gatewayCatalogState).toBe("ready");
        expect(useRuntimeStore.getState().defaultModel).toBe("codex/gpt-deep");
      });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @ai4s/desktop test -- src/lib/runtime.store.test.ts -t "assistant changes"`

Expected: FAIL — the stale `openai` provider is still in the store.

Run: `pnpm --filter @ai4s/desktop test -- src/lib/runtime.store.test.ts -t "fails during a refresh"`

Expected: FAIL — the failed read marks the catalog unavailable.

- [ ] **Step 3: Implement the change**

In `apps/desktop/src/lib/runtime.ts`, in `refreshGatewayRuntimes`, replace:

```ts
      if (selected === "opencode") {
        if (!source) throw new Error("Assistant is disconnected");
        [providers, configured] = await Promise.all([listProvidersWithAvailability(source, (providers) => {
          if (version === gatewayCatalogVersion && source === opencodeClient && get().gatewayRuntime === selected && get().gatewayUser?.id === account) set({ providers });
        }, { signal, timeoutMs: 15000 }), source.getDefaultModel({ signal, timeoutMs: 15000 })]);
        if (source !== opencodeClient) return;
      }
```

with:

```ts
      if (selected === "opencode") {
        if (!source) throw new Error("Assistant is disconnected");
        [providers, configured] = await Promise.all([listProvidersWithAvailability(source, (providers) => {
          if (version === gatewayCatalogVersion && source === opencodeClient && get().gatewayRuntime === selected && get().gatewayUser?.id === account) set({ providers });
        }, { signal, timeoutMs: 15000 }), source.getDefaultModel({ signal, timeoutMs: 15000 })]);
        if (source !== opencodeClient) return;
      } else if (source) {
        // The selected assistant's effort levels come from this catalog, and
        // the previous assistant's entries must not linger. Its model list
        // comes from /api/runtime, so a failed read must not mark that list
        // unavailable and block the chat.
        providers = await listProvidersWithAvailability(source, (providers) => {
          if (version === gatewayCatalogVersion && source === opencodeClient && get().gatewayRuntime === selected && get().gatewayUser?.id === account) set({ providers });
        }, { signal, timeoutMs: 15000 }).catch(() => [] as ProviderInfo[]);
        if (source !== opencodeClient) return;
      }
```

and in the same function's failure branch, replace:

```ts
        ...(selected === "opencode" ? { providers: [] } : { defaultModel: null }),
```

with:

```ts
        ...(selected === "opencode" ? {} : { defaultModel: null }),
        providers: [],
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @ai4s/desktop test -- src/lib/runtime.store.test.ts -t "assistant changes"` and `pnpm --filter @ai4s/desktop test -- src/lib/runtime.store.test.ts -t "fails during a refresh"`

Expected: PASS.

- [ ] **Step 5: Run the whole store suite**

Run: `pnpm --filter @ai4s/desktop test -- src/lib/runtime.store.test.ts`

Expected: all pass, including `"blocks sends after a refresh fails and discards a stale response from a previous refresh"` and `"catches an offline fetch and recovers with a new authoritative catalog"` — a failed `/api/runtime` read still marks the catalog unavailable and blocks sends, which is the existing contract.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/lib/runtime.ts apps/desktop/src/lib/runtime.store.test.ts
git -c user.name=J0nhyer -c user.email=J0nhyer@users.noreply.github.com commit -m "fix(web): replace the catalog when the administrator changes the assistant

A managed assistant's effort levels came from the previous assistant's
catalog, which was never replaced because only OpenCode refreshed it. The
read is contained: a failure removes the effort control, not the chat."
```

---

### Task 4: Prove the control reaches the managed assistant

**Files:**
- Test: `apps/desktop/src/lib/runtime.store.test.ts` (the nested `describe("managed assistant catalog")` from Task 1)
- No implementation change is expected. If a test in this task fails, the defect belongs to Task 1-3.

**Interfaces:**
- Consumes: the store's `providers` as loaded by Task 1; `WebModelPicker` (unchanged); the store's `sendPrompt` (unchanged).
- Produces: proof that a loaded managed catalog makes the control appear, that the chosen level is what the turn sends, that a model without levels sends nothing, and that panes are independent.

- [ ] **Step 1: Write the end-to-end test**

Inside `describe("managed assistant catalog")`, add:

```ts
      it("shows the effort control for a managed assistant and sends the level the user chose", async () => {
        await loadWithManagedAssistant();
        render(createElement(WebModelPicker, { sessionId: "ses_a" }));
        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: "Reasoning effort: Low" }));
        await user.click(screen.getByRole("menuitem", { name: "High" }));
        await act(() => useRuntimeStore.getState().sendPrompt("research", "ses_a"));
        expect(mocks.sendPromptFullSpy).toHaveBeenLastCalledWith("ses_a", "research", undefined, "codex/gpt-deep", "high");
        await act(() => useRuntimeStore.getState().sendPrompt("other", "ses_b"));
        expect(mocks.sendPromptFullSpy).toHaveBeenLastCalledWith("ses_b", "other", undefined, "codex/gpt-deep", "low");
      });
```

The second send covers review focus 4: `ses_b` never chose a level, so it sends the model's lowest level, while `ses_a` sends the level its own pane chose.

- [ ] **Step 2: Run the test**

Run: `pnpm --filter @ai4s/desktop test -- src/lib/runtime.store.test.ts -t "shows the effort control for a managed assistant"`

Expected: PASS with Tasks 1-3 in place. If it fails, the catalog is not reaching the component: check that the loaded `providers` hold the assistant's own id (`codex`) and that the selected model key is `codex/gpt-deep`.

- [ ] **Step 3: Run the component suite**

Run: `pnpm --filter @ai4s/desktop test -- src/components/thread/WebModelPicker.test.tsx src/components/thread/WebChoiceMenu.test.tsx`

Expected: all pass, unchanged. The component's own tests already use a `codex` provider fixture.

- [ ] **Step 4: Run the whole store suite once more**

Run: `pnpm --filter @ai4s/desktop test -- src/lib/runtime.store.test.ts`

Expected: all pass.

- [ ] **Step 5: Append the milestone line and commit**

Add to the top of `PROGRESS.md`:

```
2026-10-22 HH:MM The Web client now loads the managed assistant's effort catalog, so the composer's reasoning-effort control is reachable for Codex and the chosen level reaches the turn; the deterministic client tests pass, while publication and live acceptance remain pending.
```

(use the current local time for `HH:MM`)

```bash
git add apps/desktop/src/lib/runtime.store.test.ts PROGRESS.md
git -c user.name=J0nhyer -c user.email=J0nhyer@users.noreply.github.com commit -m "test(web): the managed assistant's effort control reaches the turn

The catalog is loaded rather than injected, the control appears, and the
level a pane chose is what the turn sends."
```

---

### Task 5: Prove it in a real browser

**Files:**
- Modify: `apps/desktop/src/test/webAssistantCompatibility.acceptance.test.mjs`
- No implementation change is expected.

**Interfaces:**
- Consumes: the built Web bundle (`OSD_WEB_CANDIDATE`), the fake platform the scenario serves (`/api/runtime`, `/config/providers` with `gpt-6.1-sol` carrying the variant `low`).
- Produces: browser-level proof that the managed assistant's effort control is reachable and that the turn carries the level.

- [ ] **Step 1: See the assertion fail against the published (pre-fix) bundle**

Copy the published bundle to scratch and point the scenario at it:

```bash
mkdir -p .deploy/a-tmp/effort-red
cp -r /opt/open-science-desktop/.deploy/web-releases/2026-10-22T05-39-55-996Z-734a01dd/web .deploy/a-tmp/effort-red/web
```

Run (from the worktree root):

```bash
OSD_ASSISTANT_BROWSER=1 \
OSD_WEB_CANDIDATE=$PWD/.deploy/a-tmp/effort-red/web \
OSD_PLAYWRIGHT_PATH=/home/ubuntu/.local/lib/python3.10/site-packages/playwright/driver/package \
OSD_CHROMIUM_PATH=/home/ubuntu/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome \
pnpm --filter @ai4s/desktop test -- src/test/webAssistantCompatibility.acceptance.test.mjs
```

Expected before the assertion is added: PASS (the scenario does not look for the control yet). This run proves the scenario itself still works in this environment; keep its output.

- [ ] **Step 2: Add the assertion**

In `apps/desktop/src/test/webAssistantCompatibility.acceptance.test.mjs`, after the model is picked (after line 168, `else await page.getByRole('menuitem',{name:'gpt-6.1-sol',exact:true}).click();`) and before the send at line 172, add:

```js
    const effort=page.getByRole('button',{name:/^Reasoning effort:/}).first();
    await effort.waitFor();
```

and after `await expect.poll(()=>accepted).toBe(1);` (line 173), add:

```js
    expect(writes.filter(row=>row.path.endsWith('/prompt_async')).at(-1).body.variant).toBe('low');
```

- [ ] **Step 3: Run the scenario against the published bundle and watch it fail**

Run the same command as Step 1.

Expected: FAIL — the effort control never appears, because the published bundle's client does not read the managed catalog. This is the red the assertion exists for.

- [ ] **Step 4: Build the fixed bundle and run the scenario against it**

Build the Web bundle through the guarded script:

```bash
pnpm --filter @ai4s/desktop web:build
```

Then run the scenario against the built bundle:

```bash
OSD_ASSISTANT_BROWSER=1 \
OSD_WEB_CANDIDATE=$PWD/apps/desktop/dist \
OSD_PLAYWRIGHT_PATH=/home/ubuntu/.local/lib/python3.10/site-packages/playwright/driver/package \
OSD_CHROMIUM_PATH=/home/ubuntu/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome \
pnpm --filter @ai4s/desktop test -- src/test/webAssistantCompatibility.acceptance.test.mjs
```

Expected: PASS, and the prompt body carries `variant: "low"`.

If the build directory differs from `apps/desktop/dist` in this checkout, read the path from `scripts/dev/web-build.mjs` and use that.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/test/webAssistantCompatibility.acceptance.test.mjs
git -c user.name=J0nhyer -c user.email=J0nhyer@users.noreply.github.com commit -m "test(web): the browser shows the managed assistant's effort control

The assistant compatibility scenario now waits for the effort control
after the assistant switch and checks that the turn carries the level the
client resolved."
```

---

### Task 6: Publish and accept against the real service

**Files:**
- Modify: `PROGRESS.md`
- Not modified: any source file.

**Interfaces:**
- Consumes: the guarded release tooling (`pnpm web:release`), the running platform (`osd-platform.service`), the published release directory.
- Produces: a published release serving the new client, and a real Codex turn observed at a chosen effort.

The release policy treats `apps/desktop/src/lib/runtime.ts` as an assistant change: it runs the full frontend and platform suites, lint, typecheck, the `assistants` and `session` browser scenarios, the assistant launcher/target/recovery stages and a live assistant acceptance with real Codex turns. The image is reused. Budget for the measured preparation of the 2026-10-22 release (source snapshot 36 s, frontend tests 352 s, platform tests 240 s, vendor 7 s, web bundle 44 s) plus the assistant stages.

- [ ] **Step 1: Read the selection the tooling would apply**

```bash
pnpm web:release inspect --source /opt/open-science-desktop/.worktrees/web-login-performance-20261021
```

Expected: `imageRequired` false, `deployPlatform` false, `liveAssistant` true, and the changed paths limited to this plan's files. If `imageRequired` or `deployPlatform` is true, the change has touched an image or platform input — stop and report it instead of publishing; that is a different and much more expensive path.

- [ ] **Step 2: Publish**

```bash
pnpm web:release run --source /opt/open-science-desktop/.worktrees/web-login-performance-20261021
```

Expected: the release prepares and deploys, and the assistant live acceptance passes. Do not start a second publication while one is running, and do not extend a deadline to cover a failure: read the failed stage and diagnose it.

- [ ] **Step 3: Verify the served version and the service**

```bash
cat /opt/open-science-desktop/.deploy/web-releases/current.json
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:4790/health
```

Expected: `current.json` names the new release id, and the health endpoint answers 200.

- [ ] **Step 4: Accept the affected workflow against the real service**

With the new bundle served, sign in as the sole user and, on the Codex assistant:

1. Open a conversation and confirm the reasoning-effort control appears next to the model selector.
2. Choose a level, send a turn, and confirm the reply arrives.
3. Read that conversation's session record and confirm its `variant` field carries the chosen level. The platform stores the applied level on the session (`services/platform/src/cli-runtime.mjs:1113`) and returns it in the public session shape (`:246-257`), so the record is the observation of what the turn actually ran with.
4. Open a second conversation, choose a different level, and confirm the two conversations carry different levels — the scope is per pane.

If the browser tooling cannot reach the service, report the acceptance as not performed rather than as passed.

- [ ] **Step 5: Append the milestone line and commit**

Add to the top of `PROGRESS.md`:

```
2026-10-22 HH:MM Release <id> published the managed assistant's reasoning-effort control, and a live Codex turn was observed at the chosen level in the session record; the installed image was reused and the platform was not redeployed.
```

```bash
git add PROGRESS.md
git -c user.name=J0nhyer -c user.email=J0nhyer@users.noreply.github.com commit -m "docs: record the published reasoning-effort control and its live acceptance"
```

---

## Self-Review

- **Spec coverage:** §4.1(a) → Task 1 and Task 2; §4.1(b) → Task 3; §4.2 (effort semantics) → unchanged code, covered by the existing tests and Task 4; §4.3 (the accepted consequence) → unchanged behavior, asserted by Task 4's second send and the existing `"replaces explicit default with the lowest supported effort"` test; §4.4 → no task touches the OpenCode path, the settings panel, the model list or the desktop; §4.5 → Task 5's browser assertion; §4.6 → Task 2 and Task 3's failure tests; §5 → Task 4, Task 5, Task 6; §6 → Task 6.
- **Placeholder scan:** no step says "add appropriate handling" or names a test without its code. Every step names the file, the command and the expected result.
- **Type consistency:** `managed` is a boolean used by Tasks 1-3 in `runtime.ts`; `managedProviders` and `codexCatalog` are the fixtures the tests share; `mocks.failProviders` is declared in Task 1 and used in Tasks 2 and 3; the `ProviderInfo[]` annotation in the containment matches `listProvidersWithAvailability`'s return type.
- **Review focus:** 1 → Tasks 2 and 3; 2 → the existing `"clears invalid effort on model switch"` test plus Task 4; 3 → Task 3's first test; 4 → Task 4's second send; 5 → Task 4's first send and the existing lowest-level test.
