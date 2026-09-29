# Web Account, Assistant, and Model Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give authenticated Web users one account menu and synchronized, usable AI assistant/model selection in chat and Settings while preserving per-conversation models.

**Architecture:** The Web runtime store owns account identity, selected assistant, readiness, and refresh of the backend's safe live catalog. A pure Web catalog adapter feeds compact accessible pickers shared by the composer and Web Models settings; the desktop-specific Settings and model controls keep their existing behavior.

**Tech Stack:** React 18, TypeScript, Zustand, existing Tailwind/Radix/lucide UI, Vitest + Testing Library, existing `OpenCodeClient` compatibility surface.

**Spec:** `docs/superpowers/specs/2026-09-28-web-account-assistant-model-experience-design.md`

## Global Constraints

- Only the authenticated multi-user Web client gets new product UI; shared modules must continue to type-check/build for desktop.
- Say “AI assistant” in ordinary Web copy; keep existing `runtime` internal names and HTTP contracts.
- OpenCode users retain all their existing connected providers/models; Claude/Codex use only the safe live catalog from the backend plan.
- Account settings and Sign out stay reachable at the bottom of both Web sidebars, including a 390 CSS-pixel phone viewport.
- A Settings default affects new managed sessions; a composer model choice affects only the active conversation. Managed model keys remain `<assistant>/<model-id>`.
- Hide provider authentication, endpoints, custom provider setup, and obsolete managed-model administration from Web Models settings; never expose credentials.
- Do not merge this branch before user acceptance; deploy only after all backend/Web tests and a fresh production build.

## File Structure

- Modify `apps/desktop/src/lib/runtime.ts`, `apps/desktop/src/lib/runtime.store.test.ts`: user identity, assistant readiness/catalog refresh, switching and per-session model restoration.
- Create `apps/desktop/src/lib/webModelCatalog.ts`, `apps/desktop/src/lib/webModelCatalog.test.ts`: pure assistant-specific model choices and safe fallback selection.
- Modify `apps/desktop/src/components/thread/RuntimePicker.tsx`, `apps/desktop/src/components/thread/RuntimePicker.test.tsx`: consistent AI assistant menu for Web.
- Create `apps/desktop/src/components/thread/WebModelPicker.tsx`, `apps/desktop/src/components/thread/WebModelPicker.test.tsx`: simplified Web model menu; leave the existing desktop `ModelPicker.tsx` implementation untouched.
- Modify `apps/desktop/src/components/thread/Composer.tsx` and focused composer tests: place the two Web pickers together.
- Create `apps/desktop/src/components/settings/GatewayModelsPanel.tsx`: two settings choices using the same pickers and store.
- Modify `apps/desktop/src/app/routes/SettingsPage.tsx`, `apps/desktop/src/app/routes/SettingsPage.web.test.tsx`: simple Web Models panel and removal of obsolete Web provider/admin surfaces.
- Create `apps/desktop/src/components/sidebar/GatewayAccountMenu.tsx`, `apps/desktop/src/components/sidebar/GatewayAccountMenu.test.tsx`; modify `apps/desktop/src/components/sidebar/Sidebar.tsx`: fixed bottom account menu in normal/Settings sidebars.
- Modify the existing `apps/desktop/src/i18n` resources providing `nav`, `session`, and `settings` labels for every supported UI language; check their actual paths before editing.
- Modify `PROGRESS.md`: append a dated English milestone on top after verified Web implementation.

---

### Task 1: Unify Web Account and Live Assistant Store State

**Files:** Modify `apps/desktop/src/lib/runtime.ts`, `apps/desktop/src/lib/runtime.store.test.ts`.

**Interfaces:** Export `GatewayUser = { id: string; username: string; role: "admin" | "user" }`; store `gatewayUser: GatewayUser | null`, `gatewayCatalogState: "loading" | "ready" | "limited" | "unavailable"`, `refreshGatewayRuntimes(): Promise<void>`, and existing `selectGatewayRuntime(id): Promise<void>`; keep `gatewayUserRole` as a derived compatibility value only while old tests/components require it.

