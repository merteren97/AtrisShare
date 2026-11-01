# Durable worker boundary — planned

This directory reserves the standalone queue/scheduling service. Current Studio
render and supervised YouTube tasks run in `services/local-api/src/studio.ts`, with
`packages/media-engine` and durable SQLite ownership/progress in `StudioStore`.
There is no standalone worker executable, recurring scheduler or tray service yet.

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
- Single-clip exports report progress and support cancellation. Failed/interrupted
  renders require a new export from a saved revision; they do not resume automatically.
- Native close aborts/awaits local tasks. A Windows kill-on-close Job Object owns
  Node and its media descendants; no local background-work promise survives close.

Provider tests exercise actual services with controlled transports, not live Google.
Live connection/publication acceptance still needs a user-owned OAuth app, authorized
channel and explicit human approval. See [YouTube](../../docs/YOUTUBE.md).

## Future queue and schedules

Keep queue orchestration separate from connector calls and media processing; add
transcription and scheduled occurrences after the supervised flow is accepted.

At a scheduled occurrence, create an approval request and notify the user.
Without approval the job waits, then expires according to explicit policy.
After approval, recheck account, payload, expiry and connectivity before sending.
The application must be running for local notifications/jobs; tray/background
behavior will be explicit. Missed occurrences are never silently backfilled.

Provider timeouts may mean publication succeeded. Reconcile before retrying;
do not claim exactly-once delivery when the provider offers no such guarantee.
