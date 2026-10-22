# Web Managed Assistant Reasoning Effort

Date: 2026-10-22
Status: Design approved by the user on 2026-10-22 (Asia/Shanghai). Implementation, publication and live acceptance are pending. The implementation plan is [Web Managed Reasoning Effort](../plans/2026-10-22-web-managed-reasoning-effort.md).
Scope: The authenticated multi-user gateway Web client, including phone-width viewports. The active assistant is a managed CLI (Codex). No platform, image, native CLI, protocol or desktop change is in scope.

## 1. User requirements

- A user chatting with a managed assistant (Codex) can choose the reasoning effort for the next turn from the chat composer, next to the model selector. The control is the existing dropdown that already ships in the bundle; it is hidden today, not missing.
- The choice belongs to the pane (session) that is being chatted in. Two panes of the same conversation may hold different efforts. The composer is the only surface; no settings page, dialog or per-model global is added.
- The control covers every managed CLI assistant. Only Codex is exercised in live acceptance, because Claude is currently unusable under the standing project instruction and is excluded from live probes and release gates.
- One rule governs both assistant families: an effort the user has not chosen resolves to the lowest level the selected model exposes, and an effort is always sent explicitly. The OpenCode path already behaves this way and does not change.
- The change is frontend-only. It must not require a platform change, a native agent rebuild, a scientific image rebuild, a new endpoint or a new settings surface, and it must not alter desktop behavior, approval defaults, the model list, or the sent model.

## 2. Verified observations and their limits

These observations come from the deployed service, the frozen published source, and the host configuration the platform reads. Main-checkout changes are not evidence of deployed behavior.

| Observation | Evidence | Consequence |
| --- | --- | --- |
| The active assistant is Codex with `gpt-6.1-sol`. | `.deploy/assistant-release-independent-verification.json` (verified 2026-10-19): `activeRuntime: "codex"`, `models: ["gpt-6.1-sol"]`, `revision: 18`. The deployed compatibility design fixes the same single model. | The assistant family under test is the managed one, and the model exposes effort levels. |
| The live Web bundle is built from one worktree, not from the main checkout. | `.deploy/web-releases/current.json` → `2026-10-22T05-39-55-996Z-734a01dd`; that release's `manifest.json` → `source.original: /opt/open-science-desktop/.worktrees/web-login-performance-20261021`. The worktree's `runtime.ts`, `WebModelPicker.tsx` and `webModelCatalog.ts` are byte-identical to the published snapshot. | The change lands in that worktree. The main checkout (`feat/research-work-modes`) is an older line and is not the publication source. |
| The deployment's Codex catalog gives the live model six effort levels. | `~/.codex/config.toml`: `model = "gpt-6.1-sol"`, `model_catalog_json = "/home/ubuntu/.codex/codex-gateway-models.json"`, `model_reasoning_effort = "medium"`. `codex-gateway-models.json`: `gpt-6.1-sol` → `supported_reasoning_levels: [low, medium, high, xhigh, max, ultra]`. | The levels exist on the host. Only the browser cannot see them. |
| The platform already serves that catalog to a managed client. | `services/platform/src/cli-profile.mjs:59-64` reads the configured catalog and `codexVariants` (`:15-20`) turns each level into a variant; `services/platform/src/cli-runtime.mjs:1443-1457` answers `GET /config/providers` with `{providers:[{id: runtime, models:[{id, name, variants, limit:{context:0}}]}]}`; `services/platform/src/platform-server.mjs:705-713` answers the sanitized handler before proxying. | No platform change is required. The data is already on the wire. |
| The managed route policy already permits the catalog read and a per-turn effort. | `services/platform/src/runtime-route-policy.mjs:43` `route("GET", "/config/providers", "modelCatalog")`; `:47-50` the `prompt_async`/`message` body fields include `variant`. | The transport is complete. |
| The platform validates and forwards the effort. | `cli-runtime.mjs:892-897` rejects a variant the chosen model does not expose (`invalid_variant`, 400); `:728` adds `--effort <variant>` for Codex, `:750` adds `-c model_reasoning_effort=<variant>` for Claude; `cli-runtime.mjs:1356-1361` reads `body.variant` from the prompt body. | The server side of the feature exists and is strict. |
| The client never asks for that catalog while a managed assistant is active. | Published source `apps/desktop/src/lib/runtime.ts:4418` `if (isGatewayWeb && assistant && assistant !== "opencode") return;` — the models step of `loadCatalog` returns before reading it; `:3937` `if (selected === "opencode")` — `refreshGatewayRuntimes` only refreshes it for OpenCode. `providers` therefore stays `[]` (initial state `:4068`). | This is the one broken link in the chain. |
| The composer control is already built, and already gated on that catalog. | `apps/desktop/src/components/thread/WebModelPicker.tsx:35-36` derives `variants` from `providers`; `:59` renders the effort menu only when `variants.length > 0`; `apps/desktop/src/components/thread/WebModelPicker.test.tsx:23-31` already uses a `codex` provider fixture. | No UI change is required. The control appears as soon as the catalog is present. |
| The send path is already built, and gated on the same catalog. | `apps/desktop/src/lib/runtime.ts:2746-2751` `modelForSession` → `webModelEffort(state.providers, model, …)`; `apps/desktop/src/lib/webModelCatalog.ts:31-36`; `packages/sdk/src/OpenCodeClient.ts:1591-1631` sends `variant` in the `prompt_async` body, and `:201-206` `parseModel` turns `codex/gpt-6.1-sol` into `{providerID:"codex", modelID:"gpt-6.1-sol"}`, which `cli-runtime.mjs:1356-1360` accepts. | No send-path change is required. |
| The deployed rule for an unset effort is "lowest supported level, always explicit". | Commit `c8b15a7` removed the "Model default" entry from the menu and added `webReasoningEffort` (`webModelCatalog.ts:25-29`); `webModelCatalog.test.ts:32-45` and `WebModelPicker.test.tsx:50-62` pin the rule. | The managed path reuses this rule; the existing tests stay valid and are not rewritten. |

