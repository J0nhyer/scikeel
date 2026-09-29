# Web Account, AI Assistant, and Model Experience Design

**Status:** Approved for implementation planning on 2026-09-29

## Context

The public multi-user Web client currently exposes several implementation
details that are confusing to ordinary users:

- Settings and sign-out are separate buttons instead of a conventional account
  menu.
- The conversation composer uses a native CLI selector beside a much richer
  model selector, so the controls look unrelated and visually inconsistent.
- The user-facing term "runtime" describes an internal architecture concept,
  not the user's choice between OpenCode, Claude Code, and Codex.
- The Web Models page owns a local provider cache. Switching between OpenCode,
  Claude Code, and Codex does not change the platform origin, so the page can
  continue rendering the previous assistant's models.
- The Web Models page exposes OpenCode provider, endpoint, authentication, and
  other engineering details that internal student users do not need.
- Claude Code and Codex currently store a model per user and assistant. Their
  prompt compatibility endpoint ignores a conversation-level model, even
  though the composer presents its model selection as conversation-specific.
- Claude Code and Codex currently seed a single model from their server profiles
  and save an administrator-maintained static allowlist in `runtime.json`.
  Subsequent server configuration or relay changes can reach execution while
  the Web catalog remains stale. The installed Codex configuration points to a
  separate JSON catalog with several models, which the current seeding ignores.
- The server's active relay provider, Base URL, credentials, and available
  models can all change independently of platform releases.

This design makes the Web client a simple product flow: identify the signed-in
user, choose an AI assistant, choose a model, and start a conversation.

## Scope

This work targets only the authenticated public multi-user gateway Web client.

Shared modules must continue to type-check and build, but desktop UX, desktop
feature parity, and desktop acceptance testing are outside the current product
scope. Desktop-only controls must retain their existing behavior.

## Goals

1. Add a conventional account menu at the bottom of the Web sidebar.
2. Replace the native assistant selector in the composer with a polished,
   responsive custom picker beside a matching model picker.
3. Use "AI assistant" in ordinary user-facing Web copy instead of "runtime".
4. Make the composer and Models settings page share one assistant selection and
   one model-catalog policy.
5. Ensure switching assistants immediately removes the previous assistant's
   models, conversations, and technical information from the visible UI.
6. Hide provider, API endpoint, authentication, and connection-management
   details from the Web Models page.
7. Make conversation-level model selection real for server-managed Claude Code
   and Codex sessions.
8. Follow the effective server CLI profiles, including provider/Base URL,
   authentication, default model, and live model discovery, without manually
   maintaining a platform model allowlist.
9. If an administrator enables an assistant, offer every model discoverable
   from the active CLI profile/compatible relay without a platform allowlist.
10. Preserve platform chat history and continue the conversation safely when
    an upstream relay or credential changes.

## Non-goals

- Building a new administrator configuration editor or a relay configuration UI.
- Adding profile editing, avatars, password changes, or account preferences.
- Renaming internal `runtime` types, APIs, or persistence fields.
- Changing desktop navigation or desktop model-management UX.
- Exposing provider credentials or server CLI configuration to ordinary users.
- Guaranteeing complete discovery from relays with no model-list API or native
  CLI model catalog, or proving that a listed relay model works without a real
  CLI turn; report failures honestly at send time.

## Terminology

User-facing Web terminology uses the following vocabulary:

- **AI assistant**: OpenCode, Claude Code, or Codex.
- **Model**: a model available under the selected AI assistant.
- **Account**: the authenticated platform user.

The internal codebase and HTTP API may continue to use `runtime`, because those
names are compatibility contracts. Administrator-only copy may continue to use
"CLI" where it accurately describes server configuration.

## User Experience

### Account menu

The bottom of the Web sidebar contains one full-width account trigger:

- a circular avatar containing the first visible username character;
- the username;
- an `Admin` badge for administrators only;
- a chevron indicating that the row opens a menu.

The trigger remains at the bottom of the sidebar on the main application and in
Settings. On phone-width layouts it appears inside the existing sidebar drawer.

The menu contains exactly:

1. **Settings** — navigates to the Web Settings entry route.
2. **Sign out** — submits a `POST` to `/auth/logout` so the server revokes the
   HttpOnly platform session and redirects to `/login` even if the React runtime
   is unhealthy.

The existing standalone Settings and Sign out buttons are removed from the Web
sidebar. Desktop keeps its existing Settings entry and has no account menu.

### Composer selectors

The Web composer shows two adjacent custom buttons:

- `AI assistant · <name>`
- `Model · <name>`

