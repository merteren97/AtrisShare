# Desktop application boundary — planned

Phase 1 will introduce a React + TypeScript + Tauri 2 desktop shell, following
the local-first Atris application architecture. This directory is a reserved
boundary, not an executable application.

Planned surfaces: account/destination switcher, video workspace with timeline
and optional AI side panel, text composer, clip candidates, calendar/queue,
approval inbox, and account-scoped memory/settings.

The desktop is a client of the authenticated local API. It does not own OAuth
secrets, perform social publishing directly, or grant AI clients approval.
Native notifications open the relevant approval detail; notification delivery
alone is never approval. See [architecture](../../docs/ARCHITECTURE.md).