- [ ] **Step 1: Write failing store tests.** Stub `/api/me` with full identity, `/api/runtime` with all three assistants and two different revisions, and two independent session catalogs. Assert the store returns `gatewayUser.username`, switches without posting a stale model, keeps old sessions when POST fails, clears old models on success, and does not show Claude models while Codex is loading. For a managed session returned with public `model: "codex/gpt-two"`, assert the composer restores that model after reconnect without changing the account default or another session's selection.

```ts
expect(useRuntimeStore.getState().gatewayUser).toEqual({ id: "usr_1", username: "test1", role: "user" });
expect(JSON.parse(String(postInit?.body))).toEqual({ runtime: "codex" });
expect(useRuntimeStore.getState().providers).not.toContainEqual(expect.objectContaining({ id: "claude" }));
```

- [ ] **Step 2: Run focused tests, verify failures.** `pnpm --filter @ai4s/desktop test src/lib/runtime.store.test.ts` must fail at new identity/readiness assertions.
- [ ] **Step 3: Update store and refresh.** Parse full `/api/me` safely; make `/api/runtime` GET refresh only safe assistant fields and replace entries by assistant/revision; poll on visibility/focus and every 60 seconds in Web mode, with cleanup on disconnect. On selection, POST only `{ runtime }`, preserve original state until POST succeeds, then clear old session/catalog fields and await reconnect plus session/catalog readiness. On a successful POST followed by failed reconnect, retain the selected assistant with retryable error, never restore the old catalog. Skip updates from stale refresh requests after a newer assistant switch. For managed sessions only, reconcile each public session `model` with `sessionModels[session.id]` during session-list refresh; clear obsolete model keys on assistant switch so another account/assistant cannot inherit a stale browser-local override.
- [ ] **Step 4: Run tests and commit.** `pnpm --filter @ai4s/desktop test src/lib/runtime.store.test.ts`; commit with `feat(web): track signed-in user and live assistant readiness`.

### Task 2: Isolate Catalog Choices by Assistant

**Files:** Create `apps/desktop/src/lib/webModelCatalog.ts`, `apps/desktop/src/lib/webModelCatalog.test.ts`.

**Interfaces:** Export `type WebModelChoice = { key: string; modelId: string; label: string }` and `webModelChoices(runtime: GatewayRuntimeId, providers: ProviderInfo[], runtimes: GatewayRuntimeOption[]): WebModelChoice[]`. OpenCode keys come from connected providers; managed keys are `${runtime}/${id}` from the matching runtime option only.

- [ ] **Step 1: Write failing pure tests.** Given providers with `openai/gpt-one`, Claude `claude/sonnet`, and Codex `codex/gpt-two`, assert each assistant's list contains only its own choices and unavailable OpenCode provider models are excluded. Switch between all three values with the same input arrays and assert the result never includes the previous assistant's model.

```ts
expect(webModelChoices("codex", providers, runtimes).map((model) => model.key))
  .toEqual(["codex/gpt-two"]);
expect(webModelChoices("claude", providers, runtimes).map((model) => model.key))
  .toEqual(["claude/sonnet"]);
```

- [ ] **Step 2: Verify the new test fails.** `pnpm --filter @ai4s/desktop test src/lib/webModelCatalog.test.ts` must fail on the missing module/export.
- [ ] **Step 3: Implement the pure adapter.** Reuse `flattenModelOptions`/`selectableModelOptions` for OpenCode; map exactly one managed assistant option for Claude/Codex; display only safe IDs/labels; return empty for an unavailable assistant.
- [ ] **Step 4: Run tests and commit.** `pnpm --filter @ai4s/desktop test src/lib/webModelCatalog.test.ts`; commit with `feat(web): isolate assistant model choices`.

### Task 3: Make Chat Assistant and Model Pickers Consistent

**Files:** Modify `apps/desktop/src/components/thread/RuntimePicker.tsx`, `apps/desktop/src/components/thread/RuntimePicker.test.tsx`, `apps/desktop/src/components/thread/Composer.tsx`, `apps/desktop/src/components/thread/Composer.test.tsx`; create `apps/desktop/src/components/thread/WebModelPicker.tsx`, `apps/desktop/src/components/thread/WebModelPicker.test.tsx`; update existing `nav`/`session` translations.