Both use the same visual language: rounded button, concise label, current value,
chevron, selected-row check mark, disabled state, and switching spinner.

The AI assistant menu lists OpenCode, Claude Code, and Codex. A disabled
assistant or one whose server profile cannot supply a usable model remains
visible but disabled and explains that it is unavailable.

The model menu lists only models belonging to the selected assistant. It does
not display provider-management actions, endpoint details, credentials,
context-window warnings, provider filters, or other administration-oriented
information. Search appears only when the list is long enough to benefit from
it.

At phone width, both pickers render as bottom sheets with large touch targets.
Their triggers may collapse to the selected assistant and model names when
horizontal space is limited.

### Models settings page

The ordinary Web Models page contains a focused selection surface:

1. AI assistant
2. Default model

Changing the AI assistant here changes the account's global assistant and is
immediately reflected in the composer. Changing the default model affects new
conversations for that assistant.

The page does not render the OpenCode Provider card, provider counts, API
endpoint instructions, authentication state, custom endpoint controls, or
other runtime engineering information in Web mode.

The old administrator-managed Claude/Codex model-list editor is hidden in Web
mode because its stored list is no longer an authority for usable models. A
future administrator settings design can expose assistant-level enable
switches. This iteration migrates the old list's non-empty state to a persisted
`enabled` boolean and lets administrators change that boolean via the existing
administrator-only runtime API; the old model-list write contract is retired
with a clear error. Profile health determines whether an enabled assistant can
actually be selected.

## State Architecture

### Authenticated user

The runtime store retains the complete safe `/api/me` identity instead of only
the role:

```ts
interface GatewayUser {
  id: string;
  username: string;
  role: "admin" | "user";
}
```

The account menu reads this single store value. No username is copied into a
component-local cache or browser storage.

### Selected assistant

`gatewayRuntime` remains the internal source of truth for the account's selected
assistant. The composer and Settings call the same `selectGatewayRuntime`
action. Neither component keeps a second selected-assistant state.

User-facing components refer to this value as the selected AI assistant. The
implementation does not rename platform endpoints or persisted configuration.

### Unified model catalog

A Web-only pure catalog adapter produces a common list of model choices:

```ts
interface WebModelChoice {
  key: string;
  modelId: string;
  label: string;
}
```

Its source depends exclusively on the selected assistant:

- OpenCode: flatten the signed-in user's connected OpenCode provider catalog.
- Claude Code: use only the `claude` entry in `gatewayRuntimes`.
- Codex: use only the `codex` entry in `gatewayRuntimes`.

Managed model keys retain the compatibility format
`<assistant>/<model-id>`, such as `codex/gpt-5.6-sol`, while the UI displays the
model label without provider-management clutter.

The composer and Settings consume this adapter. The Web Settings page must not
keep its existing independent `providers` cache as the source for managed
assistants.

### Assistant readiness

The Web store exposes explicit assistant readiness rather than inferring it
from a non-empty model array. During an assistant switch, the visible model and
conversation surfaces remain unavailable until the selected assistant's
metadata, session list, and model catalog have loaded.

This distinction allows the UI to show:

- loading;
- ready with models;
- ready with no configured models;
- connection failure.

It also prevents the old assistant's model list from flashing during a switch.

## Live Server CLI Profiles

The platform resolves one effective server profile per managed assistant. It
reads the files under `PLATFORM_CLAUDE_CONFIG_DIR` and `PLATFORM_CODEX_HOME`
that the installed CLI will actually use, instead of treating the persisted
platform model list as configuration. It resolves the active provider, Base
URL, credential source, API protocol, configured default, catalog source, and
visibility restrictions. Parse Codex TOML structurally and resolve its
`model_catalog_json` path (including `~` relative to the server CLI home);
read Claude `settings.json` and its `env` values, including the effective
model aliases and `ANTHROPIC_BASE_URL`. A settings alias such as `opus` is not
necessarily the upstream model ID.

The resolver exposes an internal snapshot with `identityRevision` (provider,
normalized Base URL, authentication identity), `catalogRevision` (all inputs
that affect available models and their order), status, default model, and
discovered model IDs. Revisions are opaque hashes; credentials, profile paths,
full URLs, and auth source details never enter user-facing API responses,
logs, provenance, or session exports. A token rotation changes identity even
when the URL stays the same. A catalog-only edit changes catalog revision,
leaving native session identity intact.

