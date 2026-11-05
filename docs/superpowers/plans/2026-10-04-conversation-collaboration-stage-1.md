# Conversation Collaboration — Stage 1 Implementation Plan

**Design:** `docs/superpowers/specs/2026-10-04-conversation-collaboration-modes-design.md`

**Authorization:** The user approved the spec, local Stage 1 implementation,
and the additional sandbox runner/image integration on 2026-10-04. Production
activation and remote publication are separate from this local plan.

**Scope:** Authenticated multi-user Web, available OpenCode runtime, Collaborative
only. Guided and Delegated remain visible but disabled. Stage 4 full autonomy
belongs to Delegated. Keep existing tool approvals independent.

## Production audit and implementation choice

The running platform uses the tenant-science-isolation checkout and an immutable
sandbox image, not the legacy WorkerManager/history-plugin deployment assumed
in the first draft. The sandbox has a fixed environment and can reach only its
existing model, package, and egress brokers. A new platform port or environment
bridge would not work in the deployed network policy.

With the user's approved scope extension, use the authenticated model broker's
existing port for `/collaboration`. Bind calls to its existing account, instance,
generation, source-address, scoped-token, and expiry checks. The runtime can
register/read/guard a decision; only authenticated Web user actions can answer.
No new port or permission system is needed.

The measured `science-environment.mjs` factory installs the checkpoint tool and
pre-tool barrier. `collaboration.mjs` uses the pinned runtime's JSON-schema tool
support and has no npm runtime dependencies. Serialize each session's tool
preflights so a checkpoint registers before a concurrently submitted write.
Inherited scientific environment and shared-Skill behavior stay integrated.

## Worktree and change isolation

Implementation lives in `.worktrees/conversation-collaboration-stage-1` on
`feat/conversation-collaboration-stage-1`, based on production HEAD `b675ba2`.
The initial uncommitted production changes were copied for compatibility and
must remain distinguishable from this feature. The original production source,
service and deployed Web bundle are not modified by local implementation.
The initial tracked baseline patch is kept in `.deploy/baseline.patch` for
reviewable feature-only patch extraction. Do not commit unrelated inherited work.

All builds, typechecks, lint and tests use package scripts with the existing
cgroup limits and shared host lock. Build with `OSD_WEB_STAGE_ONLY=1`.

## Tasks and concrete acceptance

1. **Prove native suspension.** Run the pinned OpenCode against a deterministic
   local model response that requests both a checkpoint and a write. Before
   answering, no artifact and no write approval may exist. A recorded real
   answer allows continuation; the write still requires its manual permission.
   Test cancellation and broker failure separately.
2. **Persist the conversation preference and decisions.** Implement the
   account/session-owned store with atomic writes, revision/execution binding,
   immutable idempotent answers, one pending decision, and restart restoration
   to paused state. Idle legacy tasks migrate their mode once; active task
   snapshots keep their captured mode. Unsupported migrated modes require the
   user to select Collaborative before a new execution.
3. **Integrate authenticated Web and runtime paths.** Public
   `GET/POST /api/collaboration/:sessionId` exposes mode, answer, pause,
   heartbeat and release. Broker actions are capability, guard, state and
   checkpoint only. Ordinary async/sync prompts and research commands capture
   the policy; runtime-created descendants prove their owned parent and inherit
   its decision barrier and page lease. Existing explicit shell permissions
   remain separate. Runtime system transforms also carry the policy into
   command/reviewer work.
4. **Add the composer preference.** Reuse WebChoiceMenu; show the current
   Collaborative preference and readable disabled-mode reasons on desktop and
   phone. Use authenticated platform-Web gating to preserve the legacy desktop
   gateway path. SDK ordinary sends carry the saved revision and cannot silently
   continue when the collaboration service/runtime is unavailable.
5. **Add in-conversation decisions.** Show question and suggestion, explicit
   suggestion confirmation, custom answer and Pause. Composer answers resolve
   the specific pending decision instead of starting another model turn. Failed
   answers preserve typed input and expose Retry. Saved decisions remain visible.
   Refresh restores state without starting work. The last page leaving pauses
   and cancels descendants; other tabs keep their own leases. Multiple panes
   in one page reference-count the shared page lease.
6. **Verify and prepare activation.** Run bounded platform/frontend checks,
   lint/typecheck, a staged Web build and isolated browser acceptance at 1280px
   and 390px in English and Chinese. Add the new file to image measurement,
   archive validation and CI staging. CI runs native checkpoint acceptance inside
   the bounded, offline production image before attestation. Preserve old
   attested image compatibility. A fresh CI image and live production activation
   remain separate deliverables; local runtime evidence does not claim them.

## Implemented file groups

- Store/API: `services/platform/src/{collaboration,platform-server,model-broker,main}.mjs`
- Runtime: `runtime/sandbox/{collaboration,science-environment,runner}.mjs`
- Web: `apps/desktop/src/lib/{collaboration,runtime}.ts`, SessionView, Composer,
  WebChoiceMenu, CollaborationPicker, ResearchDecisionCard, seven session locales
