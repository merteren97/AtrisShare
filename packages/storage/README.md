# Storage — Phase 1

Implemented: SQLite migrations/repositories for demo accounts, projects,
selection, scoped memory and audit. Durable state defaults to an application
data directory outside source. Node 22's built-in SQLite avoids a native addon.

The internal Windows DPAPI vault port uses account references and encrypted
atomic file writes. Demo accounts have no OAuth tokens; other OS vaults report
unavailable with no plaintext fallback. Memory read/update/delete requires exact
account/project scope. Corrections retain provenance and use optimistic revisions;
mutation and content-free audit are transactional. Memory is context, never authority.

Future migrations will add artifacts/timelines/drafts/jobs/schedules/approvals.
Memory export/retention and queue claims/recovery are later milestones.
See [local workspace](../../docs/LOCAL-WORKSPACE.md).