Both UI metadata and execution use the same fresh profile snapshot. Refresh
the cached snapshot on `/api/runtime`, model-catalog requests, assistant
selection, and immediately before every managed turn; share work per CLI and
coalesce concurrent reads. Periodic refresh with a short TTL notifies active
Web clients when availability changes. File changes force invalidation even
within the TTL; an upstream catalog can change without local file edits, so
periodically re-query it too. A pending change does not mix models from one
revision with credentials from another: synchronize the current configuration
into a private, revision-specific per-user CLI home atomically, then start the
CLI with the matching snapshot. A running turn keeps its immutable profile
copy. Native session artifacts are private to the same user; a catalog-only
profile refresh makes the same user's native session available in the new
profile copy, while an upstream identity change does not reuse the old native
session. If another profile change races refresh or copy, retry once or fail
the turn visibly without running with a mixed profile.

Model discovery uses the active server profile, never the user's browser:

1. Read a configured native CLI catalog in full. In particular, an installed
   Codex profile's `model_catalog_json` is a list, not just `config.toml.model`.
   If a native Codex `model/list` operation is used, start/restart the
   short-lived app-server against the current snapshot so it does not return a
   prior startup's catalog.
2. Where the active provider supports it, query that relay's model-list
   endpoint server-side using the effective CLI authentication and protocol.
   Claude's compatible gateway can expose `/v1/models`; native CLI visibility
   restrictions still apply. A Codex relay may use a different listing
   protocol, so a generic OpenAI `/v1/models` response must not be assumed
   equivalent to the Codex CLI catalog. Include relay models only when they
   can be selected by the corresponding CLI under this profile.
3. Merge compatible sources without duplicates, applying the CLI profile's
   visibility restrictions, then expose every remaining usable model to every
   user allowed to use that assistant. Platform administrators do not maintain
   a second per-model allowlist.
4. If neither the CLI nor the relay provides a complete catalog, expose the
   configured default and explicit CLI model entries with a degraded
   discovery status. Do not claim this is the relay's full model list.

The public runtime response includes only assistant `enabled`, readiness,
catalog revision, model IDs/display names, selected model, default, and a
non-sensitive error/status. The OpenCode user's own connected provider
catalog and access remain unchanged.

Assistant enablement is per CLI, not per model. During migration, an old
non-empty `managedRuntimes[cli].models` becomes `enabled: true`; an empty list
becomes `false`. Existing per-user assistant and default-model selections
survive. After migration, the saved model lists do not control catalog
membership or availability. The administrator-only runtime API accepts an
explicit `{ runtime, enabled }` update; the previous `{ models, defaultModel }`
write receives a migration error and cannot silently restore stale
allowlists. Existing administrator model-editing Web controls are hidden. An
enabled assistant with a broken or missing profile remains unavailable.

When the relay URL/provider/credentials change, discard the old catalog
immediately. Discovery on the new profile either publishes models reported by
the new relay, or explicitly listed in the new effective CLI profile, or
reports unavailable. If a local catalog has not been updated for the new
relay and the relay has no listing endpoint, label those local entries as
unverified and limited discovery; a send failure refreshes the catalog and
surfaces the actual CLI error. An old model is never presented as valid merely
because it appeared in the previous relay's cache.
Saved account defaults and per-conversation models are revalidated against
the new catalog at selection and before a turn; invalid choices fall back to
the new CLI default or first valid model. If there is no model, block sends
with a clear retryable error; platform chat history stays accessible.

OS process environment cannot track changes to another login shell. Profile
files and catalogs refresh live; changes to service-only environment variables
require restarting `osd-platform.service`. Check file revisions before each
turn, refresh remote listings at most once per 60 seconds, and poll safe
metadata from the Web client on focus and every 60 seconds. Credentials are
always used server-side and never embedded in Web model responses.

## Assistant Switching Flow

1. Reject a switch while any turn is running and show a plain-language message
   asking the user to wait for the current answer.
2. Mark the assistant and model controls as switching. Hide the old catalog
   immediately, but keep the previous state internally until the server accepts
   the change.
3. `POST /api/runtime` with the selected assistant. The server resolves the
   saved default against the latest live profile and returns the valid choice;
   the client does not submit a possibly stale model while switching.
4. If the request is rejected, leave the previous assistant active, restore its
   visible catalog, and show the returned error.
5. If the request succeeds, clear the previous assistant's sessions, threads,
   active layout, provider catalog, default model, and readiness flags.
6. Apply the server response as the selected-assistant metadata.
7. Reconnect to the selected assistant and await both its session list and its
   model catalog before ending the switching state.
8. Show a clean draft at `/live`. Returning to another assistant reloads that
   assistant's own persisted conversation history.

