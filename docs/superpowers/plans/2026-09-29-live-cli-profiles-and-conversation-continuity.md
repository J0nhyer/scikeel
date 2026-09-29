# Live CLI Profiles and Conversation Continuity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make administrator-enabled Claude Code and Codex follow their server profiles and available models, and continue platform conversations after an upstream relay changes.

**Architecture:** A server-only profile resolver owns file parsing, revision detection, catalog discovery, and immutable per-turn copies. The existing CLI manager consumes its safe snapshot, persists assistant-level permission and conversation models, and starts new native sessions with bounded history when the upstream identity changes.

**Tech Stack:** Node.js >=20 ESM, `node:test`, structured TOML parser, existing platform HTTP server and fake CLI fixtures.

**Spec:** `docs/superpowers/specs/2026-09-28-web-account-assistant-model-experience-design.md`

## Global Constraints

- Work targets the authenticated multi-user gateway Web client; leave OpenCode workers and desktop-only controls functional.
- Keep secrets, full Base URLs, private paths, and authentication error bodies out of HTTP metadata, logs, provenance, and exports.
- Assistant permission is per Claude/Codex CLI; there is no platform per-model allowlist.
- A relay without a complete model-list source has limited discovery, not a claim that the default is the whole catalog.
- Refresh before each managed turn, check local file revisions, bound remote model-list refresh to 60 seconds, and never mix different profile revisions in one turn.
- Keep platform session ID/history across upstream changes; hand over the last 12 completed user/assistant text exchanges, up to 16,000 characters, without tool payloads or failed turns.
- Keep implementation on `feature/cli-model-selection`; deploy for acceptance only after tests and a fresh build, and do not merge before user acceptance.
- Do not print actual CLI credentials, tokens, or relay URLs in test output or logs.

## File Structure

- Create `services/platform/src/cli-profile.mjs`: profile resolution, Codex TOML and Claude settings parsing, native/relay catalog discovery, safe revision metadata, single-flight refresh, and revision-specific private config copy.
- Create `services/platform/test/cli-profile.test.mjs`: isolated profile fixtures, discovery, races, limited discovery, and redaction tests.
- Modify `services/platform/package.json` and `pnpm-lock.yaml`: add a maintained TOML parser as a direct platform dependency; do not parse TOML using a regex.
- Modify `services/platform/src/cli-runtime.mjs`: migrate permissions, consume profile snapshots, bind sessions to models/revisions, handover history, and prevent credential leaks.
- Modify `services/platform/test/cli-runtime.test.mjs` and `services/platform/fixtures/fake-cli.mjs`: migrated contracts and real two-turn/failure behavior using disposable fixture credentials.
- Modify `services/platform/src/platform-server.mjs` and `services/platform/test/platform-server.test.mjs`: safe runtime/admin API responses and role checks.
- Modify `PROGRESS.md`: one dated English line at the top for each completed milestone.

---

### Task 1: Resolve Native Server Profiles

**Files:** Create `services/platform/src/cli-profile.mjs`, `services/platform/test/cli-profile.test.mjs`; modify `services/platform/package.json`, `pnpm-lock.yaml`.

**Interfaces:** Produce `CliProfileResolver({ claudeConfigDir, codexHome, fetchImpl?, clock? })`, `await resolver.refresh(runtime, { forceRemote?: boolean })` returning `{ runtime, identityRevision, catalogRevision, models, defaultModel, status, enabledByProfile, files }`; `files` and credential material are private resolver data, excluded from `resolver.publicOption(profile)`.

- [ ] **Step 1: Add a TOML parser dependency.** Run `pnpm --filter @ai4s/platform add smol-toml`. Verify `package.json` and `pnpm-lock.yaml` both changed; use its `parse` export, not regular expressions.
- [ ] **Step 2: Write failing profile tests.** Create disposable Claude `settings.json` with `env.ANTHROPIC_BASE_URL`, `env.ANTHROPIC_AUTH_TOKEN`, `env.ANTHROPIC_DEFAULT_OPUS_MODEL`, and `model: "opus"`. Create Codex `config.toml` with `[model_providers.OpenAI]`, `base_url`, `wire_api`, `model_catalog_json`, and seven real-shaped `{ slug, display_name }` catalog entries. Assert full Codex model list, resolved Claude alias, changed revisions after changing URL/token/catalog, and `JSON.stringify(resolver.publicOption(profile))` excluding fixture secrets.

```js
assert.deepEqual((await resolver.refresh("codex")).models.map((m) => m.id), expectedSevenIds);
assert.equal((await resolver.refresh("claude")).defaultModel, "fixture-opus-upstream");
assert.ok(!JSON.stringify(resolver.publicOption(await resolver.refresh("claude"))).includes("fixture-secret"));
```

