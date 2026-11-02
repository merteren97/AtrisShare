# Local queue and schedules

Open **Queue & calendar** with an account and project selected. Create an immutable
YouTube or social review draft, then schedule it once, daily, or on selected weekdays.
Creating a schedule consumes the original draft; it does not approve it.

## Timing and approval

- Store the IANA zone and local start minute. New/rescheduled starts must be future
  real calendar dates. Nonexistent DST wall times are skipped for recurrence; a
  one-off nonexistent time is rejected. Overlaps use the **first** UTC instant once.
- Each due occurrence creates a **new immutable review**, binding occurrence ID,
  due time, review deadline, exact account/project/destination and artifact hashes
  into its digest. A recurring schedule never approves future occurrences.
- Review is available for **24 hours from due time**. Explicit human approval grants
  the publisher its normal **10-minute dispatch window**. Review shows the original
  due time and that actual dispatch follows approval now.
- More than one minute late counts as missed. **Ask** keeps the occurrence available
  within its review window; **skip** records it as skipped. Older occurrences expire.
  After long offline periods the original missed slot is recorded; intervening backlog
  is explicitly collapsed through `missedThrough`, and the next slot is future.
  No silent catch-up publication occurs.
- Pause/cancel/reschedule invalidates pending reviews. Resume uses a new generation
  and occurrence identity. Dispatched work keeps its existing publisher lease;
  stop further bytes in publication review. Media-ready reapproval rechecks schedule
  generation/deadline. Local cancellation cannot undo already accepted remote effects.

## Running, notifications and recovery

The API checks local SQL work every five seconds. `BEGIN IMMEDIATE`, unique
schedule/time/generation keys and transactional publisher claims fence competing
workers. No provider mutation or automatic approval occurs in a schedule tick.
Publishers retain per-account concurrency leases, revocation and receipts.

Processing receipts use 15-second to five-minute capped backoff and one attempted
claim per account per tick. Ambiguous outcomes require explicit reconciliation;
there is no automatic new post/upload initiation. A social media-processing result
may require a new human approval to create the actual post. Exactly-once provider
semantics are not claimed.

The app must stay running. **Settings → Desktop behavior** has opt-in close-to-tray;
default close still quits and stops owned processes. Tray Show opens the queue;
Quit exits. Sleep, full exit or denied/unavailable OS notifications cannot provide
always-on delivery. Restart/wake applies the durable missed policy; inbox is authoritative.
Generic reminders contain no content/account names/credentials and never approve.
Native submissions are deduplicated per occurrence/process, including webview reload;
restart may remind again about unanswered reviews. The global inbox selects the
pending item's exact context.

New social occurrences may bind a renewed connection revision only when provider,
subject, app key and destination still match. Issued reviews are never rewritten.
TikTok review fetches fresh creator data and requires new privacy/interaction/brand
selections and music/branded-content consent **for each occurrence**. Changes require
a new immutable draft. Provider provisioning/live acceptance remains [Phase 9](ACCEPTANCE.md).

## API

Runtime bearer/Host/Origin checks apply. MCP cannot approve or publish schedules.

- `GET /api/queue?accountId=…&projectId=…`: project schedules, agenda and drafts.
- `POST /api/schedules`: `{context,name,kind,draftId,rule}`; rule is `frequency`,
  `localStart`, `timeZone`, `weekdays` (0 Sunday–6 Saturday), `missedPolicy`.
- `PUT /api/schedules/:id`: `{context,expectedRevision,rule}`.
- `POST /api/schedules/:id/pause|resume|cancel`: `{context,expectedRevision}`.
- `POST /api/queue/:occurrenceId/skip`: `{context}`.
- `GET /api/queue/notifications`: paged pending reviews; follow `next` through
  `afterDueAt`/`afterId`. No approval capability is returned.

Active controls/actionable occurrences are independent of capped terminal history.
Local tests cover IANA/DST, restart, competing real worker threads, stale/replayed
approval, missed expiry and generation changes. These are engineering evidence,
not real-provider or physical sleep acceptance.