- SDK: `packages/sdk/src/{OpenCodeClient,runtime}.ts`
- Scientific policy: `runtime/skills/core/research-workflow/SKILL.md`
- Image: sandbox-image workflow, manifest schema, prepare/stage/archive inspector
- Tests: collaboration store/hooks/native tests, broker/platform regression,
  frontend hooks/composer/runtime tests and Web browser acceptance

## Verification record

- Initial history-plugin baseline: 20 passed; research-task baseline: 15 passed.
- Native OpenCode 1.18.32: checkpoint plus simultaneous write stays blocked until
  a real answer; subsequent file write requires its existing manual approval.
- Platform suite: 272 passed, 3 existing conditional skips, zero failures.
- Focused frontend suite: 242 passed including platform-only gating, failed-answer recovery and cross-conversation response isolation.
- Final lint and staged build typecheck passed; the successful final Web artifact is recorded in `.deploy/attachments-build-path`, and the deployed bundle is unchanged.
- Final browser acceptance: all four desktop/phone and English/Chinese scenarios passed, including an unbroken 300-character filename; reload and decision answers start no extra model turn.
- Final focused platform run: 58 passed, zero failures/skips, including cold-start capability registration, multi-level descendant barriers, native checkpoint suspension, broker isolation and image measurement.
- Final UI/browser run: five tests passed across four files; screenshots and logs remain under `.deploy/verification` and `.deploy/collaboration-*.log`.
- Full frontend run: 1789 passed, 21 skipped, two failures. The feature mode-menu name assertion was corrected and the focused suite passed; the inherited, unchanged SkillsPage Web built-in-source classification failure remains recorded separately.
- A feature-only patch is extracted against the copied baseline for review. The tested worktree retains uncommitted prerequisite changes; no mixed commit or remote publication is made.

## Remaining scope boundaries

The runtime mechanically blocks **registered** checkpoints. Choosing which new
research plans or substantive method choices need a checkpoint is still a model
policy decision. Deterministic native acceptance proves suspension and manual
permissions, not universal model compliance or scientific quality. No live
Claude/Codex probes are part of this work. No background Delegated execution,
new task form, scheduler, agent registry, or automatic permissions are added.

Pending-decision replies in this stage are text decisions. Selected conversation
attachments are preserved and must be sent as an ordinary message after answering;
the UI explains this instead of silently clearing uploaded files. Existing
Plan preferences are excluded from the Collaborative execution path so an old
read-only Agent choice cannot prevent an approved plan from executing.


## Production integration and activation — 2026-10-05

- Continued under the user's instruction to advance this feature with Superpowers.
  Integrated the Stage 1 feature-only patch in
  `.worktrees/conversation-collaboration-release` against production HEAD `b00a74a`
  and its captured local baseline tree `ab5409b`. The production shared-skill
  paths, localized catalog, login preparation and model catalog changes were
  preserved. Resolved the runner merge by keeping shared skill discovery and
  adding the existing scoped broker token to the checkpoint plugin options.
- Added image regressions for checkpoint-module hash measurement, invalid hashes,
  compatibility with old manifests and runner restart preserving shared skills
  and manual permissions. The root archive inspector was updated with a backup
  before installing the new attested image.
- Current integrated checks: 281 platform passes, 3 conditional skips; 273 focused
  frontend passes; 17 image/runner regressions; lint, build/typecheck and four
  desktop/phone English/Chinese browser scenarios pass. The browser acceptance
  uses the already installed Chromium through its explicit executable setting.
- Published only the runtime/image source slice in commit
  `d1365b8415b8934f5be6042d821a435f40038cca`; CI `37226319359` passed real runner
  acceptance and an unanswered checkpoint in pinned OpenCode before attestation.
  Installed image
  `sha256:9a700fe51867a17b7330eb345aa2bb126bb46f89b1e0ed07b3a3cd573ae32c1e`.
- Activated the verified platform/frontend feature slice and image together in
  the existing production checkout. The Web entry is `/assets/index-CuzLJAqz.js`;
  direct and reverse-proxy entry/asset checks pass, and old hashed assets remain
  available. Source backups, the previous image and previous index are retained.
- Real `opencode/big-pickle` acceptance created one disposable conversation,
  registered a plan checkpoint, remained blocked without an answer, restored the
  pending record, saved the exact user answer and continued the same model turn
  to return the verified mean of 1, 2, 3. There was exactly one user message,
  one completed checkpoint and no additional tools. Cross-account decision
  access was rejected. Removed the verification conversation and revoked all
  three temporary acceptance logins.
- Post-release preservation confirms original workspace files, original session
  IDs and original message IDs are unchanged; Git snapshot metadata is unchanged
  as well. The platform is active. This completes Stage 1 only: Guided and
  Delegated remain visible but disabled until their separate implementations.
- Reproducible release artifacts live under the release worktree's
  `.deploy/collaboration-release/`: `activation.json`, `source-manifest.json`,
  `feature-only.patch`, `model-live-evidence.json`, `preservation-evidence.json`,
  the image, source backups and `rollback.py`. The integrated feature workspace
  stays available for review; unrelated inherited changes are not mixed into a
  feature commit.
