# Changelog

## Unreleased — project sequences and connection diagnostics

- Persistent project-level multi-source sequences with repeated ranges, an explicit
  frame clock, atomic operation groups and durable 200-group undo/redo. Legacy
  artifact edits/history remain intact and can be explicitly appended.
- Visible timeline beside AI; ordered library selection, edge/numeric trim, split,
  reorder, duplicate, gap/ripple delete, clip settings and revision-labelled preview.
- Shared normalized FFmpeg preview/export, source-hash manifests, durable cancellation
  and native OS-picker streaming saves without buffering full exports in the webview.
- Sequence operation proposals through OpenCode and source-allowlisted MCP grants;
  human acceptance, stale revision rejection and single-group undo. No publication authority.
- Scoped project rename/information revisions, trash/restore, active-context recovery,
  cancelled background work/schedules and capabilities fenced across trash/restore.
- Explicit model connection tests, safe categorized diagnostics and persistent last
  successful model preferences. OpenCode 1.19.5 remains the tested version; catalog
  discovery is not inference/authentication evidence. See `docs/SEQUENCES.md`.

## Unreleased — local schedules, social adapters and preview hardening

- SQLite v7–v9 local schedules/occurrences, timing/hash-bound fresh reviews, one-off/
  daily/weekly IANA recurrence, DST/missed/24h-review policies, pause/resume/reschedule
  and CAS. Processing checks have capped backoff; ambiguous effects never blindly repost.
- Queue/agenda, optional native reminders and persisted opt-in close-to-tray, Show/
  Quit preserving owned runtime cleanup. Default close still exits.
- Official X/LinkedIn text/video and TikTok video adapters, native OAuth/app setup,
  fresh identity/roles, durable remote-refresh serialization, per-target variants and
  independent immutable human approvals/receipts. Exact X counting, LinkedIn literal
  text and fresh TikTok creator/privacy/disclosure/music consent at every review.
- Isolated actual-model AI text proposals with exact-project memory opt-in,
  cancellation and Apply/Reject. No AI approval/publication authority.
- Scoped memory JSON export, retention policy, fresh standalone runtime staging,
  strict SHA-256 inventories/full frontend/Rust/runtime notices and non-publishing
  Windows native/unsigned NSIS CI. Live providers/clean install remain Phase 9;
  release/signing/updater/deployment requires separate authorization.

### Earlier implementation

- Phase 5 clip discovery: bounded local FFmpeg scene/silence and timestamped speech
  evidence, optional source-edit overlap, deterministic scores and consented OpenCode
  candidate-ID ranking/rationales. SQLite v6 scoped provenance, durable leases/cancel,
  revision checks and source/transcript digests; no automatic retry or publication.
- Studio Clips TR/EN review, configurable 2–180s limits/up to 8 candidates, source
  context/partial-speech warnings, saved boundary/crop-position/timed-caption corrections,
  sequential exports with per-candidate recovery and private YouTube review drafts.
  Timed cues are literal, source-time, editable and fit-checked; no fabricated word
  alignment/face tracking/visual-model analysis. AI/MCP metadata paths omit speech cues.
  Shared render graphs use local script files for long cue lists on Windows.

- Desktop OAuth with PKCE S256, one-use state, expected channel and Google subject verification.
- Encrypted account credentials, refresh/re-verification, local disconnect and optional Google grant revocation.
- Transactional v1 migration preserving projects/memory, copy-on-write credential generations and stale-writer fencing.
- TR/EN Accounts connection states, pending-session recovery, identity/scope inspection and disconnect confirmation.
- In-app YouTube Desktop OAuth setup: client ID and optional public-client secret saved under a reserved
  encrypted DPAPI vault reference, immediate activation and restart persistence. Safe readiness/source only,
  no saved-value readback or browser storage; local configuration overrides environment fallback. Session/configuration
  races are fenced; existing connected-account grants retain their original client configuration for refresh/revoke.
- Immutable managed media with SHA-256, account/project isolation and up to 2 GiB streaming imports:
  self-contained MP4-family (`.mp4`/`.mov`) and WebM only; `.mkv` requires WebM content, not general Matroska.
- Authenticated Blob preview/download capped at 256 MiB; owned-channel catalog pagination and verified local-file linking.
- Immutable publication payload/digest, explicit single-use human approval with a 10-minute dispatch window,
  resumable upload, processing checks, durable receipts and reconciliation. Session URLs are encrypted in the vault;
  durable ownership leases fence competing workers. Ambiguous/missing sessions never trigger blind re-initiation.
- Persistent dispatch revocation on upload cancellation; remote effects already accepted cannot be promised undone.
- Phase 3 limited manual-editor scope complete: trim/split/remove, 1–32 chronological non-overlapping kept
  ranges within outer bounds, actual gap-removing concat with shared A/V origin and silence padding including
  audio offsets; original/vertical/square crop, static caption and gain. Revision/CAS save, undo/redo branching,
  reopen and export progress/cancel; retry creates a new export. No multi-track;
  timed clip captions are added by Phase 5 above.
- Source/hash-linked full-video H.264/AAC compatible proxies, at most 1280×720, preserving rotation/display
  aspect and source-time playback; source/proxy switching retains position. Proxies are not publication artifacts.