**Interfaces:** `RuntimePicker({ compact? })` shows AI assistant choices in Web mode; `WebModelPicker({ sessionId: string, compact?: boolean })` reads `webModelChoices` and calls `setSessionModel(sessionId, key)` for both an existing session and the existing `draft:<leafId>` key passed as `modelSessionId` by `SessionView`; the first send already transfers the draft model to the new session. It never calls `setDefaultModel`; desktop `ModelPicker` remains unchanged.

- [ ] **Step 1: Write failing component tests.** Render in gateway mode with ready Codex, a draft key, and two session IDs; assert the assistant/model buttons have accessible names, Codex opens only Codex models, a model click calls `setSessionModel("session-A", "codex/gpt-two")` without changing session B, a draft click calls `setSessionModel("draft:leaf-a", "codex/gpt-two")` without changing the account default, disabled assistant cannot be chosen, and the phone-width picker opens as a bottom sheet with Escape/selection/focus return.

```tsx
await user.click(screen.getByRole("button", { name: /AI assistant/i }));
await user.click(screen.getByRole("menuitem", { name: "Codex" }));
expect(selectGatewayRuntime).toHaveBeenCalledWith("codex");
```

- [ ] **Step 2: Run tests, verify failures.** `pnpm --filter @ai4s/desktop test src/components/thread/RuntimePicker.test.tsx src/components/thread/WebModelPicker.test.tsx src/components/thread/Composer.test.tsx` must fail on new menu behavior.
- [ ] **Step 3: Implement custom Web controls.** Use the repo's Radix dropdown/menu pattern and existing responsive model-picker sheet pattern; use shared trigger dimensions, chevron/spinner/check icons, status-aware disabled rows, keyboard navigation, visible focus and 40px touch targets. In `Composer`, render Web assistant + Web model picker only for `isGatewayWeb`; use the original `ModelPicker` for desktop. The Web model list omits provider metadata, favorites, auth links, and technical warnings.
- [ ] **Step 4: Run tests and commit.** `pnpm --filter @ai4s/desktop test src/components/thread/RuntimePicker.test.tsx src/components/thread/WebModelPicker.test.tsx src/components/thread/Composer.test.tsx`; commit with `feat(web): add matching assistant and model chat pickers`.

### Task 4: Simplify Models Settings Without Editing Admin CLI Profiles

**Files:** Create `apps/desktop/src/components/settings/GatewayModelsPanel.tsx`; modify `apps/desktop/src/app/routes/SettingsPage.tsx`, `apps/desktop/src/app/routes/SettingsPage.web.test.tsx` and Settings translations.

**Interfaces:** `GatewayModelsPanel` reads the same `gatewayRuntime`/`gatewayRuntimes`, `selectGatewayRuntime`, and `webModelChoices`; its model picker calls `setDefaultModel("<assistant>/<model>")` for account defaults only. On OpenCode it keeps that user's existing default behavior without rendering provider administration.

- [ ] **Step 1: Write failing Web Settings tests.** Navigate to `/settings/models` as user/admin with all three assistant fixtures. Assert selecting Codex updates the store globally, the default dropdown changes independently from existing sessions, and neither account sees Provider management, endpoint/auth/custom connection copy, or `ManagedRuntimeModelsCard`; assert no previous-assistant model on switch.

```tsx
expect(screen.queryByRole("heading", { name: "Providers" })).not.toBeInTheDocument();
expect(screen.queryByText(/administrator-managed.*models/i)).not.toBeInTheDocument();
expect(screen.getByRole("button", { name: /AI assistant/i })).toBeInTheDocument();
```

- [ ] **Step 2: Run failing tests.** `pnpm --filter @ai4s/desktop test src/app/routes/SettingsPage.web.test.tsx` must fail on the old provider card/selector.
- [ ] **Step 3: Implement the Web-only panel.** Branch on `isGatewayWeb` early in the `models` section and render `GatewayModelsPanel` as its sole content; remove old Web `ManagedRuntimeModelsCard` rendering. Keep all existing desktop Settings code paths intact. Clear local provider cache on assistant changes and use the shared adapter for all Web choices, including OpenCode.
- [ ] **Step 4: Run Web and desktop regression tests, commit.** `pnpm --filter @ai4s/desktop test src/app/routes/SettingsPage.web.test.tsx src/app/routes/SettingsPage.modelBrowser.test.tsx`; commit with `feat(web): show assistant and default model only in settings`.

