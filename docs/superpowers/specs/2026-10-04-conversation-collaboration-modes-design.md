# Conversation Collaboration Modes Design

**Status:** Draft for user review, 2026-10-04. This deliverable is a specification;
implementation planning and product changes have not started.

## 1. Goal and scope

Let a user choose how much they participate in research decisions directly in the
conversation composer. The same conversation supports discussion, planning,
execution, verification, and delivery. The selected mode must change observable
Agent behavior and enforceable decision boundaries.

Target the authenticated multi-user gateway Web client, including phone-width
viewports. Preserve shared desktop build compatibility. Live acceptance targets
the available OpenCode runtime; Claude is excluded until the user confirms its
restoration. Other adapters retain compatibility and deterministic coverage.

This specification defines a shared foundation and four delivery stages. Stage 1
is the first implementation unit. Stages 2 through 4 describe subsequent behavior
and release gates; they are implemented separately after the preceding stage is
accepted. Do not produce one implementation plan spanning all four stages.

### Decisions established in the conversation

- Select the mode in the existing conversation input area.
- Offer Guided, Collaborative, and Delegated modes; default to Collaborative.
- Let the mode determine research decision participation, independently of tool
  permissions and model selection.
- Deliver Collaborative first, Guided second, and basic Delegated third.
- Add full autonomous execution as Stage 4 of Delegated, retaining three modes.
- In Stage 4, a sufficiently clear initial request and authorization allow the
  Agent to plan, choose methods, execute, repair, verify, and deliver continuously.
- Write and review this specification before implementation planning.

The interaction rules below replace the task-form and per-task mode interaction
in `2026-10-01-research-work-modes-design.md`. Preserve that document as historical
context. Its page-bound cancellation rule remains in force for active research
runs; this revision does not authorize background research.

## 2. Current implementation evidence

These observations describe the inspected working tree, not a new deployment or
proof that the requested interaction is implemented.

| Location | Observed behavior | Gap for this design |
| --- | --- | --- |
| `apps/desktop/src/components/session/SessionView.tsx` | Ordinary sends pass no research brief; the composer has runtime Plan/Build controls. | No conversation collaboration selector or mode-bearing ordinary send. |
| `apps/desktop/src/lib/runtime.ts` | Creates a research task only when `researchBrief` is supplied. | Ordinary conversations do not establish the research mode contract. |
| `apps/desktop/src/components/thread/ResearchTaskPanel.tsx` | Contains a separate form, mode controls, report polling, and page heartbeats. | It is not mounted in the current session view; restoring its form would contradict the approved entry. |
| `services/platform/src/research-tasks.mjs` | Stores three modes, confirmed decisions, report versions, source hashes, and cancellation leases. | Modes depend on a created task. Pending decisions are discovered through report polling and cancellation, rather than a blocking checkpoint at issuance. |
| `services/platform/src/platform-server.mjs` | Injects mode-specific context when a research task exists and blocks continuation when pending decisions are known. | The ordinary conversation path needs the same collaboration policy. |
| `packages/sdk/src/OpenCodeClient.ts` | Sends ordinary prompts and supports pending questions and permission replies. | Collaboration metadata and durable checkpoint semantics need an explicit integration contract. |
| `apps/desktop/src/components/thread/InteractionPrompt.tsx` | Renders question and permission cards in the conversation. | Research confirmations need persistence, answer ownership, and pause semantics. |

Existing report checks verify file existence, hashes, and presence of evidence.
They do not independently prove scientific correctness. Polling after an Agent
writes a decision can stop future work, but does not prove that no action ran
between the report write and cancellation.

Reuse useful task records, artifact checks, question rendering, SDK calls, and
cancellation. Do not require users to enter filenames or complete a task form.

## 3. Industry patterns and selected approach

Official documentation reviewed on 2026-10-04 suggests useful mechanisms:

- Cursor exposes planning from chat and a reviewable plan before building.
- Claude Code separates planning from edits.
- Codex distinguishes approval policy from sandbox boundaries.
- OpenCode exposes switchable primary Agents and configurable permissions.
- ChatGPT Deep Research supports plan review, progress, and interruption.

These mechanisms inform this design; none establishes the same three research
participation levels proposed here.

Alternatives considered:

1. **Conversation modes with durable decisions and execution checkpoints — selected.**
   Fits the user's ordinary chat workflow and reuses existing research mechanisms.
   Requires shared mode persistence and a real checkpoint barrier.
2. **Restore the standalone research-task form.** Reuses more UI code, but adds an
   entry the user rejected and leaves ordinary sends outside the interaction.
3. **Use prompt-only modes.** Smallest change, but cannot reliably prevent work
   after an unanswered confirmation or restore decision state on reconnect.

Primary references:

