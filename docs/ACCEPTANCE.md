# Phase 9 — final acceptance

Phase 9 consolidates **live AI/YouTube and all-feature end-to-end testing for Phases
0–8**, after Phase 8 hardening, packaging and feature completion. Features through
Phase 8 are implemented within their defined preview scope; Phase 3's limited editor and
Phase 4's core implementation are complete. Deferred live acceptance is not missing
feature implementation. Additional CLI adapters are future extensions; the first
real OpenCode adapter is implemented.

Local regressions, builds, controlled-provider tests and rendered/native UI checks
continue during development as engineering evidence. They do not pass this final
gate or establish live provider acceptance. **No secrets were provided; no live
OAuth or AI inference tests were run.** All checkboxes below are pending Phase 9.

## Checklist matrix

For each row, record app/build, OS, tools/models, exact scope, observed result and
redacted evidence. Cover successful operation, denied/invalid input and recovery;
do not record credentials, grants, raw provider bodies or private speech in evidence.

| Done | Feature phase | Phase 9 scenarios / expected evidence |
| --- | --- | --- |
| [ ] | Project sequence extension | Three real sources plus a repeated A range; ordered append, edge trim, playhead split, gap/ripple delete, drag/button reorder, one-batch AI preview/accept/undo/redo, stale-proposal rejection, one MP4, unchanged hashes, restart, rename/info revision conflict, trash/restore, stopped jobs and invalidated grants. Test the selected provider/model connection in the installed Windows app. Include VFR/rotation/SAR/offset audio, native streamed save and TR/EN/theme/window/DPI checks. |
| [ ] | 0 — foundation | Standalone clean checkout, documented prerequisites, build/manifest, public docs/support matrix and dependency/license inventory agree with delivered features. |
| [ ] | 1 — workspace | Native startup; demo vs connected identity; account/project create/select/reopen; scoped memory CRUD, provenance, suggested/confirmed state, revision conflicts and isolation across accounts/projects. Restart preserves state. |
| [ ] | 2 — Google app setup | Real user-owned **Desktop app** client ID and optional secret saved via Accounts; readiness changes immediately and persists after restart. Local encrypted reserved vault record takes precedence over environment fallback. No credential readback, logs or browser storage. Active-session/configuration races fail safely. Existing account grants retain their original client configuration. |
| [ ] | 2 — real account lifecycle | Authorized test channel: connect, cancel, deny, wrong channel/subject, missing scopes, refresh, restart, reconnect, disconnect and Google revoke. Revoked/expired grants block use; verify exact account/destination and retained scoped projects/memory. |
| [ ] | 2 — catalog/inbox and publishing | Exercise owned catalog pagination/local-file linking and scoped review/inbox behavior. Import → immutable review → **explicit human-approved private test publication** → upload → processing → durable receipt/history. Verify exact destination/payload/hash; reject stale/replayed/expired approval and wrong-account access. Account connection or draft creation never authorizes upload. |
| [ ] | 2 — publication recovery | Cancellation persists dispatch revocation; interruption/ambiguous upload reconciles the existing session/video without blind re-initiation. Restart/offline/expired approval cannot authorize additional bytes. Distinguish processing from success and remote accepted effects from local cancellation. |
| [ ] | 3 — manual editing and media input | Authorized real MP4/MOV/WebM inputs; invalid containers/external references, size/Blob limits, unavailable tools/codecs, silent/offset-audio and rotated/anamorphic footage. Trim/split/remove, 1–32 kept ranges, gap-removing concat, shared A/V origin/padding, full-source proxy and source-time switching; crop/static caption/gain, CAS save/undo/redo branching/reopen, progress/cancel/re-export and unchanged source hash. No multi-track/timed-caption claim. |
| [ ] | 4 — CLI/provider selection and proposals | Actual supported OpenCode install/version discovery and CLI-owned login; real user-selected model inference; model listing is not entitlement. Test missing auth, unavailable/unauthorized model, unsafe config/version, malformed output and cancellation. Proposal → playable preview → human accept/reject → undo/reopen, with source/revision/scope fences and temporary CLI state cleanup. |
| [ ] | 4 — local speech | Real compatible whisper.cpp CLI/GGML model and FFmpeg extraction to 16 kHz mono 16-bit PCM; validate language, ordered timestamps/duration, missing audio/model/tool, invalid output and two-hour rejection without silent truncation. Verify source hashes before/after, persistence, progress, durable cancellation, lease expiry/restart/offline and explicit new run with no automatic retry/resume. |
| [ ] | 4 — transcript and memory consent | Speech stays local by default. Explicit `includeTranscript` checkbox adds only the bounded transcript context (≤16,000 text characters / 150 segments, language/duration/hash/`truncated` metadata). Memory has a separate opt-in. Check consent reset/stale scope, source-byte changes, and that no media/frame/audio bytes are sent. |
| [ ] | 4 — external MCP | Actual external stdio SDK client and UI-issued grant/command. Validate handshake/tools, account/project/destination/artifact isolation, bad/unknown arguments, scope injection, expiry/revoke/restart and bounded errors. `media_transcribe`/`transcript_status`/`transcript_cancel` return metadata with empty segments; cancel is confined to grant-tracked jobs. `transcript_read` is absent/forbidden without opt-in; with opt-in, actual-byte hash check, integer `offset`/`limit` pagination (max 100) and `nextOffset`. No unconsented speech, media download, approve or publish authority. |
| [ ] | 5 — AI clips | Real selected-model candidate ranking/rationale, local scene/silence/transcript timestamps and partial-speech flags; duration/count bounds, sampling disclosure, history/account isolation and model failure/cancel. Boundary/static crop/timed-caption correction and fit errors, sequential multi-export/partial failure/retry, playable A/V output and immutable hashes. Source/transcript/timeline stale conflicts, restart/lease cancellation and private draft → separate exact-payload human approval. No face-tracking/visual-model claim. |
| [ ] | 6 — scheduler | IANA one-off/daily/weekly times, DST gap/first overlap, queue, opt-in tray/default Quit, denied reminders/inbox fallback, timing/hash-bound human review, 24h expiry/10m dispatch, sleep/restart/offline/missed ask/skip/collapsed backlog, generation fences including MEDIA_READY reapproval, concurrent workers and receipt reconciliation. No silent catch-up. |
| [ ] | 7 — social/text | Authorized X/LinkedIn/TikTok apps/accounts; native OAuth/refresh lease, fresh identity/org roles, weighted X text, LinkedIn readback limits, TikTok fresh creator/privacy/interactions/disclosure/music consent for restored/scheduled reviews. Constraints, auth/quota/uncertain receipts, partial crosspost failure and actual-model text proposal/apply/reject/cancel with project-memory opt-in. |
| [ ] | 8 — memory data | Full scoped JSON export despite filters, Unicode/provenance/revisions, empty scope, account-switch cancellation and URL cleanup; scoped CAS deletion survives restart, retention/logical-delete limits and no credential/path leakage. |
| [ ] | 8 — native UX/accessibility | Actual transcription/setup/editor/AI/review views; TR/EN, dark/light themes, keyboard/focus/dialogs, loading/empty/error/retry/cancel states, resizing and native window controls. Verify process cleanup on normal close and native-owner termination; no orphan Node/FFmpeg/FFprobe/whisper/CLI processes. |
| [ ] | 8 — packaging and clean install | Intended OS/support matrix, clean-machine install/start/upgrade/uninstall and persisted-data migration, pinned runtime/MCP paths, external tool/model setup, fail-closed vault availability, dependency/codec/model licenses and complete bundled notices. Signing/updater claims only if delivered and verified. |

Phases 5–8 are implemented but not finally accepted. None are passed today. Phase 8 must
resolve promised feature work before Phase 9; any intentionally excluded capability
needs an explicit scope decision and accurate support documentation. Extend the
matrix for any new feature or adapter delivered before final acceptance.

## Completion and release boundary

- [ ] Run the matrix against the final Phase 0–8 build; resolve failures and record
  actual evidence (blocked/skipped is not passed).
- [ ] Review the complete user journey and support matrix; distinguish local checks,
  controlled-provider evidence and live results without false provider claims.
- [ ] Only after Phase 9 completion may release authorization be considered, and
  **only on a separate explicit user request**. Packaging or passing checks never
  auto-authorizes a commit, push, publication, deployment or release.