- [ ] **Step 3: Run the focused test and confirm failure.** `node --test services/platform/test/cli-profile.test.mjs` must fail because `CliProfileResolver` is missing.
- [ ] **Step 4: Implement structural resolution.** `parse(await fs.readFile(configToml, "utf8"))`; select the active `model_provider`, preserve the provider's `base_url`/`wire_api` internally, expand the configured catalog path relative to the server profile home, parse its `models` array, and resolve Claude model alias from `settings.json.env`. Hash revision input with a private server key; publish only catalog revision derived from safe model identifiers. Surface missing/invalid files as safe readiness statuses.
- [ ] **Step 5: Run the focused test and commit.** `node --test services/platform/test/cli-profile.test.mjs`; commit only Task 1 files with `feat(platform): read live Claude and Codex profiles`.

### Task 2: Discover Models and Freeze Per-Turn Profile Copies

**Files:** Modify `services/platform/src/cli-profile.mjs`, `services/platform/test/cli-profile.test.mjs`; add fixture-only local HTTP relay inside the test.

**Interfaces:** `refresh(runtime, { forceRemote })` returns safe catalog status (`ready`, `limited`, `unavailable`); `await resolver.copyForTurn(profile, { paths })` returns `{ home, configDir, codexHome }` suitable for `childEnvironment`, with private 0600 config files and no mixed revisions.

- [ ] **Step 1: Add failing tests for catalog change and copy.** Start `node:http` on `127.0.0.1` serving a `/v1/models` fixture; change the configured Base URL, verify the previous catalog disappears, simulate a failed listing, then check the explicitly configured default is `limited`. Mutate a profile while copying, and assert either a consistent original snapshot or a retryable error, never old credentials with the new URL.

```js
assert.equal((await resolver.refresh("claude", { forceRemote: true })).status, "ready");
assert.deepEqual((await resolver.refresh("codex")).models.map((m) => m.id), expectedSevenIds);
assert.equal(await fs.stat(privateConfig).then((s) => s.mode & 0o777), 0o600);
```

- [ ] **Step 2: Confirm the tests fail.** `node --test services/platform/test/cli-profile.test.mjs` must fail at new discovery/copy assertions.
- [ ] **Step 3: Implement bounded discovery and copy.** Prefer the CLI's configured catalog; query only compatible model-list endpoints with the effective server-side credential and a bounded timeout; reject unsupported/invalid responses and redact upstream errors. Dedupe models and apply CLI visibility restrictions. Cache listings for 60 seconds by identity; coalesce concurrent refreshes. Copy each selected input into a temporary revision directory under the user's private home and rename into place only after verifying the source revision. Keep running-turn copies immutable and isolated per user.
- [ ] **Step 4: Run the tests and commit.** `node --test services/platform/test/cli-profile.test.mjs`; commit with `feat(platform): refresh relay catalogs and pin CLI profile per turn`.

### Task 3: Migrate Assistant-Level Access and HTTP Contracts

**Files:** Modify `services/platform/src/cli-runtime.mjs`, `services/platform/src/platform-server.mjs`, `services/platform/test/cli-runtime.test.mjs`, `services/platform/test/platform-server.test.mjs`.

**Interfaces:** `await manager.describe(userId)` and `await manager.adminDescribe()` read fresh safe metadata; `await manager.setAssistantEnabled(runtime, enabled)` stores administrator-controlled permission; `await manager.setUserRuntime(userId, runtime)` selects only a healthy enabled CLI; `/api/admin/runtime` accepts only `{ runtime, enabled }`.

- [ ] **Step 1: Write migration/API tests.** Create version 3 `runtime.json` with a nonempty Codex catalog and empty Claude catalog, then assert the migrated version 4 stores `{ codex: true, claude: false }`, preserves user choices, exposes all seven *live* Codex models, and does not return the upstream URL/auth. Add HTTP tests proving student POST is forbidden and old `{ models, defaultModel }` POST is rejected without changing availability.

```js
assert.equal(saved.version, 4);
assert.equal(saved.assistantEnabled.codex, true);
assert.equal(saved.assistantEnabled.claude, false);
assert.equal((await manager.describe("usr_a")).available.find((r) => r.runtime === "codex").models.length, 7);
```

- [ ] **Step 2: Run failing tests.** `node --test services/platform/test/cli-runtime.test.mjs services/platform/test/platform-server.test.mjs` must fail at version/contract assertions.
- [ ] **Step 3: Implement migration and contract.** Replace `seedManagedRuntimes` and `setManagedRuntime` as catalog authorities; read safe resolver snapshots in metadata endpoints and before selecting a CLI. Persist version 4 `assistantEnabled` and existing `userModels`/`userRuntimes`; map v3 list nonemptiness to booleans once. Keep `runtimeOption`/`describe` response shape, adding safe `status` and catalog revision. Update the admin route's role check and reject old payloads with a concise migration error. Disabled or broken CLI rows remain visible but unavailable.
- [ ] **Step 4: Run both test suites and commit.** `node --test services/platform/test/cli-runtime.test.mjs services/platform/test/platform-server.test.mjs`; commit with `feat(platform): migrate CLI access to assistant switches`.

### Task 4: Bind One Model to Each Managed Conversation

**Files:** Modify `services/platform/src/cli-runtime.mjs`, `services/platform/test/cli-runtime.test.mjs`, `services/platform/fixtures/fake-cli.mjs`.

