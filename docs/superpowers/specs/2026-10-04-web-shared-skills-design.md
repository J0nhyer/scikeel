# Web Shared Platform Skills V1 Design

**Status:** Draft for user review. The user approved the shared-platform direction
on 2026-10-04 and requested a written spec before an implementation plan or code.
**Product scope:** The multi-user gateway Web client, including phone-width views.
**V2 direction:** Users manage their custom skills in their own file space.

## Goal

Provide platform skills like bundled packages: publish them once with the runtime
image and let every account load them from the same read-only in-sandbox directory.
A new account can discover and use them without creating a project or installing
anything. Account file-space changes must not relocate these platform resources.

A skill includes its whole directory: `SKILL.md`, scripts, templates, styles, and
other supporting files. Loading only the Markdown file does not meet this goal.

## Verified context

The read-only audit in this session found nine platform skills in each of the two
existing accounts. Their `SKILL.md` hashes matched the deployed image. No custom
skills were found in the audited profile, native-runtime, or workspace discovery
locations, and no `.openscience/project.json` project markers were found. This
snapshot does not authorize deleting unknown files found during a later migration.

The nine shipped skills are `computer-use`, `domain-check`, `large-file`,
`modal-run`, `publication-figures`, `remote-compute`, `research-workflow`,
`stats-integrity`, and `traceability-review`. OpenCode's own `customize-opencode`
entry is separate; the total runtime catalog need not contain exactly nine entries.

The deployed repair restored offline ripgrep and the private-directory permission
rules, but still uses per-account copies. V1 replaces that ownership/loading
mechanism while retaining the verified runtime dependencies and manual approvals.

Relevant existing code:

- `crates/osd-core/src/runtime.rs`: `deploy_bundled_skills` copies bundled packs
  into each account's private OpenCode profile on runtime startup.
- `runtime/sandbox/runner.mjs`: `TenantGateway.start` generates the managed
  configuration and currently allows that private skill directory.
- `crates/osd-sandbox-host/src/backend.rs`: the sandbox root is read-only;
  workspace, state, and home retain their account-specific writable mounts.
- `runtime/sandbox/image/Dockerfile` and `scripts/dev/stage-sandbox-image.mjs`:
  the image already includes offline ripgrep and the trusted `skills-core` pack.
- Six `runtime/skills/core/*/SKILL.md` files address helper scripts through
  `$XDG_CONFIG_HOME/opencode/skills/...`: `domain-check`, `large-file`,
  `modal-run`, `remote-compute`, `stats-integrity`, and `traceability-review`.
- `apps/desktop/src/app/routes/SkillsPage.tsx`: `sourceOf` recognizes the old
  profile path as bundled but currently labels other configured paths as user skills.

The pinned OpenCode version is 1.18.32. Its upstream skill discovery supports
`skills.paths`; its skill tool returns the loaded skill's base directory and
lists supporting files using ripgrep. Discovery also scans existing native and
profile locations, so leaving old copies discoverable can produce duplicate names.
Do not rely on discovery order to select a duplicate.

Upstream references:

- `anomalyco/opencode`, tag `v1.18.32`, `packages/opencode/src/skill/index.ts`
  (`discoverSkills`, `loadSkills`, and duplicate-name handling).
- The same tag, `packages/opencode/src/tool/skill.ts` (base directory and resources).
- Local version pin: `scripts/dev/fetch-opencode.sh`.

## Decision and alternatives

Use OpenCode's native `skills.paths` support to load the existing image pack.

| Approach | Benefit | Cost | Decision |
| --- | --- | --- | --- |
| Per-account copies | Retains current paths | Requires copying and synchronizing platform resources for each account | Replace in managed Web |
| Per-account symlinks | Avoids full file copies | Keeps account-specific aliases and permission paths; combining aliases with direct discovery can create duplicates | Do not introduce |
| Direct shared-path discovery | Uses the existing runtime mechanism and a single platform-owned path | Requires migration and correcting resource references | Selected |

No new skill registry, database, package installer, synchronization service, or
remote download mechanism is required for V1.

## Ownership and publication

The platform owns `/opt/scikeel/tools/resources/skills-core` inside the sandbox.
Each skill has a directory beneath it. Accounts use the same in-sandbox path and
the existing digest-addressed image resources; this is not another user's home
or a new shared writable volume.

The complete pack ships in the trusted runtime image. Updating platform skills
means publishing and validating a new image, then restarting affected runtimes.
The image digest identifies the bundled version. Existing image attestation and
rollback procedures remain the release mechanism.

Platform skills are outside user-managed file space. They must not be presented
as editable user files or offered as a new writable file-explorer root.

## Loading contract

The managed runtime generates this configuration from its fixed trusted image
layout:

```json
{
  "skills": {
    "paths": ["/opt/scikeel/tools/resources/skills-core"]
  }
}
```

The control plane does not accept arbitrary shared paths from a user, model, or
provider profile. Preserve the existing managed-profile validation boundary.

Managed Web startup skips copying platform skills into the private profile.
Existing desktop deployment behavior and disabled native-runtime adapters remain
compatible; they are not deliverables of this Web migration.