Limits of these observations. The effort control has never been exercised against the live managed assistant, so no end-to-end measurement of a Codex turn at a chosen effort exists yet. The catalog contents above were read from the host files the platform itself reads, not from an authenticated response of the running service: this investigation held no authenticated session, so `GET /config/providers` and `GET /api/runtime` were not called. The assistant and model identity are taken from the release verification artifact and the deployed compatibility design, both of which predate this document by three days. The absence of the control in the deployed Web client was observed directly.

## 3. Root cause

The feature is complete on both sides of the wire and absent only in the browser. The chain, as verified above:

```
Codex catalog (~/.codex/codex-gateway-models.json)
  → platform CliProfileResolver.codexVariants()            [cli-profile.mjs:15-20]
  → platform GET /config/providers → {id:"codex", models:[{variants:[low…ultra]}]}
                                                            [cli-runtime.mjs:1443-1457]
  → client providers                                          ★ never fetched for a managed assistant
                                                            [runtime.ts:4418, runtime.ts:3937]
  → WebModelPicker: variants.length > 0 → the effort menu renders
                                                            [WebModelPicker.tsx:59]
  → modelForSession → webModelEffort → body.variant
                                                            [runtime.ts:2749, OpenCodeClient.ts:1630]
  → platform reservePrompt validates the variant → --effort <variant>
                                                            [cli-runtime.mjs:892-897, :728]
```

Because `providers` is empty for a managed assistant, `variants` is empty, the menu is never rendered, and `webModelEffort` resolves nothing — so the effort could not have been sent even if it had been set.

## 4. Design

### 4.1 The change

Two edits, both in `apps/desktop/src/lib/runtime.ts`, plus their tests. Everything else — the component, the catalog helper, the SDK, the platform, the CLI — is reused unchanged.

**(a) `loadCatalog`, the models step (published source line 4417).** The step currently returns before reading a catalog for a managed assistant. It must instead read the managed catalog, and it must read nothing else for a managed assistant:

- The default model stays owned by `/api/runtime`. The OpenCode-specific `getDefaultModel()` read is not performed for a managed assistant, so the managed default model and its reconciliation path are untouched.
- A managed catalog read that fails, or that returns an empty list, must not change `gatewayCatalogState` and must not make the catalog "unavailable". A managed assistant's model list comes from `/api/runtime`, not from this catalog, so a failed optional read must leave the chat usable and the effort control hidden. The "Model catalog is unavailable" error stays exclusive to the OpenCode path.
- On success the store's `providers` becomes the managed catalog.

**(b) `refreshGatewayRuntimes` (published source line 3935).** The refresh currently loads a catalog only for OpenCode. It must also load the catalog of the selected managed assistant, so that switching assistants replaces the catalog instead of leaving the previous assistant's entries in the store. A managed catalog read that fails must not clear the model list that `/api/runtime` supplied, and must not mark the catalog unavailable; on failure the stale catalog is cleared and the effort control hides, matching the existing "do not offer stale choices" rule.

Both edits are fault-isolated by construction: the managed catalog read is a separate promise whose failure is contained, so it cannot reach the state that governs sending.

### 4.2 Effort semantics

Unchanged, and now reachable for managed assistants:

