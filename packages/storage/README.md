# Storage boundary — planned

SQLite migrations and repositories for accounts, projects, artifacts, timeline
revisions, edit proposals, drafts, jobs, schedules, approvals, memory and audit
events. Durable state lives in an application data directory outside source.

OAuth tokens live in the OS credential vault; the database stores references.
Memory retrieval requires account/project scope, provenance and a distinction
between AI suggestions and user-confirmed preferences. Support correction,
export, retention controls and deletion. Memory is context, never authority.

Job persistence needs transactional claims, leases/fencing, approval
consumption and restart recovery; an in-memory timer is insufficient.
