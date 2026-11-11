# apps/web

The React + TypeScript + Vite Web interface for SciKeel.

## Layout

- `src/` — the React frontend.
  - `app/` — `routes/`, `layout/`, `providers/` (routing, shell layout, context providers).
  - `components/` — reusable UI: `sidebar/`, `topbar/`, `command-palette/`, `cards/`,
    `inspector/`, `thread/`, `code-viewer/`, `markdown-viewer/`.
  - `lib/` — runtime store, workspace clients, and browser helpers.

## State strategy

- UI state → Zustand (`lib/store.ts`).
- Server / runtime state → the gateway through `packages/sdk` (`OpenCodeClient`).
- Streaming agent events → the runtime store's shared event handler.

The frontend talks to the agent runtime only through `packages/sdk` and the
same-origin gateway. It has no Tauri/native bridge.

## Depends on

`packages/shared`, `packages/sdk`; at runtime, the platform gateway and the
headless `osd` worker.
