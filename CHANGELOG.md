# Changelog

## Unreleased — YouTube connection slice

- Desktop OAuth with PKCE S256, one-use state, expected channel and Google subject verification.
- Encrypted account credentials, refresh/re-verification, local disconnect and optional Google grant revocation.
- Transactional v1 migration preserving projects/memory, copy-on-write credential generations and stale-writer fencing.
- TR/EN Accounts connection states, pending-session recovery, identity/scope inspection and disconnect confirmation.
- Controlled-provider regression coverage and setup documentation. Live authorized-channel acceptance is pending;
  local-media import, publication approval, upload/processing and receipts are not implemented yet.

## 0.1.0-preview.1 — Local workspace

- React/Vite/Tauri desktop with demo target and project selection/creation.
- Persistent SQLite accounts/projects/context and account/project-scoped memory CRUD.
- Source/time, suggested/confirmed knowledge, optimistic revisions and transactional audit.
- Authenticated ephemeral loopback API, strict runtime input validation and scoped repositories.
- Internal Windows DPAPI vault port with encrypted round-trip acceptance; no plaintext fallback.
- Turkish/English UI, dark/light themes, search/filters, error/retry and keyboard-safe dialogs.
- Pinned/bundled Node runtime, native startup/readiness/shutdown and isolated runtime smoke tests.

Real social connections, video processing, AI/MCP, publication approval,
notifications, scheduling and live publishing remain pending.

## 0.1.0-preview.0 — Foundation preview

- Standalone npm workspace and strict TypeScript build.
- Initial account, memory, publication/approval/job, media and AI tool contracts.
- Runnable preview manifest with explicit implementation status.
- Reserved desktop, runtime, connector, media, storage and service boundaries.
- English/Turkish README, public architecture, roadmap and platform notes.
- Apache-2.0 license, contributor guidance and Windows/Linux foundation CI.

This is a source scaffold, not a released desktop application. Live account
connection, editing, AI/MCP, notifications, scheduling and publishing are pending.
