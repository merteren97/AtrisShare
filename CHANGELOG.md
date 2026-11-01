# Changelog

## Unreleased — supervised YouTube and single-clip Studio

- Desktop OAuth with PKCE S256, one-use state, expected channel and Google subject verification.
- Encrypted account credentials, refresh/re-verification, local disconnect and optional Google grant revocation.
- Transactional v1 migration preserving projects/memory, copy-on-write credential generations and stale-writer fencing.
- TR/EN Accounts connection states, pending-session recovery, identity/scope inspection and disconnect confirmation.
- Immutable managed media with SHA-256, account/project isolation and up to 2 GiB streaming imports:
  self-contained MP4-family (`.mp4`/`.mov`) and WebM only; `.mkv` requires WebM content, not general Matroska.
- Authenticated Blob preview/download capped at 256 MiB; owned-channel catalog pagination and verified local-file linking.
- Immutable publication payload/digest, explicit single-use human approval with a 10-minute dispatch window,
  resumable upload, processing checks, durable receipts and reconciliation. Session URLs are encrypted in the vault;
  durable ownership leases fence competing workers. Ambiguous/missing sessions never trigger blind re-initiation.
- Persistent dispatch revocation on upload cancellation; remote effects already accepted cannot be promised undone.
- Manual single-clip trim, original/vertical/square crop, caption and audio gain; revisioned save, undo/redo,
  reopen and export progress/cancel. Retry creates a new export; multi-track, split and proxies remain unimplemented.
- External FFmpeg/FFprobe via `ATRIS_SHARE_FFMPEG` / `ATRIS_SHARE_FFPROBE` or `PATH`; no media binaries bundled.
  H.264/AAC export and caption `drawtext`; temporary GPL-enabled verification tools are not distribution artifacts.
- Custom Windows titlebar and kill-on-close Windows Job Object ownership of the runtime/media process tree.
- Controlled-provider regression coverage exercises actual services, not live Google. Phase 2 code is implemented;
  live connection/publication acceptance requires a user-owned OAuth app, authorized channel and human approval.
  Phase 3 is a partial single-clip slice. AI/MCP, notifications, scheduling and other connectors remain planned.

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
