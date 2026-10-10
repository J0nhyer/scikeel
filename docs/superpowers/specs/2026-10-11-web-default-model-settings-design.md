# Web Default Model Settings

Date: 2026-10-11
Status: Draft for user review
Scope: Multi-user gateway Web, including phone-width viewports

## 1. User intent

The model control under Settings changes the signed-in user's default model for the selected assistant. New conversations without an explicit model choice inherit this default. A model chosen inside a conversation remains a conversation-level choice. Changing Settings must preserve existing conversations, explicit draft choices, running turns, and other users' defaults.

## 2. Investigation and evidence

The running `osd-platform.service` uses `.deploy/web-releases/2026-10-10T18-04-19-460Z-4fe1363a/source`, not the main checkout. Findings below refer to that deployed source unless stated otherwise. The checkout contains extensive unrelated changes; implementation must start from a production-compatible source and preserve that work.

A read-only authenticated check on 2026-10-11 returned HTTP 200 from `/api/runtime` with the current assistant `opencode`; `/global/config` returned HTTP 200 with `model: opencode/big-pickle`. Codex and Claude were reported disabled/unavailable. No assistant switch, model write, conversation turn, or model-provider acceptance call was performed.

### Verified defect: successful catalog reads can strand the picker in loading

1. `GatewayModelsPanel.tsx` already renders `WebModelPicker defaultMode`. Its selection calls `setDefaultModel`, not `setSessionModel`.
2. `runtime.ts:4115` sets `modelSwitching` and `switching`, writes the default through the SDK, and invokes `connectRetry`.
3. `connectOnce` starts `loadCatalog` without awaiting it (`runtime.ts:3525`). The catalog request can finish before or after reconnection finishes.
4. `loadCatalog` sets `gatewayCatalogState` to `loading` for OpenCode (`runtime.ts:3996`).
5. Its successful publication only calls `reconcileGatewayModels` when `!state.switching`. While switching, it publishes only `{ providers }` (`runtime.ts:4046`), leaving the catalog in `loading`.
6. The switch's `finally` clears `switching` and `modelSwitching`, but never settles the catalog state. There is no guaranteed follow-up catalog publication.
7. `WebModelPicker` disables its control while the catalog is `loading`; the same state also blocks Web sends. A successfully saved default can therefore leave the model control unusable.

The timing dependency was reproduced using the successful publication callback and picker busy expression extracted from deployed files, under the guarded `pnpm release:test` script. Both diagnostic scenarios passed: publication during switching leaves `loading` and a disabled picker; publication after switching publishes `ready` and enables the picker. Evidence: `.deploy/verification/model-default-2026-10-11/catalog-race.test.mjs`.

This proves the state-transition defect. It is not a browser capture of the user's original click and does not establish that every reported inability to switch has this cause. Implementation acceptance must reproduce the complete Settings flow with controlled response ordering.

### Verified adjacent behavior

- The SDK writes `{ model }` to `PATCH /global/config` and reads the same endpoint. The gateway allows model-only config writes; this is not categorically a forbidden configuration action.
- Managed CLI runtimes expose compatible config endpoints and persist the chosen model through `setUserModel`, scoped by user and assistant. They must remain supported, but live Claude acceptance is excluded.
- `WebChoiceMenu` invokes async selections without handling rejection. The store records `modelSwitchError`, but `GatewayModelsPanel` does not present that failure. A failed default write lacks useful feedback in this panel.
- Existing model choices are stored separately in `sessionModels`. The Settings control must retain this separation.

## 3. Options and decision

1. **Clear loading in the switch's finally block.** Small patch, but can label an unfinished or failed catalog as ready. Reject.
2. **Publish catalog availability independently of default-switch ownership.** Let a successful current catalog settle its status while protecting the explicitly requested default from stale reads. Keep SDK routing and existing per-user persistence. Recommended.
3. **Introduce a new default-model service and replace runtime selection.** Larger protocol and migration change without evidence that persistence is broken. Defer.

