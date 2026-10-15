# Web Assistant Runtime Compatibility and Conversation Continuity

Date: 2026-10-15 (Asia/Shanghai)
Status: On October 15, 2026 (Asia/Shanghai), the user authorized one implementation owner to execute the complete plan, perform necessary selected-Codex live acceptance, and publish after every required gate passes. The owner must not delegate further. Native feasibility precedes broad implementation; activation and publication remain conditional on verification.
Scope: The authenticated multi-user gateway Web client, including phone-width viewports. Preserve shared desktop compatibility without changing desktop approval defaults.

## 1. Product Contract

The administrator selects exactly one assistant for the whole deployment: OpenCode, Codex, or Claude Code. Ordinary users do not select assistants and must not encounter different permission or conversation workflows because the administrator changed the backend. They select from the active assistant's approved models.

The first intended activation is Codex, using the host's existing Codex provider configuration and credentials, with only `gpt-6.1-sol` exposed by the application. Do not alter the host's global model catalog or assume this provider alias establishes an official model identity.

Existing conversations remain visible after an administrator switch. Their public identity, transcript, workspace, attachments, and platform-owned research decisions remain intact. On the next authorized user send, a different assistant can continue through a bounded context handover into a fresh native session. Switching or reopening a page alone starts no execution.

This is product-level continuity, not lossless native-session migration. Model capabilities and results may differ. No native session ID, running tool, transient approval, or temporary credential is transferable between assistants.

## 2. Existing Decisions and Verified Gaps

Read-only investigation compared historical specifications and commits with the deployed source at `2026-10-14T13-10-17-696Z-cd4c7c5e` and the isolated recovery branch. Main-checkout changes are not evidence of deployed behavior.

The product already has `ManagedAgentsCard`, authenticated Admin runtime APIs, `CliProfileResolver`, model configuration, and `RuntimePicker` with per-user assistant selection. Reuse these existing entry points and stores. This work fills deployed Codex/runtime and safe service-profile integration gaps, then changes the existing per-user selection contract to administrator-only deployment-wide selection. It does not introduce switching/configuration from scratch or justify a duplicate settings surface or unrelated broad rewrite.

- The October 4 collaboration specification separates research decisions from tool authorization and requires durable decisions, session ownership, and scope boundaries.
- October 8 commits `71db062` and `e77b50c` establish automatic Web tool execution at the session execution boundary, while retaining outside-workspace denial and designated built-in Skill access. The startup profile still uses `ask`; inspecting it alone does not establish effective session permissions.
- October 11 commit `3f5c820` repairs OpenCode child-session authorization and adds automatic approval of owned sandbox Codex requests. Automatic approval is an intentional Web behavior, not a newly discovered permission defect to replace with manual prompts.
- OpenCode's automatic permission handler checks execution state, checkpoints, ancestry, current generation, and explicit child denies. Codex has a separate task-scoped approval path; it does not reuse that complete decision chain.
- Session permission patching, collaboration plugin integration, pending-permission recovery, and scoped network-tool authorization contain OpenCode-specific paths. Their existence is not proof of Codex compatibility.
- The current managed-runtime session lookup and listing filter by the selected assistant. Existing identity-change handover covers a changed profile within an assistant, not general cross-assistant continuity.
- The existing Admin API persists independent Claude/Codex flags, hardcodes OpenCode availability, and rejects disabling OpenCode. It does not yet provide the approved global exclusive-selection contract.
- The inspected production image advertises only OpenCode and contains no Codex tool. The sandbox profile resolver depends on an unpopulated `enabledRuntimes` configuration field and the default broker provider rather than the host Codex profile.

These are separate integration gaps. The observed upstream OpenCode free-tier HTTP 403 remains a separate provider investigation; no depleted-account balance or single causal explanation for all historical errors has been established.

Relevant local baselines are the tenant-isolation, collaboration-modes, tool-reliability, session-continuity, and project/file-management specifications. Later approved Web automatic-permission changes supersede their earlier manual-default descriptions only for Web tool execution, not their isolation and ownership requirements.

## 3. Approach

Three approaches were considered:

