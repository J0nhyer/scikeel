# OpenCode Runtime Usage Policy

Date: 2026-10-05
Status: Proposed; awaiting written-spec approval before implementation planning.
Scope: The public multi-user gateway Web deployment.

## 1. Approved direction and intended behavior

The user requested that OpenCode, when used as the agent runtime, have no
SciKeel cumulative usage quota. Keep immediate resource protection and existing
model access restrictions. Codex and Claude remain disabled in this deployment.

A user can continue an OpenCode conversation, create another conversation, or
switch among authorized models without exhausting a SciKeel account allowance
for request count, output-token reservations, or transferred bytes. This applies
to all gateway users, including test1. Tool calls, primary agents, subagents,
title generation, summaries, and compaction using the managed OpenCode runtime
receive the same policy.

Unlimited cumulative use does not promise unlimited concurrency, unlimited
individual payloads, or acceptance by an upstream provider. Upstream limits and
errors remain effective.

## 2. Verified problem and implementation context

Production runs from `.worktrees/tenant-science-isolation`, rather than the root
checkout. The relevant implementation paths below are relative to that checkout.

- `services/platform/src/model-broker.mjs` indexes usage by SciKeel `userId`.
  Default thresholds are 100 requests, 262,144 reserved output tokens, 64 MiB
  cumulative request/response bytes, and four concurrent requests. Reservations
  use the requested maximum output tokens, including failed upstream attempts.
  Cumulative counters have no reset window or reconciliation with actual usage.
- The same broker already enforces a global operation limit of four, a 2 MiB
  request-body limit, a 16 MiB individual response limit, a 32,768 individual
  output-token ceiling, and a 120-second request timeout.
- `services/platform/src/sandbox-control-plane.mjs` issues a model capability in
  `brokerProfile`. Its current identity includes user, instance, generation,
  provider, authorized models/routes, and expiration; it does not identify the
  agent runtime. The provider and the runtime must not be treated as synonyms.
- Native jobs run inside the assigned runner. The currently disabled native
  path must be checked for shared OpenCode credentials before any future native
  runtime is enabled; a request-supplied runtime label is not proof of identity.
- test1 has three stored `model_account_budget` failures: two GPT-model messages
  from October 3 and an OpenCode `mimo-v2.6-flash-free` message from October 4.
  They identify the local broker, not a provider billing-account lookup. The
  error does not record which threshold was reached.
- Current test1 configuration enables only the OpenCode provider. October 5
  replies use `big-pickle` and `space-bunny-free`. Historical GPT messages are
  preserved; this change does not reopen their models.

These observations are evidence for the design, not proof of implementation.

## 3. Alternatives and decision

| Approach | Benefit | Limitation | Decision |
| --- | --- | --- | --- |
| Increase existing thresholds | Small configuration change | Continues to lock out sustained use; does not deliver unlimited cumulative use | Reject |
| Exempt the provider named `opencode` or free model names | Simple matching | Confuses model service with agent runtime; can apply the wrong policy when routing changes | Reject |
| Assign usage policy through a server-owned runtime capability | Matches the requested behavior and preserves model authorization | Requires an explicit runtime identity at credential issuance | Select |

No billing subsystem, daily quota, user-facing quota settings, or quota reset
scheduler is needed for this change.

## 4. Trusted runtime and policy contract

Use a server-issued capability with an explicit `runtime` identity. The control
plane assigns `runtime: opencode` when issuing the managed OpenCode credential;
the broker records it immutably with the capability and derives the usage policy
from that trusted value. Credential renewal retains the same runtime. A client
cannot change the policy through a JSON body, header, session metadata, model
identifier, provider name, or query parameter.

Only an explicitly issued OpenCode capability receives unlimited cumulative use.
Absent runtime identity retains the existing bounded policy for compatibility.
Unsupported explicit runtime identities are rejected at issuance. Recognized
non-OpenCode capabilities retain the bounded cumulative policy; this spec does
not redesign their accounting or enable their runtimes.

The capability remains bound to user, instance, generation, expiration, approved
provider, models, and routes. Revocation and expiry remain effective. No new
public API can request an unlimited capability.

Before release, trace the runner credential handoff and prove that disabled
native runtime paths cannot reuse an OpenCode capability. Keep native runtimes
unavailable if this separation cannot be established. Any later native-runtime
activation requires credentials bound to that runtime; it cannot inherit an
OpenCode exemption from a shared worker profile.

## 5. Broker behavior

Separate cumulative usage decisions from active resource admission.

For a trusted OpenCode capability:

