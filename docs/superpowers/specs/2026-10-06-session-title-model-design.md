# Session Titles Follow the Conversation Model

Date: 2026-10-06
Status: Spec completed and self-reviewed; implementation is pending a separate execution request.
Scope: Automatic titles in the public gateway Web client using OpenCode.

## 1. Agreed product behavior

A new conversation should receive a short descriptive title using the actual
model selected for its first accepted user message. Choosing a conversation
model must not silently select another provider or model for title generation.
This is the default policy; a separately configurable title model is outside
this change. No new user setting is required.

The user approved this direction and requested a spec before implementation.
Success means automatic titles work for authorized conversation models, model
selection remains isolated between conversations, and manual titles survive.

## 2. Verified cause and evidence

The deployed platform runs from `.worktrees/tenant-science-isolation`.
The affected OpenCode log identifies version `1.18.32`. For session
`ses_ef266f72effeJCiT9hN6IOe2ti`, the production log records:

- `2026-10-05T19:44:56.468Z`: title agent uses `opencode/gpt-5.4-nano`.
- `2026-10-05T19:44:56.837Z`: conversation agent uses `opencode/big-pickle`.
- `2026-10-05T19:44:56.846Z`: title request fails with `AI_APICallError: Forbidden`.

These timestamps are UTC; the failure occurred on October 6 at 03:44:56 in
Asia/Shanghai. Multiple earlier title attempts show the same failure.
The affected session retains its default title in the production SQLite store.

The inspected worker configuration has no `small_model`, title-agent model, or
provider `whitelist`. Its `provider.opencode.models` contains the authorized
free catalog and its `options.apiKey` contains a broker capability token.

Upstream version `1.18.32` explains the mismatch:

- `packages/opencode/src/session/prompt.ts`, `SessionPrompt.ensureTitle`,
  chooses a title-agent model first, then a small model, then the conversation
  model if no small model is found. The fallback does not handle a selected
  small model failing its request.
- `packages/opencode/src/provider/provider.ts`, `Provider.getSmallModel`,
  prefers the `gpt-nano` family for an `opencode` provider.
- Provider configuration extends the built-in model catalog; a `models` map
  does not act as an allowlist. Provider `whitelist` supplies that restriction.
- A configured API key causes the built-in OpenCode loader to retain paid
  catalog entries. It cannot infer the narrower scope of our broker token.

In the deployed checkout, `services/platform/src/sandbox-control-plane.mjs`
creates the broker profile without a model whitelist. Authorization in
`services/platform/src/model-broker.mjs` correctly rejects models outside the
capability and policy lists. A read-only call of that authorization function
with the inspected catalog accepts `big-pickle` and rejects `gpt-5.4-nano`
with `model_request_denied` / HTTP 403.

This is a runtime-selection/configuration mismatch. Preserve broker denial.

## 3. Alternatives and decision

| Approach | Tradeoff | Decision |
| --- | --- | --- |
| Set one global small model | Simple, but does not follow individual conversation selections | Reject |
| Automatically choose an authorized cheaper model | Can reduce cost, but still introduces implicit model switching | Defer |
| Follow the first accepted conversation model | Predictable selection and existing authorization apply | Adopt |

Directory restriction and title selection are separate requirements. Filtering
out Nano may incidentally restore today's fallback, but is not sufficient: a
future authorized small model must not change the agreed title policy.

## 4. Model selection and execution contract

Resolve the effective `providerID` and `modelID` for the first accepted user
message, including a per-conversation selection or the resolved default. Capture
that exact pair for automatic title generation. A rejected prompt does not
establish the title model. Merely opening a draft does not trigger generation.

Do not overwrite global `small_model` or global title-agent configuration on
each send. Two conversations running concurrently must use their own captured
models, and a later default-model change must not affect an in-flight title.
A later model change in the conversation does not automatically retitle it.

Keep OpenCode's title prompt and concise output handling where practical.
Generate a title as a separate request without tools, without adding synthetic
chat messages, and without changing native conversation context. Do not grant
additional permissions, select another provider, or expand model authorization.
Normal conversation work must proceed independently of title success.

The inspected plugin interface exposes `experimental.provider.small_model`
with only provider context, and parameter/header hooks after the language model
has been resolved. It does not expose a title lifecycle or an atomic title-write
hook that satisfies this complete contract. Do not mutate shared provider/model
objects or infer title requests by matching prompt text.

Implement a narrowly scoped, reproducible patch against the pinned runtime's
existing title and session persistence flow. Enable it only for managed Web
workers using the fixed runner environment value
`SCIKEEL_SESSION_TITLE_POLICY=conversation-v1`. Other runtime consumers retain
upstream behavior. Keep the patch, source revision, build inputs, and binary
checksum reviewable; existing upstream MIT attribution remains intact.