1. Enable native CLIs independently and expose their differences. This preserves adapter isolation but fails the shared user workflow and exclusive-selection requirements.
2. Convert or copy native sessions between runtimes. This couples private formats and cannot safely transfer approvals, tool state, or native identities.
3. Keep platform-owned conversations and policy, with runtime-specific bindings and context handover. This is the selected approach.

Reuse the existing platform, SDK, stores, broker, runner, and adapters. Do not introduce another agent framework, database, workflow scheduler, credential editor, or parallel Admin model-management feature. ACP's capability negotiation is a useful design reference; an ACP rewrite is not a prerequisite.

## 4. Exclusive Administrator Selection

One versioned, durable platform policy determines the active assistant and its allowed model catalog. Per-user preferences cannot override that policy. Readiness and the configured selection are separate facts: an outage must not silently activate another assistant.

Reuse `/api/admin/runtime` for management and `/api/runtime` for safe user metadata. The Admin control is single-selection rather than independent switches. Derive legacy availability fields from the authoritative selection instead of maintaining contradictory writable flags. Ordinary-user runtime-change requests cannot select a backend, even from a stale page or direct API client.

Activation is an explicit administrative operation:

1. Prepare and verify the target's immutable image capability, profile, allowed models, native protocol, and required compatibility checks. A bare successful provider HTTP request is insufficient.
2. Serialize final cutover with prompt admission and relevant in-flight mutations. Recheck the expected policy revision and reject with an actionable busy/conflict response if old executions or effects remain active or unverified. Do not kill user work implicitly.
3. Atomically persist the new selection/revision, fence old admissions, and revoke old inference authority before admitting target work. A crash during this boundary recovers fail-closed from durable state; it cannot admit both assistants.
4. Publish the new safe runtime/model metadata and invalidate stale browser selections. Requests carrying the old policy revision are rejected before execution; preserve their drafts and synchronize instead of silently resending.

Preparation failure leaves the previous committed selection intact. After a committed switch, provider failure is reported without automatic fallback. A lost administrative acknowledgement is reconciled against durable policy before another mutation. Switching back is another revisioned operation, not permission to restore stale tokens or native bindings.

Preserve existing user files, transcripts, models recorded on historical messages, and credentials during configuration migration. Legacy per-user runtime choices cease to authorize execution. Do not choose a different backend automatically merely because an independent legacy flag is true.

Exclusive selection governs user inference and agent execution. An existing helper process needed for workspace infrastructure may remain, but it must not admit prompts or inference for a disabled assistant.

## 5. Host Profile and Credential Boundary

The October 15 user approval adds a dedicated platform service `CODEX_HOME` under the existing private platform data directory. The personal `/home/ubuntu/.codex` is an initialization source only, never a shared runtime home for all users. A controlled, explicit synchronization imports allowlisted connection/authentication fields and necessary metadata for `gpt-6.1-sol` through structured TOML/JSON parsing. Respect absolute catalog source paths, but extract only allowed model metadata: never copy catalog instructions or the complete catalog. Missing allowed metadata makes activation unavailable rather than broadening the list. Later controlled synchronization must not silently overwrite independent service configuration or alter the personal source.

Keep three boundaries distinct: personal initialization source; server-only service configuration and upstream credential storage; and separate tenant-native state homes containing sanitized configuration plus scoped broker grants only. The trusted chain is controlled source import/synchronization, private service credential resolution, revision-bound broker routing, then tenant sanitized configuration. Validate directory/file ownership, restrictive modes, regular-file type, no-follow path traversal and coherent revisions; fail closed on symlinks, partial writes, unsafe ownership or permissions. Do not add a second provider editor: use the existing platform data and managed deployment configuration.

The trusted platform reads only the connection, authentication, model, and supported reasoning fields needed by its adapter. It must not implicitly import host MCP servers, plugins, trusted directories, approval defaults, arbitrary headers, or executable configuration. Unsupported authentication/configuration produces a safe explicit status, not a guessed credential conversion.

