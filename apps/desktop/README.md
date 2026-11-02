# Desktop — video editing and publishing workspace

React + TypeScript + Vite + Tauri 2 shell, following the local-first Atris
application architecture. Run `npm run dev` or `npm run tauri:dev` from the root.

Implemented: direct Video editor navigation, local projects without social login,
non-destructive trim/split/crop/caption editing and exports, clip discovery, optional
AI proposals, composer/queue and human approval. Accounts centralizes official
YouTube/X/LinkedIn/TikTok setup and connections. Memory, audit, tool paths and desktop
preferences persist locally. Turkish/English UI and dark/light themes are available.
Windows GUI builds hide the console in debug and release; owned helpers are hidden too.
Provider configuration and actual authorization are required for live account operations.

The desktop is a client of the authenticated local API. It does not own OAuth
secrets, perform social publishing directly, or grant AI clients approval.
Rust owns the API lifetime and its memory-only session bootstrap. See
[local workspace](../../docs/LOCAL-WORKSPACE.md) and [architecture](../../docs/ARCHITECTURE.md).