- Phase 4 core feature implementation complete: safe native OpenCode discovery, currently verified 1.19.5 only
  (other versions fail closed), actual CLI model IDs and user-selected one-shot generation. Model listing is
  not entitlement proof. CLI auth-store path is preserved; credentials are never read/copied by AtrisShare.
- Isolated temporary cwd/config/cache/database and transcript cleanup; effective config/agent permission
  verification denies file/tool/skill/MCP access in the child. Requests carry scoped metadata/current timeline
  plus separate optional confirmed-memory and transcript context, never media/frame/audio bytes. Speech stays local
  until an explicit `includeTranscript` prompt checkbox; transcript context is capped at 16,000 text characters /
  150 segments with timestamps, language, duration, source hash and `truncated` metadata.
- Local whisper.cpp CLI transcription via external `ATRIS_SHARE_WHISPER_CLI` / absolute `ATRIS_SHARE_WHISPER_MODEL`;
  FFmpeg extracts 16 kHz mono 16-bit PCM. Two-hour limit, language/timestamp validation, actual source hash checks
  before/after, sanitized scoped SQLite transcripts, progress, durable cancel and heartbeat/lease-fenced restart
  interruption; no automatic retry/resume. No speech tool/model bundling or automatic download.
- Persistent immutable, scope/source-hash/base-revision-bound proposals, preview and human accept/reject;
  accepted edits use the manual timeline and undo. Local proposal/run history persists. Cancellation is durable
  across runtimes; no CLI resume, AI approval or AI publishing.
- Official MCP SDK 1.32.2 stdio server with separate UI-minted 30-minute artifact/account/project/destination
  capability, expiry/revoke/restart invalidation and actual command/environment configuration. No desktop bearer
  is shared. Tools: metadata inspection, timeline/optional confirmed memory read, proposal, preview/status and
  review-only publication request. New `media_transcribe`, `transcript_status` and `transcript_cancel` return metadata
  with empty segments; `transcript_read` is advertised/allowed only with explicit opt-in, actual-source-byte hash
  verification and `offset`/`limit` pagination (max 100 segments). Unconsented grants receive no speech text.
  No approve or publish tool.
- Standalone `npm run build` then `npm run mcp:stdio` with UI-issued environment; staged `mcp.mjs`, pinned Node
  and full third-party license notices for packaged launch.
- External FFmpeg/FFprobe via `ATRIS_SHARE_FFMPEG` / `ATRIS_SHARE_FFPROBE` or `PATH`; no media binaries bundled.
  H.264/AAC export and caption `drawtext`; temporary GPL-enabled verification tools are not distribution artifacts.
- Custom Windows titlebar and kill-on-close Windows Job Object ownership of the runtime/media process tree.
- Controlled-provider regression coverage exercises actual services, not live Google. Phase 2 code is implemented;
  live connection/publication acceptance is deferred to Phase 9 and requires a user-owned OAuth app, authorized
  channel and human approval.
  Prior local native checks verified a real six-second source/full-source proxy, 0–2 + 4–6 → four-second export and
  unchanged source hash. OpenCode 1.19.5 returned nine routes in the native UI. An external official-SDK client
  exercised deterministic proposal/preview/human apply/manual undo; this was not LLM inference.
  This is local engineering evidence, not live provider or final all-feature acceptance. The first real OpenCode
  adapter is implemented; additional CLI adapters are future extensions, not incomplete Phase 0–4 obligations.
  Notifications, scheduling and other connectors remain planned; no UI phase badges.
- Updated delivery order: features through Phases 0–5 implemented within scope; Phase 3 limited editor complete,
  Phase 4 core implementation complete. Phase 8 covers hardening, packaging and feature completion before new
  final Phase 9 live AI/YouTube and all-feature end-to-end acceptance for Phases 0–8 (`docs/ACCEPTANCE.md`).
  Local regressions/builds/rendered/native UI checks continue; deferred acceptance is not missing implementation.
  No secrets were provided and no live OAuth/inference tests were run. Release authorization only after Phase 9
  and a separate explicit request; no automatic earlier release.

## 0.1.0-preview.1 — Local workspace

- React/Vite/Tauri desktop with demo target and project selection/creation.
- Persistent SQLite accounts/projects/context and account/project-scoped memory CRUD.
- Source/time, suggested/confirmed knowledge, optimistic revisions and transactional audit.
- Authenticated ephemeral loopback API, strict runtime input validation and scoped repositories.
- Internal Windows DPAPI vault port with encrypted round-trip acceptance; no plaintext fallback.
- Turkish/English UI, dark/light themes, search/filters, error/retry and keyboard-safe dialogs.
- Pinned/bundled Node runtime, native startup/readiness/shutdown and isolated runtime smoke tests.

At this release, real social connections, video processing, AI/MCP, publication
approval, notifications, scheduling and live publishing were pending.

## 0.1.0-preview.0 — Foundation preview

- Standalone npm workspace and strict TypeScript build.
- Initial account, memory, publication/approval/job, media and AI tool contracts.
- Runnable preview manifest with explicit implementation status.
- Reserved desktop, runtime, connector, media, storage and service boundaries.
- English/Turkish README, public architecture, roadmap and platform notes.
- Apache-2.0 license, contributor guidance and Windows/Linux foundation CI.

This release was a source scaffold, not a released desktop application. Live account
connection, editing, AI/MCP, notifications, scheduling and publishing were pending.