Real upstream credentials stay outside browser responses, tenant mounts, tenant environment variables, transcripts, provenance, logs, and release artifacts. The sandbox receives only broker credentials restricted to its current identity, generation, allowed models, and routes, with expiry and revocation. Model access does not grant public-network or administrative access.

Profile refresh pins a coherent configuration revision for a turn. Credential rotation invalidates incompatible bindings without erasing conversation history. Do not copy the administrator's entire `.codex` directory or launch a host CLI as a sandbox fallback. The Web managed path must never call the legacy `CliProfileResolver.copyForTurn`, copy raw `auth.json`/upstream keys into a tenant, or inherit host MCP servers, plugins, trusted directories or permissions. Preserve desktop legacy behavior separately and prove these Web exclusions with negative integration tests. Apply the same boundary to future Claude activation.

The inspected host upstream uses public HTTP. On October 15, 2026 (Asia/Shanghai), after disclosure that plaintext transport may expose upstream API credentials and research content, the user explicitly authorized this deployment to use the existing endpoint unchanged ("Of course, use it directly"). This resolves the transport-choice wait for selected-Codex live acceptance and publication, not any other safety gate. Keep this accepted risk in deployment evidence; server-side secret storage is not transport encryption. Do not silently change the endpoint, disable TLS checks, print credentials or claim HTTPS protection.

## 6. Stable Conversations and Runtime Bindings

The platform conversation is the durable user-facing identity. Extend existing history/session mechanisms with minimal versioned metadata; do not create a competing transcript or rewrite native databases.

Keep these responsibilities distinct:

- Conversation ownership and workspace identity, public message IDs/order, attachments, and normalized transcript.
- Platform execution, durable research decisions, confirmed scope, delivery evidence, and lifecycle state.
- Runtime binding: assistant, native session identity, relevant profile identity, and the canonical-history boundary represented by that binding.
- Turn admission: captured policy revision, selected model, request identity, execution state, and verified completion or uncertainty.

Historical messages retain their originating assistant/model metadata internally. Normalize legacy histories through owned runtime reads; preserve native records and keep imports idempotent with stable message identity. Runtime data may remain the historical source, but opening old history cannot depend on that runtime being enabled for inference or having working upstream credentials. No mutation is authorized by a path or native ID alone.

The SDK presents one conversation/history contract and normalizes adapter events into existing message, tool, question, status, and error shapes. The frontend does not call native runtime APIs or infer authority from raw tool text. User-facing menus contain model choices, not an assistant switch.

## 7. Lazy Context Handover

A new user send captures the active policy revision and obtains the existing conversation/execution admission. If its current binding is compatible and covers the latest relevant conversation history, the adapter may resume that native session. Otherwise:

1. Verify the authenticated owner, current worker generation, workspace lifecycle, and idle or confirmed-stopped state. Unverified cleanup remains blocked.
2. Read canonical completed history and platform-owned objective, constraints, confirmed decisions, unresolved research barriers, and validated workspace artifact references. Do not fabricate a result for an interrupted turn.
3. Build bounded context using the existing handover helper as a starting point. Its existing twelve-exchange/16,000-character text limits are ceilings, not a substitute for structured decision state; the target's smaller context limits win. Include an omission marker when history is shortened. Any later summarizer must be independently specified and must not start an unbounded background job.
4. Treat historical conversation and tool content as quoted data, not new system instructions. Exclude native RPC IDs, transient approvals, broker credentials, and platform secrets. Revalidate attachment/file references in the current workspace; unsupported model modalities fail clearly before submission without losing the draft.
5. Start a fresh target-native session and submit the current user message once with that context. Rebuild effective system policy and tool authorization from platform-owned state, not historical assistant claims.
6. Record the binding and its represented history boundary only with verified native identity and delivery state. Preserve historical content and current user input on failure. An ambiguous native acknowledgement remains unknown until reconciled; do not retry automatically where duplicate execution is possible.

If an administrator later switches back, an older native binding cannot resume merely because its ID still exists: intervening conversation turns must be represented, or another fresh handover is required. A profile identity change follows the same freshness rule. Repeated switches and page reloads must not duplicate imported messages or accepted prompts.