Use option 2. Keep necessary OpenCode reconnect behavior; do not remove reconnects solely on the basis of this state bug. Managed runtime reconnect behavior may remain as-is for this bounded fix. No unrelated runtime recovery redesign is required.

## 4. Requirements

### R1. Explicit default semantics

Label the Settings control as Default model and explain that it applies to new conversations for the current user and selected assistant. Localize new copy in all seven existing locales. Keep conversation-level model controls separate. Do not imply an administrator-wide default or alter the source CLI profile.

A fresh conversation without an explicit draft model uses the latest saved default. Existing conversations, explicit draft selections, and in-flight turns retain their model. An already displayed draft with no explicit choice follows the default. Existing unavailable-model reconciliation remains governed by existing catalog rules; changing a default alone does not rewrite session choices.

### R2. Correct catalog state during a default change

A successful catalog read for the active connection must publish providers and a truthful `ready`, `limited`, or `unavailable` status even while a default write/reconnect is in progress. Preserve explicit switch ownership of `defaultModel`: a stale config response cannot overwrite the requested model.

Keep existing connection/catalog identity checks. Responses from an older assistant, workspace, account, or connection cannot change the active default or catalog. Do not invent providers, mark an unfinished request ready, clear loading on a timer, or re-enable an empty catalog.

After a successful default write and required reconnection/catalog settlement, the picker is enabled when usable models exist. This must hold for both possible response orders. Catalog failure exposes the existing unavailable/retry behavior instead of indefinite loading. Default-save success and catalog readiness are distinct facts.

### R3. Persistence and isolation

Use the existing SDK boundary for model reads and writes. Persist the current user's default through the existing active-runtime config endpoint. Verify it survives a page reload and is inherited by a new conversation. Preserve every other user's default and existing sessions. Model selection must not store credentials in browser state, logs, provenance, or this spec.

### R4. Visible failure and recovery

Settings must show a localized actionable error when a default change fails and handle the rejected promise. Clear the error when a new attempt starts or succeeds; retain errors from a still-current failure. Avoid duplicate generic notifications.

If the write fails before acceptance, keep the previous saved default. If the write succeeds but reconnect or catalog settlement fails, describe that recovery failure truthfully; do not claim the server reverted the saved default. Readback/retry must reconcile the authoritative saved value. Reset busy flags on every outcome and allow a subsequent attempt when the runtime/catalog is usable.

## 5. Acceptance

Run meaningful tests through package scripts with the existing cgroup limits and serialized heavy-task guard.

- Reproduce the original catalog/switch race against the real store with controlled responses. Verify both fast-catalog and slow-catalog success orders leave the correct default and a usable picker. A stale old default must never replace the chosen default.
- Verify the Settings picker calls the default setter, and the conversation picker only changes that conversation's model.
- Verify a new unbound draft inherits the saved default, an explicit draft choice remains unchanged, an existing conversation keeps its model, and a running turn is not aborted or retargeted.
- Verify config write failure, successful write followed by recovery failure, catalog failure, and retry. Surface accurate errors and avoid unhandled rejection or false-ready status.
- Verify a late old connection/catalog response cannot mutate the new context.
- Verify reload persistence and two-user isolation with deterministic platform fixtures. Preserve deterministic managed-runtime compatibility tests; do not probe Claude live.
- Perform browser acceptance at desktop and phone widths: enter Settings, choose an available default, observe settled feedback, reload, and confirm the default. A fake runtime can verify the new conversation payload without a paid provider call. Any authorized live default change must restore the original default afterward.
- Use bounded typecheck and build checks for the final patch. A failed build leaves the deployed bundle untouched. Desktop UX is outside scope; shared changes must preserve build compatibility.

## 6. Implementation boundaries

Expected changes are limited to catalog publication/default-switch state in `apps/desktop/src/lib/runtime.ts`, default-picker failure handling, `GatewayModelsPanel.tsx`, localized copy, and focused store/component/platform/browser tests. Preserve the existing API and storage schemas unless a concrete failing test demonstrates an additional persistence defect.

This document records diagnosis and a proposed design. No product fix or deployment has been performed for this task. User review precedes an implementation plan.
