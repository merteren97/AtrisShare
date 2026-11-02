# Storage — local workspace and durable task state

Implemented: SQLite migrations/repositories for local and verified social accounts, projects,
selection, scoped memory and audit. Durable state defaults to an application
data directory outside source. Node 22's built-in SQLite avoids a native addon.

The internal Windows DPAPI vault port uses account references and encrypted
atomic file writes. Local workspaces have no OAuth tokens; other OS vaults report
unavailable with no plaintext fallback. Memory read/update/delete requires exact
account/project scope. Corrections retain provenance and use optimistic revisions;
mutation and content-free audit are transactional. Memory is context, never authority.

Migrations v2–v9 add connections, artifacts/timelines/publication and render leases,
AI/transcript/clips, timing-bound occurrences, social posts and remote-refresh leases.
Scoped memory JSON export is in the UI; [DATA](../../docs/DATA.md) defines logical deletion/retention.
See [local workspace](../../docs/LOCAL-WORKSPACE.md).