### Task 5: Put Account Menu at the Sidebar Bottom

**Files:** Create `apps/desktop/src/components/sidebar/GatewayAccountMenu.tsx`, `apps/desktop/src/components/sidebar/GatewayAccountMenu.test.tsx`; modify `apps/desktop/src/components/sidebar/Sidebar.tsx`, sidebar translations.

**Interfaces:** `<GatewayAccountMenu user={gatewayUser} showUpdateBadge={showUpdateBadge} />` uses the shared account identity and React Router navigation; Sign out remains `<form method="post" action="/auth/logout">`.

- [ ] **Step 1: Write failing account tests.** Render a student and admin, open the menu, assert username, first-character avatar, conditional Admin badge, Settings navigation, and native POST form action. Render sidebar at `/live` and `/settings/models`; assert one account trigger anchored after primary navigation and no standalone Web logout/Settings actions. Assert desktop sidebar remains unchanged.

```tsx
await user.click(screen.getByRole("button", { name: /test1.*account/i }));
expect(screen.getByRole("menuitem", { name: "Settings" })).toBeVisible();
expect(screen.getByRole("menuitem", { name: "Sign out" }).closest("form"))
  .toHaveAttribute("action", "/auth/logout");
```

- [ ] **Step 2: Verify tests fail.** `pnpm --filter @ai4s/desktop test src/components/sidebar/GatewayAccountMenu.test.tsx src/components/sidebar/PlatformLogoutButton.test.tsx` must fail on missing account menu.
- [ ] **Step 3: Implement menu.** Use the existing Radix dropdown style; render it at the bottom in both sidebar branches (also inside the phone drawer); keep the update badge in the trigger. Remove `PlatformLogoutButton` from Web sidebar only, leave its standalone component/tests unmodified for compatibility. Restore focus to the account trigger when the menu closes.
- [ ] **Step 4: Run tests and commit.** `pnpm --filter @ai4s/desktop test src/components/sidebar/GatewayAccountMenu.test.tsx src/components/sidebar/Sidebar.sessions.test.tsx src/components/sidebar/PlatformLogoutButton.test.tsx`; commit with `feat(web): group account actions at sidebar bottom`.

### Task 6: Integrate and Deploy for User Acceptance

**Files:** Modify `PROGRESS.md` after verified results; no extra feature files.

**Interfaces:** The public gateway must serve Web chat and Settings from the same authenticated platform session; native CLI credentials stay server-side.

- [ ] **Step 1: Run full build gates.** `pnpm platform:test`, `pnpm typecheck`, `pnpm lint`, `pnpm --filter @ai4s/desktop test`, `pnpm build`, and `git diff --check` must pass. Inspect any inherited flaky failure before changing code.
- [ ] **Step 2: Verify the real browser.** At desktop and 390 CSS pixels, log in as student/admin, test account menu, switch all three assistants in composer and Settings, inspect model lists for cross-assistant leakage and ensure successful sign-out. Use disposable test credentials and preserve existing production account data.
- [ ] **Step 3: Deploy the tested Web bundle and backend on the existing feature branch.** Verify anonymous redirect/login, `/api/me`, `/api/runtime` safe catalog and role checks, Codex full installed catalog, Claude and OpenCode turns, conversation model isolation and stale-link recovery. Exercise relay URL changes using a separate disposable profile/fixture, never the live administrator's relay tokens. Record actual pass/fail results, deployment method, and the public entry URL; ask the user to inspect the deployment before merging.
- [ ] **Step 4: Record completion.** Add one dated English results line at the top of `PROGRESS.md` and commit the verified integration/deployment note. Do not merge to `master` before the user's acceptance.

**Handoff:** Execute the backend plan first. If the user wants fewer review checkpoints, both documents may be executed sequentially by the same agent; two documents do not imply two teams or two deployments.