- Do not reject against cumulative request count, reserved output tokens, or
  cumulative bytes. Do not increase those cumulative quota counters.
- Existing bounded-policy consumption for the same user must not prevent an
  OpenCode request. OpenCode requests must not consume another runtime's quota.
- Maintain per-account active-request tracking independently of cumulative
  counters, shared across capabilities and released on completion, upstream
  failure, timeout, client cancellation, revocation, and shutdown.
- Enforce existing global active-operation admission before buffering bodies or
  contacting an upstream service. No increase to current concurrency ceilings.
- Keep all individual body, response, output-token, timeout, authentication,
  model allowlist, route, and fixed-upstream restrictions.

For bounded or legacy capabilities, preserve cumulative request, reservation,
and byte accounting and their existing thresholds. A future quota redesign is
outside this change.

The per-response byte limiter must always run. For OpenCode it evaluates the
individual response only; for bounded capabilities it also enforces cumulative
account bytes. Streaming retains backpressure and cancellation. No lifetime
buffer or unbounded per-request history is introduced. Account tracking remains
bounded by the existing account-capacity ceiling.

## 6. Errors and gateway presentation

`model_account_budget` is reserved for cumulative quota rejection on bounded
capabilities. A trusted OpenCode request never receives that code from SciKeel.

Use `model_capacity` for temporary global or account concurrency saturation,
with HTTP 429 and a concise retry-later explanation. Keep existing request
retry bounds; this change does not introduce unlimited retries or a new queue.
Other single-request and authorization errors retain their current semantics.

If gateway error presentation needs adjustment, use localized text through the
existing i18n system. Make temporary capacity and upstream failures distinguishable
from a SciKeel cumulative account quota. Do not claim that changing models,
starting a session, buying credits, or resetting a supplier account fixes a
local capacity rejection.

Historical errors remain visible as historical errors. Do not rewrite stored
messages, clear conversation history, or create replacement sessions. After
new capabilities are issued, users can send another message in an existing
OpenCode conversation without deleting its earlier error.

## 7. Acceptance criteria

Use deterministic broker tests with local upstream fixtures. Run tests through
the repository package scripts and the host memory guard.

1. An OpenCode capability sends more than 100 sequential requests successfully
   through the fixture without `model_account_budget`.
2. OpenCode requests pass cumulative reservation and cumulative byte thresholds
   across successive requests; every individual request remains within its own
   limits. Use reduced fixture thresholds to keep test resource use bounded.
3. An exhausted bounded account can still make an authorized OpenCode request;
   OpenCode consumption does not advance bounded counters. A subsequent bounded
   request remains rejected, including after credential rotation.
4. Provider/model names alone do not confer exemption. Untrusted body/header
   claims cannot exempt a bounded request. Missing-runtime legacy capabilities
   stay bounded; unsupported explicit identities fail issuance.
5. Concurrent OpenCode traffic respects account and global admission ceilings.
   Capacity errors release slots and a later request succeeds without a restart.
6. Success, provider errors, cancellations, timeouts, revocation, and shutdown
   release active capacity. A deliberately slow body cannot occupy it forever.
7. Oversized bodies, responses, and individual token requests still fail through
   existing guards; disallowed models/routes, foreign identities, expired
   credentials, and arbitrary endpoints remain denied without upstream contact.
8. Credential renewal preserves runtime identity. The production credential
   handoff does not allow disabled native jobs to acquire the exemption.
9. Production acceptance uses OpenCode only: test1 continues an existing
   conversation and creates a new one with currently authorized OpenCode models.
   Verify desktop-width and phone-width gateway views if error UI changes.
   Codex/Claude are not probed or enabled for acceptance.

## 8. Rollout, preservation, and completion evidence

The implementation plan must target the deployed worktree and reconcile its
existing changes before edits. Build and test through guarded package scripts.
A failed build must leave the deployed Web bundle untouched. Keep model
allowlists and Codex/Claude switches unchanged.

Deploy the revised control plane and issue fresh capabilities through the
existing worker lifecycle. Coordinate a necessary service restart with active
turns; do not stop running research silently. Preserve users, workspace files,
conversation IDs, messages, and provenance. No data migration or quota-clearing
endpoint is required.

Record deterministic checks, active deployment revision, authorized model list,
and live OpenCode continuation results in `PROGRESS.md`. Do not claim a historical
failure has disappeared merely because restarting cleared in-memory counters.
Rollback restores the preceding broker behavior and configuration without
rewriting user data. The user-requested unlimited policy is complete only after
the production runtime identity, broker policy, resource protections, and live
conversation continuation are verified.
