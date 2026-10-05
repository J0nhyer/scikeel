# OpenCode Continuous Use Without Local Cumulative Limits

Date: 2026-10-05
Status: Proposed; awaiting written-spec approval before implementation planning.
Scope: The public multi-user gateway Web deployment using OpenCode.

## 1. Product requirement

SciKeel has no product concept of account credits, account allowances, or usage
quotas. Users must be able to continue using the OpenCode agent without a local
cumulative request, token, or data-transfer limit. This applies to every gateway
user, including test1, across conversations and authorized models.

Primary agents, subagents, title generation, summaries, and compaction use the
same managed model transport and must not exhaust a hidden lifetime allowance.
Keep immediate resource protection and model access authorization. Codex and
Claude remain disabled; this change does not define their future usage policy.
Upstream providers can still impose their own limits and return errors.

## 2. Verified defect

Production runs from `.worktrees/tenant-science-isolation`. The implementation
paths below are relative to that checkout.

`services/platform/src/model-broker.mjs` currently stores cumulative counters by
SciKeel `userId` and rejects requests at 100 requests, 262,144 reserved output
tokens, or 64 MiB cumulative request/response data. Output reservations count the
requested maximum, including failed attempts, with no reconciliation or reset
window. These are implementation restrictions, not an established product quota
system or an upstream account balance check.

The same condition also checks account concurrency and returns
`model_account_budget` for all four cases. test1 has three stored failures from
October 3–4, including an OpenCode `mimo-v2.6-flash-free` request. Current test1
configuration enables only OpenCode; its October 5 replies use `big-pickle` and
`space-bunny-free`. Historical GPT messages do not demonstrate current access.

The broker separately enforces global concurrency and individual request size,
response size, output-token, timeout, identity, route, and model restrictions.
Those protections do not represent cumulative account quotas.

## 3. Alternatives and decision

| Approach | Result | Decision |
| --- | --- | --- |
| Increase counters or reset them periodically | Continues to impose a product quota that was not requested | Reject |
| Add runtime-specific unlimited and bounded account policies | Adds a quota framework and credential complexity for disabled runtimes | Reject |
| Remove cumulative enforcement from the deployed model broker and retain instantaneous guards | Restores continuous OpenCode use with a small, verifiable change | Select |

Do not add quota settings, credits, reset schedules, quota migration, runtime
exemption credentials, or accounting for hypothetical future native runtimes.
Before any future Codex/Claude activation, define its requirements separately.

## 4. Model broker behavior

Remove the cumulative request-count, output-token reservation, and account byte
counters and their rejection conditions from the deployed broker. Do not replace
them with higher thresholds, daily limits, or a provider/model-name exception.
The current broker serves the authorized OpenCode deployment; no runtime quota
classification is required for this correction.

Retain these current default protections:

| Protection | Current default | Required behavior |
| --- | --- | --- |
| Global active operations | 4 | Reject temporary saturation before buffering an additional body |
| Per-account active requests | 4 | Track current work only and release capacity when it ends |
| Individual request body | 2 MiB | Reject oversized bodies |
| Individual response | 16 MiB | Bound streaming bytes regardless of cumulative history |
| Individual output maximum | 32,768 tokens | Keep validation and the existing 4,096 default when omitted |
| Request timeout | 120 seconds | Cancel work and release capacity |

Keep fixed upstream routing, credentials, allowlists, expiry, revocation, tenant
identity, and generation checks. Removing cumulative counters must not weaken
these controls or enable disabled models or runtimes.

Active account tracking must be bounded and must not accumulate lifetime history.
Release or remove idle tracking entries after requests finish, including provider
failure, cancellation, timeout, revocation, and shutdown. Preserve stream
backpressure and individual response-byte enforcement. Do not buffer complete
responses or introduce an unbounded request queue.

## 5. Errors and existing conversations

Local concurrency saturation returns `model_capacity` with HTTP 429, distinct
from a cumulative account quota. Retain bounded retries. If gateway presentation
needs changes, show a localized temporary-busy message and advise trying later;
do not suggest buying credits or resetting an account.

The revised local broker does not generate `model_account_budget`. An upstream
error can still be returned and must not be reclassified as a local account quota.
Keep other authorization, size, token, and timeout error semantics.

Preserve historical messages and their errors. Users continue existing OpenCode
conversations by sending another message; no deletion, replacement session,
account reset, or quota-clearing operation is required.

## 6. Acceptance criteria

Use local upstream fixtures and repository package scripts with host memory
limits for deterministic verification.

1. More than 100 sequential authorized requests succeed without local cumulative
   rejection. Total output maxima exceed 262,144 tokens without the broker
   enforcing a lifetime token cap.
2. Cumulative transferred data does not trigger account rejection. Verify this
   through bounded streaming fixtures or a test-controlled former threshold,
   keeping every individual request and response within its own limits.
3. Continued requests across sessions, models, and credential renewal succeed
   without a restart or account reset. No new runtime/policy claim is needed.
4. Global and account concurrency remain bounded; saturation returns a temporary
   capacity error, and a subsequent request succeeds after capacity is released.
5. Success, upstream errors, cancellations, timeouts, revocation, and shutdown
   release active tracking. Slow bodies remain bounded. Repeated users and
   requests do not create unbounded idle account state.
6. Individual body, response, and output limits still reject excessive requests.
   Foreign identities, expired/revoked credentials, unauthorized models/routes,
   and arbitrary upstream endpoints remain denied before upstream contact.
7. Production acceptance uses OpenCode only: test1 sends another message in an
   existing affected conversation and creates a new conversation using currently
   authorized models. Verify desktop-width and phone-width gateway views if error
   presentation changes. Do not probe or enable Codex or Claude.

## 7. Rollout and completion evidence

Target the deployed worktree and reconcile existing edits before implementation.
Run required checks through guarded package scripts. A failed build must leave
the deployed Web bundle untouched. Model allowlists and native-runtime switches
remain unchanged.

Coordinate any necessary service restart with active turns; do not silently
interrupt running research. Preserve user records, workspace files, conversation
IDs, messages, and provenance. No data migration or credential schema change is
required. Rollback restores the previous broker version without rewriting data.

Record deterministic verification, active deployment revision, allowed models,
and live OpenCode continuation in `PROGRESS.md`. A restart clearing old in-memory
counters does not prove the fix. Completion requires verifying removal of
cumulative enforcement and continued operation of resource protections.
