# Local API

Implemented loopback service for the desktop. Owns strict workspace input
validation, per-launch session authentication, account/project context,
repository access, safe vault status and content-free audit. It binds only to
127.0.0.1 on an ephemeral port; requests require the memory-only bearer token.

Publisher execution must resolve the exact destination, verify
current permissions and check a still-valid approval bound to the complete
immutable payload. A client-provided `AuthorizedPublication` object is not
proof of authorization; TypeScript interfaces are not a security boundary.

YouTube/social OAuth and publishers, transactional approvals, local schedules,
Studio/AI/transcription/clips and the scoped MCP gateway run here. See
[routes/lifecycle](../../docs/LOCAL-WORKSPACE.md), [social](../../docs/SOCIAL.md)
and [schedules](../../docs/SCHEDULING.md). Live acceptance remains Phase 9.
