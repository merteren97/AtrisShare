# Storage — local workspace and durable task state

Implemented: SQLite migrations/repositories for local and verified social accounts, projects,
selection, scoped memory and audit. Durable state defaults to an application
data directory outside source. Node 22's built-in SQLite avoids a native addon.

The internal Windows DPAPI vault port uses account references and encrypted
atomic file writes. Local workspaces have no OAuth tokens; other OS vaults report
unavailable with no plaintext fallback. Memory read/update/delete requires exact
account/project scope. Corrections retain provenance and use optimistic revisions;
mutation and content-free audit are transactional. Memory is context, never authority.

The Windows startup probe performs Protect + Unprotect in one hidden PowerShell
process rather than paying two cold starts. Helpers use the absolute OS PowerShell
path, a bounded 15-second deadline and strict bounded Base64 output. Timeout kills
and awaits the helper; it cannot accept a late success. The real Windows DPAPI
round-trip remains a required test, including on hosted Windows runners.

Migrations v2–v9 add connections, artifacts/timelines/publication and render leases,
AI/transcript/clips, timing-bound occurrences, social posts and remote-refresh leases.
Scoped memory JSON export is in the UI; [DATA](../../docs/DATA.md) defines logical deletion/retention.
See [local workspace](../../docs/LOCAL-WORKSPACE.md).