Use the existing session metadata column for a versioned internal title-job
record; no new table or bulk migration is required. Initialize this record when
creating eligible default-titled root sessions under the managed policy, and
capture the first real user message only after it is persisted. Do not initialize
old sessions, explicit names, forks, or child sessions opportunistically.
Apply automatic results with a transaction that checks the job identity and
manual-title revision. Record manual rename intent in the same transaction as
the rename, including requests that leave the visible string unchanged.

## 5. Authorized model directory

When producing each managed OpenCode provider profile, restrict the runtime's
visible models to the catalog authorized for that worker. Use the runtime's
explicit provider whitelist in addition to model definitions. Reuse the existing
catalog source; do not introduce another independently maintained model list.

Profile creation and refresh must keep model definitions, whitelist, defaults,
and broker capabilities consistent. Built-in model entries outside the managed
catalog must not be eligible for automatic selection. A selected model that is
revoked before title execution must fail safely without substitution.

The broker remains the authority at request time. Directory filtering improves
selection correctness; it does not replace authorization or weaken isolation.
Other auxiliary model-selection policies, including compaction, are outside
this change, although they must respect the same authorized directory.

## 6. Failure, retry, and manual titles

A title failure must not fail the conversation, create a conversation error
message, or replace its title with an error. Preserve the default title and
record a bounded diagnostic identifying the session, attempted model, and
failure category, excluding credentials and provider error payloads.

Each managed title attempt has a 30-second deadline and one provider dispatch;
disable the upstream title stream's internal transport retries for this policy.
An attempt that produces empty or unusable title text is a failure.

Allow at most one active title job per session and one automatic retry on the
next accepted user message after failure. The retry uses the captured first
message model and title context. Do not run an unbounded background retry loop.
A restart must not forget a consumed retry allowance or trigger duplicate jobs.
An attempt is consumed before dispatch. A stale running attempt is treated as
interrupted when that session next receives an accepted user message; it is not
resumed or automatically dispatched during startup. If the initial attempt was
interrupted, that next message may consume the one retry. An interrupted retry
has exhausted the allowance. Stop, deletion, and worker shutdown cancel active
title work; a removed session cannot receive a late title update.
If authorization has been revoked, preserve the default title without silently
switching models. Further automatic retries are outside this change.

A manual rename before or during generation wins. Apply a generated title only
if the session still has its system-owned default title and no manual rename
has occurred since the job started. Comparing only the visible title string
is insufficient: a manual rename to the same text also counts as manual.
Preserve existing behavior for forks, child sessions, and explicitly named
sessions; do not automatically retitle them.

Previously affected conversations are not scanned, bulk renamed, or modified
as part of deployment. Existing sessions without recoverable title-job state
remain unchanged. They can still be renamed manually. All session IDs,
transcripts, workspace files, and provenance must be preserved.

## 7. Acceptance criteria

1. A new conversation using authorized model A requests its title with exactly
   provider/model A and receives a non-default concise title.
2. Concurrent new conversations using different authorized models A and B keep
   their title requests isolated. Changing the global default while either job
   runs does not change its captured model.
3. Include an authorized Nano-family fixture: its presence must not override
   a conversation using model A. This proves the policy independently of today's
   free catalog.
4. Built-in unauthorized models are absent from the effective managed runtime
   directory after profile creation and refresh. Direct requests for such a
   model are still denied by the broker before upstream contact.
5. Title failure leaves conversation output usable. The next accepted message
   permits only the specified retry with the original model and context; no
   duplicate title jobs or extra retries occur across refresh/restart.
6. A manual rename before or during a job, including a rename to the same text,
   cannot be overwritten. Explicit names, forks, and child sessions retain their
   existing naming behavior.
7. Revocation between capture and execution causes safe title failure without
   fallback to another model. Diagnostics contain no secrets.
8. New title jobs do not add transcript messages or request tools. Existing
   conversations and original data are unchanged by deployment.
9. Live acceptance creates temporary OpenCode conversations with two currently
   authorized models and verifies their title request model identities and
   visible sidebar updates in desktop-width and phone-width gateway views.
   Claude is excluded; managed Codex title behavior is outside this scope.

Use deterministic local fixtures for failures, races, authorization, and retry
cases. Run builds and checks through guarded repository package scripts; a
failed build must leave the served Web bundle intact. Implementation and live
acceptance require a subsequent explicit execution request. No product code or production
configuration was changed while writing this spec.