**Interfaces:** `createSession` persists `model`; `sendPrompt({ userId, sessionId, text, model? })` checks the current catalog before spawn; OpenCode-compatible `prompt_async` accepts `body.model = { providerID: "codex", modelID: "..." }`; `publicSession(session).model` is `<assistant>/<id>`.

- [ ] **Step 1: Write failing per-session tests.** Select a different model in each of two sessions of one user, send both prompts and reload manager from disk. Assert the CLI received each selected model and the account default did not change. Send `claude` provider for a `codex` session and an unknown Codex model; assert synchronous 400 and no CLI spawn.

```js
assert.equal((await manager.getOwnedSession("usr_a", first.id)).session.model, "gpt-fast");
assert.equal((await manager.getOwnedSession("usr_a", second.id)).session.model, "gpt-deep");
assert.equal(manager.modelForUser("usr_a", "codex"), "gpt-fast");
```

- [ ] **Step 2: Run failing test.** `node --test services/platform/test/cli-runtime.test.mjs` must fail at per-session selection.
- [ ] **Step 3: Implement model binding.** Validate the optional model before accepting `prompt_async` (do not return 202 before validation), create/persist session default, resolve missing legacy models from current per-user default, revalidate on each turn, and pass `session.model` into `commandFor`. Keep the compatible public model key and status events. Copy the exact revision before constructing/spawning the command.
- [ ] **Step 4: Run tests and commit.** `node --test services/platform/test/cli-runtime.test.mjs`; commit with `feat(platform): bind managed CLI model to conversation`.

### Task 5: Rehydrate Conversations After Upstream Changes

**Files:** Modify `services/platform/src/cli-runtime.mjs`, `services/platform/test/cli-runtime.test.mjs`, `services/platform/fixtures/fake-cli.mjs`.

**Interfaces:** `session.identityRevision` is server-only; `handoverText(history, { maxExchanges: 12, maxChars: 16000 })` returns a bounded quoted transcript or an empty string. Native session state is committed only after a successful CLI turn.

- [ ] **Step 1: Write failing continuity tests.** Complete one Claude and one Codex turn using the fake CLI, change the Base URL and credentials in disposable admin fixtures, then assert next turn preserves platform session ID/history but starts without `--resume`/`resume`. Inspect fake CLI prompt to verify only completed text is handed over. Include a failed new turn: retained old history, unchanged old identity, and clean retry; test catalog-only change still resumes the same native session. Make the fake CLI emit a failure containing its fixture token, Base URL, and private profile path; assert its public HTTP error and structured logs contain none of them, while a safe message still explains the CLI failure.

```js
assert.equal(continued.id, original.id);
assert.notEqual(continued.identityRevision, original.identityRevision);
assert.ok(!spawnArguments.includes("resume"));
assert.ok(handoverText(history, { maxExchanges: 12, maxChars: 16000 }).length <= 16000);
```

- [ ] **Step 2: Run failing tests.** `node --test services/platform/test/cli-runtime.test.mjs` must fail on identity and handover assertions.
- [ ] **Step 3: Implement successful-turn commit and handover.** Read completed alternating user/assistant text only; strip tool parts and failed turns, take newest 12 exchanges within 16,000 characters, and prefix a clearly quoted context section. On identity change, omit the old native session handle and inject context into the next prompt; update identity/native handle only on success. Ensure any native session ID seen in an error event stays uncommitted. On catalog-only changes, preserve per-user native files for resume. Sanitize raw CLI stdout/stderr and spawn errors before including them in public messages or structured logs: remove effective credential values, full Base URLs, and private profile paths from the active snapshot; never log the original exception text. Keep sanitized CLI error semantics visible to the user.
- [ ] **Step 4: Run tests and commit.** `node --test services/platform/test/cli-runtime.test.mjs services/platform/test/platform-server.test.mjs`; commit with `feat(platform): continue chat after relay changes`.

### Task 6: Verify and Prepare Web Acceptance

**Files:** Modify `PROGRESS.md` when the verified backend milestone is complete.

**Interfaces:** The Web plan consumes `/api/runtime` safe `available` metadata, `GET /config/providers`, `PATCH /global/config`, `/session` public model, and `POST /session/:id/prompt_async` with validated optional model.

- [ ] **Step 1: Run platform suite.** `pnpm platform:test` must pass, including prior OpenCode worker and multi-user isolation checks.
- [ ] **Step 2: Inspect public metadata for leaks.** In tests, stringify `/api/runtime`, `/api/admin/runtime`, `/config/providers`, `/session` and assert disposable credential/relay fixtures do not appear; inspect platform log events for fixture secrets.

```js
assert.ok(!JSON.stringify(publicResponses).includes("fixture-secret"));
assert.ok(!JSON.stringify(loggedEvents).includes("fixture-relay-url"));
```

- [ ] **Step 3: Verify repository and commit milestone.** `git diff --check`, then add one dated English result at the top of `PROGRESS.md` and commit `docs(progress): verify live CLI profiles`.

**Handoff:** Complete this backend plan before the Web plan. Keep disposable profile changes out of `/etc/osd-platform.env` and live administrator homes; production deployment happens after both plans pass.