For each of the nine platform skill names, discovery must return exactly one
platform entry with a `location` beneath the shared pack. New accounts get this
catalog before creating a project. Keep the existing catalog APIs and page;
recognize the shared pack as `builtin` so its origin remains clear.

V1 adds no custom-skill management workflow. Existing extension code is retained,
and discovery precedence for future custom skills is not defined by this spec.

## Resource and execution contract

Instructions resolve scripts, templates, and styles relative to the base
directory returned when the skill is loaded. Replace the six hard-coded private
profile references and inspect the complete pack for equivalent assumptions.
Do not substitute a different absolute Web-only path into shared skill text.

Keep the complete directory contents and their relative layout. Offline ripgrep
remains available from the image; skill loading must not depend on downloading it
into a new account's cache.

Reading a script is different from executing it. Existing command approvals
remain in force. Executed helpers use the existing scientific environment and
write generated artifacts or records only to the active workspace's intended
locations, never into the shared pack. No real remote run, dependency installation,
or external connection is needed to validate helper path resolution.

## Permission contract

The managed `external_directory` policy retains a catch-all denial followed by
allow rules for the shared pack root and its descendants. Rule order matters.
No permission is added for the surrounding tools tree, another account, arbitrary
state files, or the host filesystem. Retire the old platform-copy allow rules
when those copies have been migrated.

This path exception is not a read-only filesystem guarantee. The existing
read-only sandbox image enforces that users and agent commands cannot modify
platform resources, even after a command receives approval. No writable mount
may cover the shared pack.

Preserve `bash: ask`, `edit: ask`, and existing approvals for network operations
and dependency installation. Do not change workspace/account isolation or expose
shared resources through the user file-mutation APIs.

## Existing-account migration and rollback

Migration is part of V1 acceptance, not an optional follow-up:

1. Inventory each account's discoverable skill directories before promotion.
   Identify platform copies by their known pre-upgrade bundle and verify the
   complete directory contents, not only the Markdown file. The updated pack's
   new instructions alone cannot prove an old copy was platform-owned.
2. Back up verified platform copies outside all OpenCode discovery locations.
   Preserve their layout and enough identity information to restore them.
   Never delete or silently overwrite unknown or modified directories. If any
   conflict prevents proving a duplicate-free catalog, stop promotion, retain
   the prior runtime, and report the conflict for review.
3. Stop/restart the affected account runtime with the new image and managed
   configuration. Ensure startup does not recreate the old copies. Perform
   this under the existing bounded worker-restart procedure.
4. Preserve workspace files, projects, session IDs, conversation history, and
   other account state. Do not rewrite stored tool outputs or historical paths.
   Continuing an old conversation requires reloading the skill to obtain its
   current base directory. V1 does not guarantee that an old copied absolute
   path remains readable or executable.
5. Verify catalog, resources, approvals, and isolation before declaring success.
   Keep the previous image/configuration and copy backups until acceptance passes.
   On failure, restore the previous image and matching permission policy and
   skill-copy layout, then restart the affected runtime.

New accounts require no copy migration. A deployment interruption must leave
recoverable backups; rerunning migration must not create duplicate discoveries
or overwrite its only rollback copy.

## Acceptance criteria

Use package-script memory guards for builds, tests, typechecks, and lint. Keep
heavy jobs serialized on the small host. Validate with the active OpenCode
runtime; do not probe disabled Claude/Codex services.

| Area | Required evidence |
| --- | --- |
| New account | An empty account with no project discovers all nine platform skills from the shared path; no platform copies are created in its home/profile |
| Existing accounts | Both audited accounts migrate to the same shared path, expose one entry per platform name, and retain their workspace file hashes and session IDs |
| Entire pack | Every `SKILL.md` parses; every referenced shipped resource exists; all six helper references resolve from their loaded base directories |
| Actual use | A real OpenCode turn loads `publication-figures`, `large-file`, and `domain-check`, reads `openscience.mplstyle`, and runs a local helper against a disposable workspace fixture after normal command approval |
| Offline readiness | Discovery and resource enumeration work with an empty account cache and no ripgrep download |
| Protection | Attempted shared-resource edits and an approved shell write fail at the filesystem boundary; an ordinary state-file read and cross-account access remain denied |
| Conversation continuation | Continue a pre-migration conversation, reload a skill, and use the new resource path successfully without losing its history |
| Web presentation | Existing library shows the shared entries as platform/builtin, refreshes successfully at desktop and phone widths, and adds no user-management controls |
| Recovery | A controlled failure permits restoring the prior image/configuration/copies without changing workspace or conversation data |

Use disposable verification artifacts and remove only those created by the
verification. A passing catalog alone does not establish that scripts, resource
reads, permissions, or migration work.

## V2 boundary

The user-approved next version supports custom skills managed by each user in
that user's own file space. Platform skills remain shared and read-only.

V2 requires its own spec and approval before implementation. That spec will
settle the user-visible storage location, supported file operations, discovery
and refresh behavior, validation, name conflicts, and execution permissions.
This V1 spec does not assign a custom directory, assume an existing project,
create a custom-skill system, or define user/project override priority.