This does not promise identical answers, complete hidden reasoning, or lossless long-history transfer. If essential context cannot be represented safely, keep the transcript available and ask for the missing information rather than pretending continuation succeeded.

## 8. Shared Policy and Lifecycle

Preserve the approved Web behavior: routine tools operate automatically within the authorized workspace and objective. Do not add a new per-tool confirmation workflow, inherit the host's unrestricted settings, or change desktop manual-approval defaults.

Adapters must enforce the same platform policy before responding to native approvals. Validate the account, instance, generation, conversation/ancestry, turn/job, current execution, explicit denies, and applicable scope. Stop, pause, a required research decision, a changed execution, or a stale generation prevents new automatic authorization. Recheck authority after asynchronous work before issuing a reply.

An approval is not evidence that a command or edit executed successfully. Native sandbox restrictions, outer tenant isolation, and capability enforcement remain in place. Verify actual permitted writes and commands, not only a successful approval RPC; no implicit unsafe downgrade is allowed.

Keep platform research decisions separate from runtime questions and tool approvals:

- Confirmed decisions and unresolved platform checkpoints survive a backend switch with their revisions and scope. Handover cannot answer, waive, or clear them.
- Native pending approvals and questions belong to their original execution. After confirmed cancellation, they become expired; retain useful question text and draft answers, but never submit an old request ID into a new runtime.
- An automatic tool permission is not user agreement to a scientific method, a changed objective, or a wider workspace.
- Browser disconnect or close does not cancel an accepted execution. Explicit Stop targets the captured execution and descendants, revokes its capabilities, and preserves truthful partial results.
- Refresh, recovery, or handover cannot automatically replay a state-changing tool call. Unknown write effects require reconciliation or an explicit user decision.

Public network access continues through scoped operation grants with destination checks, budgets, cancellation, and revocation. A model-broker token or approval of a shell command is not a general egress grant. Adapters lacking this transport must not claim equivalent search/fetch capability.

## 9. Compatibility Contract

Compatibility is measured by user-visible workflows and security outcomes, not identical native method names. Reuse adapter-specific implementations only where they satisfy the same contract.

| Workflow | Required outcome for any enabled assistant |
| --- | --- |
| Conversation/history | Create, list, reopen, rename, and preserve owned history across restarts and administrator switches |
| Send and streaming | One accepted turn, ordered normalized output, truthful failure, cancellation, and uncertain-delivery handling |
| Questions | Existing interaction UI; owner-scoped answers, draft retention, duplicate protection, expiry, and refresh recovery |
| Tool authorization | Existing Web automatic policy, explicit denies, execution/checkpoint guards, and no cross-session approval reuse |
| Research flow | Shared mode/state authority, durable checkpoints, original-input protection, and real delivery verification |
| Tasks and Stop | Owned descendant scope, bounded cancellation, verified cleanup, and no surviving authorization after Stop |
| Workspace and attachments | Existing tenant/file lifecycle restrictions, validated references, and model-aware modality handling |
| Network tools | The same destination-scoped grants, no direct-egress bypass, and correct operation cancellation |
| Revert and edit-message | Preserve actual file/history semantics where exposed; never substitute transcript truncation for a successful revert |
| Browser recovery | Reopen without replaying work, accepting expired interactions, or manufacturing successful effects |
| Errors and observability | Safe distinction between admission, authorization, provider refusal, cancellation, and unavailable/unknown context |

Each adapter declares capabilities to the platform. An unavailable optional model capability is reflected honestly in the existing model UI. A missing required application workflow blocks activation; do not silently hide core functionality or expose controls that only return an unsupported-operation error.

Claude remains unavailable under current user instructions. Preserve its adapter and run deterministic contract tests, but do not probe Claude or claim live parity until the user confirms restoration and its live acceptance passes.

## 10. Verification and Release Gates

Implementation planning must map each contract above to its current owner, an adapter-specific change only where needed, and deterministic regression tests. The bounded delivery sequence is shared policy/session contracts, Codex profile and image support, workflow adapters and handover, then acceptance and publication. This sequence does not authorize partial public activation.

Required acceptance includes:

