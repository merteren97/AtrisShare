# Standalone worker — planned; local task ownership implemented

This directory reserves the standalone queue/scheduling service. Current Studio
render and supervised YouTube tasks run in `services/local-api/src/studio.ts`, with
`packages/media-engine` and durable SQLite ownership/progress in `StudioStore`.
There is no standalone worker executable. Recurring local scheduling runs in
`local-api/src/scheduler.ts`; native tray is explicit opt-in. See [scheduling](../../docs/SCHEDULING.md).

## Implemented local task ownership

- Publications have immutable payload/artifact SHA-256 binding, explicit human
  review and single-use approval with a 10-minute dispatch window. Five-minute
  durable owner leases with heartbeats fence competing claims/checkpoints.
- Upload uses hash-verified snapshot bytes. The resumable session URL is encrypted
  in the vault; SQLite stores its reference, progress and provider video ID.
- Interrupted uploads become uncertain. Reconciliation queries the existing session
  or recorded video; missing/unrecorded sessions never trigger blind re-initiation.
  More bytes require the original unexpired, unrevoked approval. Processing success
  is distinct from an upload receipt; exactly-once remote effects are not guaranteed.
- Review cancellation prevents approval. Uploading/uncertain cancellation persists
  dispatch revocation and aborts local work; accepted remote effects cannot be
  promised undone. Processing/terminal cancellation is rejected, not a remote delete.
- Kept-range exports, full-source compatible proxies and AI proposal previews run
  through the media engine with render leases, progress and cancellation.
  Failed/interrupted renders require a new run; they do not resume automatically.
- AI proposal orchestration runs in `services/local-api/src/ai.ts` with an isolated
  one-shot OpenCode child. Local proposal/run history persists; cancellation requests
  are durable across runtime instances and heartbeat-fenced. Temporary CLI state and
  transcript are removed; CLI sessions are never resumed. Human acceptance alone
  applies a bound proposal to the shared manual timeline; AI cannot approve/publish.
- Local speech tasks run in `services/local-api/src/transcription.ts` using the
  external whisper.cpp/FFmpeg engine and SQLite `TranscriptStore`. Extraction is
  16 kHz mono 16-bit PCM with a two-hour limit; language/timestamps and actual source
  hashes before/after processing are validated. Durable cancel, a workspace-wide
  claim and five-minute heartbeat-renewed leases fence competing/stale runtimes.
  Expired running leases report `transcript_interrupted`; a new attempt is explicit,
  with no automatic retry/resume. Temporary WAV/JSON is cleaned after child close.
  Speech stays local unless `includeTranscript` is explicitly enabled; memory is a
  separate opt-in. MCP controls return metadata only, with speech readable only
  through consent-gated, hash-checked, paginated `transcript_read` (max 100 segments).
- External MCP stdio uses a separate UI-minted 30-minute scoped grant, not the
  desktop bearer. Expiry/revocation/restart blocks calls; the standalone MCP process
  is a client-owned transport, not a background queue or scheduler.
- Native close aborts/awaits local tasks. A Windows kill-on-close Job Object owns
  Node and its owned media/CLI descendants; no local background-work promise survives close.

Provider tests exercise actual services with controlled transports, not live Google.
Phase 3's limited scope and Phase 4 core features are implemented. Live AI/YouTube
and all-feature end-to-end acceptance for Phases 0–8 are deferred to final
[Phase 9](../../docs/ACCEPTANCE.md), after Phase 8 hardening, packaging and feature
completion. Local regressions, builds and rendered/native UI checks continue as
engineering evidence; deferred acceptance does not make implemented features missing.
No secrets were provided and no live OAuth/inference tests were run. Release
authorization requires Phase 9 completion and a separate explicit request.
See [YouTube](../../docs/YOUTUBE.md).

## Local queue and schedules

Queue orchestration is separate from connector calls/media processing. Phase 6
occurrences are implemented; consolidated live/end-to-end acceptance is Phase 9.

At a scheduled occurrence, create an approval request and notify the user.
Without approval the job waits, then expires according to explicit policy.
After approval, recheck account, payload, expiry and connectivity before sending.
The application must be running for local notifications/jobs; tray/background
behavior will be explicit. Missed occurrences are never silently backfilled.

Provider timeouts may mean publication succeeded. Reconcile before retrying;
do not claim exactly-once delivery when the provider offers no such guarantee.
