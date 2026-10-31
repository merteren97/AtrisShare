# Desktop workspace — implemented in Phase 1

React + TypeScript + Vite + Tauri 2 shell, following the local-first Atris
application architecture. Run `npm run dev` or `npm run tauri:dev` from the root.

Implemented: demo account/destination switcher, project creation/selection,
account/project-scoped memory CRUD/search/filter, audit and appearance/storage
settings, Turkish/English UI and dark/light themes. Video/AI/composer/queue and
approval surfaces are future phases.

The desktop is a client of the authenticated local API. It does not own OAuth
secrets, perform social publishing directly, or grant AI clients approval.
Rust owns the API lifetime and its memory-only session bootstrap. See
[local workspace](../../docs/LOCAL-WORKSPACE.md) and [architecture](../../docs/ARCHITECTURE.md).