1. Unauthenticated, non-admin, cross-site, stale-policy, disabled-runtime, and unapproved-model mutations fail without granting execution. Concurrent switch/send admits only the committed assistant.
2. Enabling Codex genuinely runs inside the measured, CI-attested image using scoped broker credentials. The user model list contains only `gpt-6.1-sol`; host global configuration is unchanged.
3. Foreign accounts, session ancestry, workspace paths, recycled native IDs, stale generations, stopped tasks, pending decisions, and explicit denies cannot obtain tool or network authority.
4. Seed legacy OpenCode, Codex, and Claude histories and verify stable read access and handover in every directed runtime pair with deterministic adapters, including switching back after intervening turns and profile rotation.
5. Verify live native continuation for available, activation-eligible assistants. OpenCode's current upstream refusal leaves its live acceptance incomplete, not passed; Claude is excluded until restored. A successful HTTP model probe does not replace native workflow acceptance.
6. Test preparation failure, persistence failure, lost acknowledgement, process restart during cutover, partial native submission, cleanup failure, duplicate sends, and concurrent tabs without history loss, replay, or dual-runtime admission.
7. Preserve unresolved research decisions, expire native requests correctly, retain question/draft input, and prove a stopped or ambiguous write is not repeated during handover.
8. Exercise required workflows at 1280px, 390px, and 320px, including refresh during execution/questions, browser absence, Stop, attachments, and model metadata changes.
9. Scan captured responses, logs, provenance, browser output, and release artifacts for fixture credentials. Record the exact source, image, profile/catalog revision, frontend assets, and live-tested capabilities without storing secrets.
10. Use the existing guarded package scripts and serialized small-host resource limits. Publish only through the frozen release workflow. Verify that rollback preserves histories and workspace data written after a switch; never return to an incompatible storage reader or host-execution fallback.

Do not weaken a release gate to bypass an upstream outage. Gates must test the selected assistant rather than hardcode an unrelated provider, while retaining equivalent native-operation and safety evidence. A candidate lacking that evidence is not publishable.

## 11. Scope and Review Boundary

Included: repairing the existing Admin control, exclusive global admission, host-profile-backed Codex activation, platform-level conversation continuity, shared permission/workflow contracts, and adapter compatibility acceptance.

Excluded: user-facing assistant selection, simultaneous active assistants, hot migration of in-flight native execution, transfer of native approval authority, lossless hidden-state migration, a new model/provider editor, arbitrary host execution, an ACP/framework rewrite, desktop UX changes, and speculative fixes to the upstream OpenCode free service.

Self-review checked ownership, runtime versus platform identity, lazy handover, switch-back freshness, unknown side effects, durable decisions versus transient approvals, model/credential separation, browser recovery, and unavailable-provider gates. The original document was plan-only; the October 15 execution instruction supersedes that restriction and authorizes implementation, necessary selected-Codex live acceptance and publication after all gates. No additional agents are authorized. This authorization does not waive native capability, safety, CI provenance or compatible rollback requirements.

## 12. Primary Design References

These sources support the design patterns, not a claim that different native runtimes share portable sessions or identical capabilities:

- Microsoft Agent Framework session documentation: `https://learn.microsoft.com/en-us/agent-framework/agents/conversations/session` - local versus service session identity and restrictions on reusing sessions with different agents/providers.
- Vercel AI SDK message persistence: `https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-message-persistence` - application-facing message persistence and conversion before model execution.
- Claude Agent SDK session management: `https://platform.claude.com/docs/en/agent-sdk/sessions` - native-session continuation versus application-managed context for a fresh session.
- ACP session setup and tool calls: `https://agentclientprotocol.com/protocol/session-setup` and `https://agentclientprotocol.com/protocol/tool-calls` - negotiated capabilities and execution-scoped permission requests.
- LangGraph durable execution: `https://docs.langchain.com/oss/python/langgraph/durable-execution` - checkpoints, replay boundaries, and side-effect handling. Durable execution does not make an arbitrary tool operation exactly-once.

The existing project remains the implementation authority. Runtime versions, installed image contents, upstream availability, and exact protocol capabilities must be revalidated when implementation starts.