If the server accepts the assistant but reconnection fails, the UI continues to
identify the new assistant, shows a retryable connection error, and never
restores the previous assistant's models as if they belonged to the new one.

## Model Selection Semantics

### Settings default

The Models settings page changes the selected assistant's account default:

- OpenCode uses its existing default-model configuration flow.
- Claude Code and Codex update the platform's per-user selected model for that
  assistant.

Each assistant remembers its own default. Switching away and back restores the
last valid selection, falling back to the active server CLI profile's default,
then its first discovered model, if the saved model is no longer available.

### Conversation model

The composer changes the current conversation's model. A new draft initially
inherits the selected assistant's default, but its first send persists that
choice on the newly created session. Changing the model in an existing
conversation updates only that session.

OpenCode keeps its existing session-model behavior.

Claude Code and Codex require a control-plane correction:

- managed sessions persist their selected model;
- session creation captures the account default;
- `prompt_async` validates an optional requested provider/model pair against
  the session's assistant and its current live discovered model catalog;
- the validated choice updates the session before the turn starts;
- CLI command construction uses the session model, with the current account
  default as a migration fallback for older sessions that lack one;
- the public session representation reports the model so a reload restores the
  correct composer selection.

This makes the composer promise truthful: selecting a model changes the current
conversation, not every conversation owned by the account.

### Continuing a conversation after an upstream change

Each managed session stores a server-only `identityRevision` beside its native
CLI session ID. The revision is assigned when the first turn starts and
updated only after a new CLI session successfully accepts a turn. A catalog
refresh with unchanged identity can resume the native session. A provider,
Base URL, or credential change makes that native session ineligible for resume
even if the selected model ID still exists; the public platform session ID,
history, and URL stay unchanged.

On the next turn, revalidate its model, create a new native CLI session with
the new profile, and prepend a bounded handover containing the last 12
completed user/assistant text exchanges, up to 16,000 characters in total.
Exclude tool payloads, partial/failed turns, credentials, and the new user
message itself from the handover. Preserve chronological order, label the
handover as previous conversation context, and tell the CLI to treat quoted
conversation text as data rather than instructions. Continue with the user's
new message as a distinct request. When old text exceeds the cap, include the
most recent complete exchanges and visibly note that earlier context was
omitted. If the new CLI turn fails, keep the existing platform history and
leave the new native handle uncommitted so a retry can start cleanly. A newly
created session or one without useful completed text starts without handover.

If a session's model disappears, record the chosen valid fallback on that
session before a successful next turn so reloads report the effective model.
Changing a model within one unchanged upstream continues the native session
where the installed CLI allows it; if the CLI rejects model changes on resume,
start a new native session using the same bounded handover rule.

## Components and Boundaries

### `GatewayAccountMenu`

Owns account-menu presentation and navigation only. It consumes `gatewayUser`,
the update badge, and the router. Logout remains a native POST form.

### `WebAssistantPicker`

Owns the responsive assistant menu presentation. It consumes assistant options,
the selected value, readiness, and the shared store action. It does not fetch or
persist data directly.

### `WebModelPicker`

Owns the responsive, simplified Web model menu. It consumes model choices and a
selection callback. It supports a default-model mode for Settings and a
conversation-model mode for the composer.

### `GatewayModelsPanel`

Owns only the ordinary Web Models settings surface. It composes the two pickers,
shows loading and error states, and does not know how provider configuration is
stored.

### Web model catalog adapter

Owns pure conversion from runtime-store data to user-facing assistant and model
choices. It contains no React state and no network calls, so source isolation is
covered by focused unit tests.

### Server CLI profile resolver

Reads, fingerprints, and synchronizes the effective server CLI profile and
owns the catalog-discovery cache. It exposes only safe model/status metadata to
the control plane, with no credential material in responses.

### Administrator settings

Do not render `ManagedRuntimeModelsCard` on Web. Keep the role check on the
existing administrator-only runtime API and change its write contract to
assistant-level enablement. Administrator settings UI redesign is deferred.

## Error Handling

- Running turn: disable switching and explain why.
- Assistant unavailable: keep the row visible but disabled.
- Assistant POST rejected: retain the original assistant and model state.
- Reconnection failed after a successful switch: identify the target assistant,
  show retry, and keep old data hidden.
- Model rejected or removed: refresh the selected assistant's metadata, choose
  its live default/first valid model, and show that selection before sending.
- Upstream changes during a turn: the running CLI finishes against the profile
  it started with; the next turn uses the refreshed identity and handover.
- New upstream discovery failure: discard old models, show a retryable error,
  and keep platform conversation history readable.
