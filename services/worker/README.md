# Durable worker boundary — planned

Run cancellable media/transcription/render tasks and durable publication jobs.
Keep queue orchestration separate from connector calls and media processing.

At a scheduled occurrence, create an approval request and notify the user.
Without approval the job waits, then expires according to explicit policy.
After approval, recheck account, payload, expiry and connectivity before sending.
The application must be running for local notifications/jobs; tray/background
behavior will be explicit. Missed occurrences are never silently backfilled.

Provider timeouts may mean publication succeeded. Reconcile before retrying;
do not claim exactly-once delivery when the provider offers no such guarantee.
