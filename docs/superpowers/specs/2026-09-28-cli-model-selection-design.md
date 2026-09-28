# CLI and Model Selection Design

## Goal

Give every authenticated Web user one simple place to choose:

1. the CLI runtime: OpenCode, Claude Code, or Codex;
2. a model available under that runtime.

Users may select a runtime and model. Only administrators may configure the
Claude Code and Codex model lists or their defaults. Claude Code and Codex keep
using the installations, credentials, and configuration already present on the
cloud server.

## Scope

This first version deliberately does not add provider credential forms, model
discovery, billing, quotas, model aliases, per-role model policies, or a separate
database.

OpenCode keeps its existing provider catalog, model picker, and per-user worker.
This feature only adds an administrator-managed catalog for Claude Code and
Codex and connects it to the existing per-user runtime selection.

## User Experience

The Web **Models** settings page shows two controls to every user:

- **CLI**: OpenCode, Claude Code, or Codex;
- **Model**: models available for the selected CLI.

For OpenCode, the model control continues to use the existing OpenCode catalog
and selection behavior. For Claude Code and Codex, the model control shows only
the model identifiers enabled by an administrator.

An administrator sees one additional configuration section on the same page:

- a newline-separated list of enabled Claude Code model identifiers;
- the Claude Code default model;
- a newline-separated list of enabled Codex model identifiers;
- the Codex default model;
- one save action per CLI.

Ordinary users do not see these editing controls and cannot call the matching
administrator API.

Changing CLI restores that user's last selected model for the target CLI. If the
user has never selected one, the administrator's default is used. Runtime-specific
conversation histories remain separate as they are today.

## Stored Configuration

The existing private `runtime.json` becomes version 3. It remains the only
platform runtime store.

```json
{
  "version": 3,
  "defaultRuntime": "opencode",
  "userRuntimes": {
    "usr_example": "codex"
  },
  "userModels": {
    "usr_example": {
      "claude": "opus",
      "codex": "gpt-5.6-sol"
    }
  },
  "managedRuntimes": {
    "claude": {
      "models": ["opus"],
      "defaultModel": "opus"
    },
    "codex": {
      "models": ["gpt-5.6-sol"],
      "defaultModel": "gpt-5.6-sol"
    }
  }
}
```

Model identifiers are plain strings. Labels, aliases, prices, and provider
metadata are intentionally excluded.

Version 2 migrates without losing `userRuntimes`. Initial managed catalogs are
seeded from the server's current Claude Code and Codex default models. A missing
or unreadable default produces an empty catalog, making that CLI unavailable
until an administrator configures it.

## Platform API

`GET /api/runtime` remains available to every authenticated user and returns:

- the selected runtime;
- the selected model for Claude Code or Codex;
- all available runtimes;
- the administrator-enabled Claude Code and Codex model identifiers;
- the remembered model for each managed runtime.

`POST /api/runtime` accepts a runtime and, for Claude Code or Codex, an optional
model. The platform validates the model against the administrator-managed list.
The endpoint changes only the authenticated user's selection.

`GET /api/admin/runtime` remains administrator-only and returns the managed
catalogs, defaults, and CLI command metadata.

`POST /api/admin/runtime` becomes administrator-only configuration and accepts
one managed runtime, its enabled model identifiers, and its default model. The
default must be present in the enabled list. Empty lists are allowed and make
that CLI unavailable to users.

No API returns credentials, tokens, or the contents of the server CLI
configuration files.

## Runtime Execution

Claude Code and Codex sessions continue using private per-user runtime homes
copied from the administrator-managed server configuration.

Before each turn, the platform resolves the user's selected model for the
session runtime and passes it explicitly to the CLI:

- Claude Code: `--model <model>`;
- Codex: `--model <model>` before the `resume` subcommand when resuming.

Passing the model on every turn makes a user's new selection apply to existing
sessions as well as new sessions, matching the current OpenCode behavior where
the selected model is supplied per turn. An already running turn is not changed.

If an administrator removes a model that a user previously selected, the next
runtime description and turn fall back to the current default. If the runtime
has no enabled models, selecting or invoking it returns a clear configuration
error.

## Authorization and Validation

- Every authenticated user may select a runtime and an enabled model.
- Only `role: "admin"` may edit Claude Code or Codex catalogs and defaults.
- OpenCode provider configuration remains unchanged.
- Model identifiers are trimmed, deduplicated, non-empty, and length-bounded.
- Administrator updates never accept or write credential fields.
- Runtime switching remains blocked while that user's managed CLI turn is
  running.

## Error Handling

- Selecting a disabled CLI reports that no models are configured.
- Selecting a model outside the enabled list returns HTTP 400 and leaves the
  previous selection unchanged.
- Removing a selected model falls back to the new default without deleting
  conversations.
- A failed CLI invocation records the existing `CliRuntimeError` in the session.
- A failed administrator save leaves the previous catalog intact.

## Verification

Automated tests must prove:

1. version 2 configuration migrates to version 3 without losing per-user CLI
   selections;
2. two users can choose different CLIs and different models;
3. an ordinary user cannot edit managed model catalogs;
4. an administrator can change enabled models and defaults;
5. invalid or removed models fall back or fail exactly as specified;
6. Claude Code and Codex receive the selected model argument;
7. Codex model and workspace options remain before `resume`;
8. the Web Models page shows CLI and model selection to every user;
9. only an administrator sees managed model configuration controls;
10. OpenCode model selection and conversations continue to work unchanged.

Production verification must select a configured Codex model, complete two
turns in one resumed session, restore OpenCode, and complete one real OpenCode
turn through the public entry point.
