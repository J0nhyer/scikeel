---
name: research-workflow
description: Coordinate a SciKeel student research task from a confirmed objective through a plan, scientific method choices, reproducible outputs and evidence-backed checks. Use when a SciKeel research task record and working mode are provided.
---

# Student Research Workflow

Protocol version: 1. Read the task record supplied with the current turn. Its
objective, input paths, expected outputs, mode and confirmed decisions are the
source of truth. Your suggestions are not confirmed user decisions.

## Managed conversation checkpoints

When `research_checkpoint` is available, use it for plan agreement and unapproved
substantive research decisions. It waits for the actual user's answer. Do not
replace this checkpoint with a question in a progress file or continue while it
is pending. An explicit approved plan in the conversation needs no repeated
confirmation. In Guided mode, explain the outcome of each confirmed step and
call `research_checkpoint` with kind `step` before starting the next meaningful
research outcome. Approval of the overall plan does not authorize all Guided
steps; explicit approval of this step needs no duplicate card. Routine tool
calls within the step do not require extra research confirmations. Deliver the
final requested result without an empty next-step card. Keep the versioned
report for real artifacts and checks.

In Basic Delegated conversations, execute the explicit scope and confirmed methods
continuously. Request a checkpoint for unanticipated substantive choices or missing
essential inputs. Before multi-step work that produces files, call
`research_delivery` with action `prepare`, original input paths, and promised
`deliverables`. Use its returned `execution` and `delivery.reportPath` for the
version-1 report below. This reuses conversation state; no task form is required.
Record real check evidence and then call action `verify`. A failed initial
candidate permits at most two repairs within the captured scope. After exhaustion,
explain partial outputs and the blocker; never label a failed candidate completed.
Delivery verification checks files, evidence presence and input hashes; it is not
an independent scientific review. Explicit single operations and discussion need
no delivery report.

## Establish the task

1. Inspect the named input materials inside the session workspace. If materials
   are missing, ask for them and write `waiting_input`; do not fabricate inputs.
2. Identify the deliverables and the checks needed to assess them. Choose a short
   plan appropriate to an undergraduate thesis or publication-oriented task.
   A publication goal is not proof of novelty or readiness for submission.
3. In collaborative mode, propose the plan and record a research decision before
   executing it. In guided mode, explain one meaningful step and request the
   method choices it needs. In delegated mode, execute the already confirmed
   scope; request decisions when a substantive choice was not authorized.

## Select scientific Skills

Read applicable Skills rather than silently inventing their methods. Record
which ones were used and why in the plan or check evidence. Useful shipped
Skills include:

- `domain-check`: units, physical constraints and discipline assumptions.
- `stats-integrity`: uncertainty, sample size, test assumptions and appropriate
  comparisons; never choose a method just to obtain a desired p-value.
- `publication-figures`: legible figures generated from the actual analysis.
- `traceability-review`: claims, citations and figure-to-code traceability.

Choose only what the actual task needs. Literature planning does not require
invented statistical checks. If a Skill is unavailable, report that limitation.
An independent reviewer may be available in the runtime; a self-check must never
be described as independent review.

## Execute and teach

Preserve original inputs. Keep source versions, assumptions, code and output
paths explicit. Explain why the chosen method addresses the objective. In guided
mode, finish the confirmed step, explain its outcome and record the next
meaningful decision. In collaborative mode, continue routine steps under the
confirmed plan. In delegated mode, continue to the requested deliverables and
checks, with at most two repairs for an execution failure.

Changing the main question, analysis method, observation exclusion rule, or
interpretation beyond the evidence requires a recorded student decision unless
that alternative is already explicitly confirmed. Tool approval is separate:
existing runtime restrictions always apply. This Skill cannot grant permissions.

Never fabricate data, citations, registry responses, execution outputs, or check
results. A missing tool, inaccessible source or failed check is an explicit
outcome. When missing inputs prevent execution, record the reason and a decision
request. Do not call a merely planned filename a produced artifact.

## Persist progress

Use the current `reportPath` and `execution` supplied by SciKeel (from
`research_delivery` preparation for ordinary Delegated conversations). After meaningful
steps, write JSON to a temporary adjacent file and rename it atomically. Never
overwrite a report belonging to another execution. Report shape:

```json
{
  "version": 1,
  "execution": 1,
  "status": "running",
  "steps": [{"title": "Inspect inputs and choose a method", "status": "completed"}],
  "decisions": [],
  "artifacts": [],
  "checks": [],
  "limitations": ""
}
```

Allowed report states are `running`, `waiting_input`, `completed`, and `failed`.
Step states are `pending`, `running`, `completed`, and `failed`. A decision is
`{"id":"stable-choice-id","question":"Concrete choice for the student"}`.
Keep its ID and question unchanged while awaiting confirmation. Read the user
answer from the next supplied task record. A confirmation authorizes only that
decision, not other unrelated choices.

Artifacts are relative paths to files actually produced. Include every requested
deliverable. A check is `{"title":"What was checked","status":"passed",
"evidence":"checks/verification.txt"}`. Its evidence must be an actual workspace
file recording inputs, method and observed output, not an assertion without a
check. Check states are `passed`, `failed`, and `pending`. Write limitations as
plain text. Preserve previous steps and confirmed-decision context when updating.

Before ending a turn, save the final report. Use `completed` only when the
requested outputs exist and every required check was executed and passed. Use
`failed` when a requested check or execution failed. Use `waiting_input` when a
student decision is needed, then stop execution and explain that decision in the
conversation. The platform verifies artifact existence and hashes; scientific
check conclusions remain Agent-reported and must be described that way.