- The menu lists exactly the levels the selected model exposes, ordered by the SDK's canonical low-to-high ranking. `ultra` is not in that ranking table, so it sorts after the known levels and remains last.
- The user's pick is stored per pane in the existing `sessionVariants` record and travels with the draft into the session it becomes.
- An unset pick resolves to the lowest level the model exposes, and an effort is always sent explicitly.
- Switching a pane to a model that exposes no levels clears the pane's pick and hides the control.

### 4.3 An accepted consequence

The deployment's Codex configuration sets `model_reasoning_effort = "medium"`, and the platform's staged profile preserves that value. Under the rule in 4.2 the client always sends an explicit level, so once this change is live the effective Codex effort becomes the lowest level the model exposes (`low`) until a user chooses otherwise; the configured `medium` no longer reaches the CLI. The user selected this rule on 2026-10-22, for one uniform rule across both assistant families, and accepted that consequence explicitly. It is recorded here so no later reader mistakes it for an accident.

### 4.4 Deliberately unchanged

- The OpenCode assistant's effort behavior, including its always-explicit rule.
- The model list, the default model, the assistant picker and the settings panel. The effort control is hidden in the default-model panel, as it is today.
- The platform, the native CLI, the image, the route policy and the prompt protocol.
- Desktop behavior and approval defaults.

### 4.5 What the user sees

In the chat composer, immediately right of the model selector, a second dropdown with the slider icon appears, labelled with the current effort. It lists the model's levels, lowest first. Choosing one applies to that pane's next turn. On a phone-width viewport the control collapses to its icon, like the model selector next to it. A model without levels shows no control at all.

### 4.6 Failure handling

| Condition | Behavior |
| --- | --- |
| The managed catalog read fails | The chat stays usable; the model list is unchanged; the effort control is hidden. The next catalog refresh retries. |
| The catalog returns no levels for the selected model | No effort control; nothing is sent; the model runs at its own default. |
| The user picks a level the platform does not expose | The platform answers `invalid_variant` (400) and the turn does not start. The client only offers levels the catalog listed. |
| The assistant changes while a pane holds an effort | The catalog is replaced with the new assistant's; a pane's stored effort is re-validated against the new model and dropped when it is not exposed. |

## 5. Verification

Deterministic tests, then live acceptance against the running service. Unit success alone is not acceptance.

- The store loads the managed catalog on connect and on an assistant refresh, keeps the managed default model untouched while doing so, and keeps the chat usable when the managed catalog read fails.
- The composer renders the effort control for a managed model that exposes levels, hides it for one that does not, and keeps a pane's pick scoped to that pane.
- The send path emits the resolved effort for a managed model and emits nothing for a model without levels.
- Live acceptance: with the published bundle serving the new client, a user on the Codex assistant sees the effort control, selects a level, sends a turn, and the platform's own turn record shows that level applied to the executed turn. The same observation is repeated for a second pane, proving per-pane scope. A turn on a model without levels must not carry an effort.

## 6. Release path

A frontend-only change publishes through the existing guarded Web release from the worktree that already produced the live bundle. The platform service, the native agent and the scientific image are not rebuilt: none of their sources, dependencies, configuration or compatibility change. The release must be verified as serving the new bundle, the platform health endpoint must respond after the restart, and the live acceptance in section 5 must pass against the running service before the work is reported as delivered.

The worktree that carries the change also carries unrelated uncommitted work from another line of work. The published bundle is built from that working tree, and the repository's practice is to capture the published state in a baseline commit. Implementation commits must therefore not sweep unrelated work into this change.

## 7. Alternatives considered and rejected

1. **Ask the platform for the effective default effort and show it.** Rejected. It would need a platform change, a service restart and a new response field for a display nicety, and the administrator's configured default is not a fact the browser can own. The chosen rule needs no new fact.
2. **Restore a "model default" entry so an unset effort sends nothing.** Rejected on 2026-10-22 in favor of one uniform rule. It would also have required rewriting two tests that pin the deployed rule.
3. **Hardcode a default effort in the client.** Rejected: the effective default is a deployment fact, and a hardcoded value silently disagrees with a differently configured deployment.
4. **Build the control from the assistant's own catalog rather than the provider catalog.** Rejected: the provider catalog is already the shape the component and the send path read, and the platform already serves it in that shape.
5. **Add the control to the settings panel as a global default.** Rejected: the requirement is a per-pane control in the composer, and a global default is a separate product decision.

## 8. Scope and review boundary

Included: the client-side managed catalog read, the reach of the existing effort control to managed assistants, and their deterministic tests.

Excluded: platform, image, native CLI, protocol, route policy, OpenCode effort behavior, the settings panel, the model list, desktop behavior, and any second surface for the control.

Self-review checked the source baseline, the fault isolation of the new read, the ownership of the default model, the accepted consequence in 4.3, the order of the levels, and the unchanged behavior of the OpenCode path.