- [Cursor Plan Mode](https://cursor.com/docs/agent/plan-mode)
- [Claude Code common workflows](https://code.claude.com/docs/en/common-workflows)
- [Codex security](https://developers.openai.com/codex/security/)
- [OpenCode Agents](https://opencode.ai/docs/agents/)
- [ChatGPT Deep Research](https://help.openai.com/en/articles/10500283-deep-research)

## 4. Mode behavior

| Behavior | Guided | Collaborative | Delegated, Stage 3 | Delegated, Stage 4 |
| --- | --- | --- | --- | --- |
| Primary user responsibility | Meaningful steps and method choices | Plan and substantive decisions | Objective, scope, and unanticipated substantive choices | Initial objective, constraints, and delegated decision authority |
| Start | Explain the next meaningful step and confirm its scope | Propose a short plan and obtain agreement | Execute an authorized scope; clarify missing essentials | Start when essentials and authority are clear; otherwise clarify before execution |
| Execution unit | One meaningful research step | Routine steps within the agreed plan | Routine work within the authorized scope | Planning through verification and delivery |
| Method choices | Explain consequential alternatives and request a choice | Choose routine details; confirm substantive choices | Follow confirmed methods or alternatives; confirm unanticipated substantive choices | Choose methods and justified alternatives within delegated authority |
| Progress | Step explanation, result, and next decision | Stage progress, significant decisions, and final result | Brief progress and blockers | Nonblocking progress and final delivery |
| Repair | Repair within the confirmed step | Repair within the agreed plan | Bounded repairs within scope | Bounded repairs and scientifically valid alternatives within scope |

A meaningful step is a research outcome, such as inspecting a dataset, choosing an
analysis method, running an analysis, or interpreting results. It is not every
file read, tool call, sentence, or internal reasoning operation.

Modes govern multi-step work. A concept explanation, direct question, or already
explicit single operation does not need a ceremonial plan. Clear user approval in
ordinary conversation counts; do not ask for the same approval again in a card.

Explicit user instructions constrain every mode. "Discuss only" permits no
execution. "Complete this data-inspection step" authorizes its routine operations
without repeated research questions. Requesting an explanation does not change
the mode. Mode selection alone starts no work and grants no operation permission.

### Substantive decisions

Consequential choices include the primary research question, hypothesis, main
analysis method, observation exclusion rules, and conclusions beyond the evidence.
Previously authorized choices need no repeated confirmation. In Stage 4, method
selection can be explicitly delegated for the stated objective; changing that
objective or crossing a stated constraint remains outside authority.

The Agent must preserve originals, distinguish assumptions from observations,
select relevant available Skills, and use evidence-backed checks in every mode.
Do not describe a self-check as independent review or completion as proof of
novelty, scientific correctness, or publication readiness.

## 5. Composer and conversation interaction

Place a mode trigger in the existing composer toolbar near the model controls:

```text
[Collaborative v]    [Model v]                            [Send]
```

Labels are Guided, Collaborative, and Delegated. Each menu option explains user
participation in one sentence. Use existing picker styling; at phone width use
the established bottom-sheet pattern, preserve the selected mode label, and keep
Send and Stop reachable. Avoid horizontal overflow at 320 px and verify at 390 px.
All visible copy uses the project's locale system.

Only modes accepted for the current release are selectable. Stage 1 exposes the
mode surface with Collaborative available; later modes may be shown disabled
with explicit availability copy, but must not appear functional. Stage 3
Delegated copy explains that unanticipated substantive choices still require
input. Stage 4 copy describes continuous execution after initial agreement.
There is no fourth mode or separate autonomy switch.

### Persistence and switching

- Store the selected mode per user-owned conversation, not as a global runtime
  permission or permanent student level.
- Preserve a draft's selection when its first send creates the conversation.
- Existing conversations without a mode read as Collaborative. Do not alter an
  already running execution during migration.
- Refreshing or reopening restores mode and pending decisions without starting
  work. Multiple tabs observe the same saved mode and revision.
- A mode change applies to the next execution. Disable switching while running
  and explain that the user can stop first. Waiting or paused runs may change
  mode, but unresolved decisions remain unresolved.
- Save failure keeps the previous effective mode and exposes retry. Conflicting
  stale revisions reload current state; they never silently overwrite a newer mode.
- Runtime Plan/Build and tool approval controls remain separate concepts. The Web
  composer presents one primary collaboration selector; when runtime controls
  are retained, place them in a clearly labelled secondary surface. Do not map
  Guided to a read-only runtime Agent, since Guided must execute confirmed steps.

### In-conversation confirmations

Use the existing conversation interaction area for:

- Plan agreement in Collaborative, when not already explicitly agreed.
- Next-step agreement in Guided.
- Substantive method or scope decisions required by the active mode.
- Missing information or authorization that prevents execution.

Show the issue, recommended action, and relevant consequence. Support continue,
provide an alternative, and pause. Ordinary user messages can answer a pending
question through the same decision contract; no special brief form is required.
If an answer is ambiguous, retain the barrier and request clarification.

A research decision and a tool approval must remain distinguishable. Rejecting,
dismissing, or timing out a research confirmation leaves execution blocked; it
must not inherit generic question-rejection behavior that permits continuation.
Nonblocking progress messages require no response.

## 6. Durable state and execution contract

Keep four responsibilities explicit and reuse existing storage where appropriate:

1. **Conversation preference:** mode and revision owned by the authenticated
   account and session. The gateway is the durable source of truth.
2. **Research execution:** objective, constraints, inputs, expected outcomes,
   mode snapshot, relevant Skills, execution version, progress, and run limits.
   Derive an execution from conversation when needed; simple chat needs no run.
3. **Research decision:** stable ID, question or proposed scope, execution and
   scope revision, pending/answered/withdrawn status, and user answer. Only an
   authenticated user response can establish user approval. Agent-written JSON
   remains a proposal.
4. **Permission policy:** existing workspace, command, network, dependency,
   deletion, and resource boundaries. A mode change cannot broaden them.

These are data responsibilities, not requirements to introduce four services or
another database. Extend existing session/task mechanisms where their ownership
and lifecycle match. Do not maintain two independent mode sources. Migrate old
research-task modes to the conversation preference; preserve the mode already
captured by any active run.

Every accepted execution captures the effective mode and decision revision.
Server-side policy injection must preserve the SDK's artifact-presentation and
attachment context. User text, retrieved content, or an Agent report cannot
silently replace the authoritative mode or recorded authorization.

### Execution flow

1. The user selects a mode and sends a normal message.
2. The gateway verifies conversation ownership and current saved revision.
3. The execution captures mode, authorized scope, and confirmed decisions.
4. The Agent discusses or executes according to that contract.
5. A required checkpoint is recorded and blocks subsequent execution until a
   valid answer is recorded. Otherwise authorized work continues.
6. Progress and real artifacts remain visible in the same conversation.
7. Final verification determines completed, failed, or blocked status.

Normal messages, starter prompts, resumed turns, command-driven Agent work, and
review/subagent continuations must honor the same scope and decision barriers.
An explicit user shell command retains its own operation authorization; it does
not count as approval of an unrelated research decision. Frontend code continues
to use `packages/sdk` for Agent calls.

### Blocking checkpoints

Register a required decision before releasing the next research stage or its
operations. Once pending, prevent new execution and affected Agent tool calls,
including child/reviewer work. Resolve the specific decision before resuming.
Report polling remains useful for progress and artifacts; it is not the decision
barrier. Implementations may reuse runtime question suspension or a tool guard,
but must verify the deployed runtime actually waits and guards continuation.

Replies bind to user, conversation, execution, decision ID, and revision. Duplicate
responses are idempotent; stale responses do not approve newer work. Restart,
reconnect, tab closure, and delayed events cannot resolve a decision or create a
second execution. Accepted decisions remain available to future context compaction.

The platform can enforce a registered checkpoint. Recognizing that a scientific
choice requires one remains model-dependent and needs scenario acceptance tests;
ordinary mode prompt tests do not prove this behavior.

## 7. Full autonomous execution in Stage 4

The user may provide the contract in ordinary language, for example:

> Analyze the temperature trend in this CSV. Choose appropriate methods, preserve
> the raw data, produce a figure and report, and verify the conclusions. Use only
> the workspace and the resources already authorized for this task.

If inputs, objective, outcome expectations, constraints, and authority are already
clear, start directly. Otherwise ask a concise batch of essential questions before
execution. A short scope summary with one confirmation is appropriate when
needed; do not require a form, output filenames, or redundant confirmation.

Within the initial contract, planning, routine method selection, execution,
verification, and valid repairs do not request further research approval. Record
chosen methods, assumptions, changes, and evidence for the final report. Broad
method authority never authorizes changing the research question, manipulating
results, or fabricating missing inputs.

The execution continues until delivery, user interruption, a genuine blocker, or
a verified limit. Preserve the existing cap of at most two repair attempts for a
failing operation. Persist and enforce a finite run deadline from platform policy
or a stricter user limit. Retrying or resuming cannot silently reset that budget.
Use existing resource boundaries; do not bypass the small-host build guards.

Preflight checks inputs, adapter checkpoint/cancellation capability, and any
operation authority known to be needed. Reuse existing approvals or obtain
specific task-scoped approvals at the start when the permission layer supports
that scope. Do not implement autonomy by turning permissions off or granting
unrestricted host access. If an operation still requires authorization mid-run,
stop at that boundary and report it; the UI must not promise uninterrupted
completion for that scope. A provider whose permissions cannot support the
approved operation scope cannot pass the full-autonomy release gate for it.

When blocked by missing essential data, exhausted repairs, an unavailable resource,
or a limit, preserve partial artifacts and deliver an explicit blocked/failed
outcome. Do not silently substitute data or wait with an unexplained spinner.
An out-of-scope proposal may be offered for a later user-approved continuation,
but is not executed as part of the current autonomous run.

Final delivery identifies actual outputs, checks and evidence, assumptions,
limitations, and uncompleted requirements. Passed checks require observed evidence;
file existence alone does not establish a valid research outcome.

## 8. Lifecycle, recovery, and failure behavior

Mode selection does not control whether work continues after the page closes.
Retain page-bound cancellation for active research runs across all modes. Reuse
heartbeat/release mechanisms through the ordinary conversation surface rather
than a hidden task panel. With multiple tabs, continue only while at least one
owning research view maintains a valid lease. Backgrounding an open phone page
may affect heartbeat delivery; verify the bounded stop behavior and show an
accurate stopped state on return.

User Stop pauses the current run and cancels associated execution and children.
It preserves completed files and does not roll back prior operations. A deliberate
later continuation uses saved context and a new execution version. Reload,
reconnect, restart, or restoring a mode never automatically resumes a stopped run.

Preserve pending decisions through refresh and server restart. Lost runtime
execution returns to a recoverable paused/failed state after reconciliation;
never mark it completed solely because a connection closed. Missing outputs,
changed original inputs, failed checks, and missing progress remain visible.

## 9. Delivery stages and acceptance gates

| Stage | Deliverable | Required evidence |
| --- | --- | --- |
| 1: Collaborative and foundation | Composer selector, per-conversation persistence, execution snapshots, durable plan/method checkpoints, ordinary-send integration. | A normal chat creates a reviewable plan, waits before affected execution, then completes routine work after approval; reload restores mode and decision. |
| 2: Guided | Meaningful-step boundaries, step explanations, next-step confirmation. | One approved research step completes, its result is explained, and the next stage remains blocked until approval. Internal routine operations do not trigger repeated confirmations. |
| 3: Basic Delegated | Continuous authorized work, checked outputs, bounded repair. | Clear authorized work finishes with real artifacts and evidence; an unanticipated substantive decision pauses rather than broadening authority. |
| 4: Full Delegated | Initial method delegation, autonomous planning/execution/repair/verification/delivery, scope preflight and limits. | A real multi-step task completes after initial agreement without internal research confirmations; blockers, limits, and authority failures produce accurate partial outcomes. |

Each stage receives its own reviewed implementation plan and acceptance result.
Unavailable capabilities stay unavailable in the selector. Existing historical
Codex acceptance is not evidence for the currently available OpenCode path.

### Shared acceptance scenarios

1. The mode selected in a draft survives conversation creation, reload, and return.
   Another conversation or account does not inherit or modify its state.
2. Save failure, two-tab revision conflict, and a stale execution request show the
   effective saved mode and cannot silently execute under a different one.
3. The same CSV-trend task exhibits each released mode's promised decision pattern.
   Evidence includes actual operations and unanswered-checkpoint tool blocking.
4. Explicit discussion-only instructions prevent execution in every mode. An
   already approved plan or step is not repeatedly reapproved.
5. A pending decision blocks new research work and affected continuations; answer
   messages remain accepted solely for decision processing. Answering through a
   card or ordinary message resolves only that decision. Reject, stale
   reply, duplicate reply, and mode switching do not accidentally resume work.
6. User Stop, graceful close, abrupt disconnect, and last-tab closure stop parent
   and child work within a measured bound. Reopening retains outputs and starts
   nothing automatically.
7. Uploads, previews, downloads, the existing research-idea starter, model selection,
   and artifact-presentation instructions continue to work in ordinary conversation.
8. Browser acceptance covers Chinese and English at 1280 px and 390 px; check
   overflow and reachable controls at 320 px. Shared desktop type checks pass.
9. Stage 4 demonstrates method selection and valid repair without internal research
   questions, plus genuine blocker and finite-budget termination scenarios.
10. Mode labels and the final result never claim independent review, scientific
    correctness, novelty, or successful artifacts without corresponding evidence.

Use package-script checks and bounded builds on this host. Validate deployment
separately; this document does not authorize product deployment or establish that
any acceptance scenario already passes.

## 10. Exclusions and review boundary

Background jobs after page closure, a fourth user-facing mode, automatic Skill
creation, broad project-library changes, school course content, multi-user live
editing, and unrelated runtime refactoring are outside this specification.

This document is the reviewable design deliverable. After user review, the next
Superpowers step is a Stage 1 implementation plan. No implementation or deployment
is part of the current request.