- Relay has no listing endpoint: show only models explicitly available in its
  native CLI profile with a limited-discovery status.
- Empty model catalog: show a concise unavailable message rather than provider
  setup instructions.
- Invalid or wrong-assistant session URL: replace it with a clean `/live` draft,
  preserving the existing stale-session recovery behavior.
- Logout remains functional even if React or the connected assistant is in an
  error state.

## Responsive and Accessibility Requirements

- The Web flow must work at 390 CSS pixels and normal desktop widths.
- Account, assistant, and model triggers have accessible names independent of
  visible truncation.
- Menus support keyboard opening, arrow navigation, selection, Escape, and
  outside dismissal.
- Switching state is exposed through disabled controls and polite status text.
- Disabled assistants state why they cannot be selected.
- Focus returns to the trigger after a menu closes.
- Touch targets remain at least 40 CSS pixels high in phone bottom sheets.

## Testing Strategy

### Pure catalog tests

- OpenCode choices come only from OpenCode providers.
- Claude choices come only from the Claude managed catalog.
- Codex choices come only from the Codex managed catalog.
- A switch cannot retain choices from the previous assistant.
- Removed managed models fall back to the live CLI default/first model.

### Runtime-store tests

- `/api/me` loads user id, username, and role.
- Assistant switching is global and shared by composer and Settings.
- Old sessions, providers, models, and readiness are cleared only after the
  server accepts the switch.
- A rejected switch restores the previous visible state.
- A successful switch waits for session and model readiness.
- Managed defaults remain separate per assistant.
- Managed conversation models survive session reloads.
- Background refresh replaces only the affected assistant's catalog; a
  refreshed revision cannot reintroduce another assistant's models.

### Component tests

- The account row shows username and administrator badge correctly.
- The account menu navigates to Settings and posts to `/auth/logout`.
- The composer renders matching AI assistant and model buttons in Web mode.
- The assistant menu exposes all three assistants and disabled states.
- The model menu exposes only the selected assistant's models.
- Phone mode renders bottom sheets with usable controls.
- The Web Models page contains only assistant and default-model selection for
  ordinary users.
- Provider-management text and controls are absent in Web mode.
- The obsolete managed-model editor is absent even for administrators.

### Platform tests

- Managed session creation captures the selected default model.
- A prompt can bind a different discovered model to one managed session.
- Another session owned by the same user retains its own model.
- A model from another assistant or outside the current live catalog is
  rejected before the CLI starts.
- Claude and Codex commands receive the session model.
- Existing user and assistant isolation remains intact.
- Codex `model_catalog_json` containing seven entries exposes all seven,
  including models other than its configured default.
- Claude `settings.json.env` Base URL, credentials, and model aliases resolve
  correctly even when `settings.model` holds a short alias.
- Replacing a provider/Base URL or rotating credentials invalidates the old
  catalog and native session ID; a catalog-only change does not invalidate the
  native session.
- A new relay's model list replaces the previous one without manual platform
  model edits; a missing listing endpoint reports limited discovery.
- Failed discovery on a changed upstream does not show stale models as usable.
- Old persisted allowlists migrate to assistant-level booleans, and only the
  administrator can change that boolean; old list-write requests fail clearly.
- Resuming an old platform conversation after an upstream change creates a new
  native session with bounded completed text and keeps its public history; a
  failed handover leaves the old history intact and supports retry.
- No credential, Base URL, secret-bearing error text, or private file path
  appears in public metadata, logs, provenance, or exports.

### Production acceptance

After the focused test suites, TypeScript, ESLint, diff checks, and a fresh Web
build pass:

1. Deploy the Web bundle to the existing platform service.
2. Verify anonymous access redirects to login.
3. Verify an ordinary test account sees its username and no Admin badge.
4. Verify an administrator sees the Admin badge and no obsolete managed-model
   configuration card.
5. Switch among OpenCode, Claude Code, and Codex in the composer and Settings.
6. Confirm both surfaces stay synchronized and each displays only its own
   models; confirm Codex displays every model in its active server catalog.
7. Confirm a conversation-specific managed model reaches the corresponding CLI
   command and does not change a second conversation.
8. Confirm provider, endpoint, and authentication information is absent from the
   Web Models page.
9. Verify the 390-pixel layout and desktop layout in a real browser.
10. Against a safe disposable profile/relay fixture, replace the upstream Base
    URL and catalog, then verify updated choices and old-history handover
    without modifying the live administrator's credentials.
11. Verify sign-out returns to `/login` and `/api/me` becomes unauthorized.

The implementation remains on the feature branch for user acceptance before
merging into `master`.
