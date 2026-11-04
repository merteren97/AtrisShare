# Project sequences, connection tests and project lifecycle

The Studio now has one persistent main sequence per project. The source library is
separate: importing media never silently assembles it. Select library files in the
desired order, then **Append selected in order**. Reuse a source to place another
range anywhere in the sequence, including A → B → A and nonchronological ranges.

## Editing and playback

- Stable clip-instance IDs are independent of source-artifact IDs and SHA-256 hashes.
- Source in/out values are integer frames at the explicit output frame rate.
  Output positions are calculated from ordered clips and preceding gaps. Supported
  output clocks are 24/25/30/60 fps; variable-frame-rate footage is sampled to that
  clock. The default output is 1920×1080, 30 fps, stereo 48 kHz H.264/AAC MP4.
- Trim using numeric source times, range controls or timeline edges; split at the
  output playhead; drag/reorder with keyboard-accessible move buttons; duplicate,
  change gain/framing/caption, and undo/redo. Delete preserves an interior gap;
  ripple delete closes it. A trailing empty gap is explicitly unsupported.
- Every operation batch is validated and saved atomically with an expected revision.
  The latest 200 groups are undoable. An edit after undo discards the redo branch.
  A revision conflict never overwrites a newer sequence. Property drafts are saved
  locally per clip; switching sources/projects does not silently discard them.
- **Source** plays unedited source/proxy media. **Sequence** plays a generated,
  revision-bound preview. Prepare a new preview after changes: stale footage is
  labelled, never presented as the current edit. This is rendered-preview playback,
  not a real-time multilayer compositor. The timeline stays available with AI open.
- Space plays/pauses, S splits, Delete ripple-deletes and Ctrl/Cmd+Z undoes
  (Shift adds redo). Text fields and interactive controls retain their own shortcuts.

Preview and export use the same FFmpeg compiler. Sources are verified before and
after processing. Each source's video/audio share a cut-relative clock; missing
audio is padded with silence, sample rate/channel layout are normalized, source
rotation/SAR are respected, and gaps become black/silence. Each output records its
sequence revision, snapshot digest and complete source-hash manifest. Editing while
rendering does not change that job's snapshot. Cancellation removes partial files
and cannot publish a late result as a successful artifact.

Bounds: 128 clip instances, two hours of output, even output dimensions up to 3840
per side, and the existing 2 GiB managed-file ceiling. Excessive input command length
is explicitly rejected; filter graphs/captions use files rather than shell strings.
Browser Blob playback remains limited to 256 MiB. Windows/native **Save file** uses
an OS destination picker and authenticated 64 KiB streaming to an atomic temporary
file, so exports need not fit in webview memory. Browsers supporting File System
Access also stream saves; other browsers retain the bounded Blob fallback.

## Legacy edits and migration

Schema v11 adds project lifecycle/revisions; v12 adds sequences and durable work.
Existing databases receive a consistent SQLite/WAL backup named
`atris-share.sqlite.before-v12.sqlite` before upgrade. Migrations are transactional;
old artifact timelines and their complete undo histories remain intact. They are
not implicitly merged. **Append selected source’s saved edit** converts its current
kept ranges, crop/gain/static and timed captions into independent placements.
Source edits and clip analysis remain accessible below the project sequence.
Selected reviewed clip candidates can also be appended in their selection order.

## AI and CLI

OpenCode **1.19.5** remains the supported, isolated CLI. Catalog availability is not
authentication or model entitlement. **Test connection** explicitly sends a tiny
real request to the selected model and may incur provider usage. Discovery,
configuration, catalog and inference diagnostics are distinct; errors expose only
allowlisted categories/stages, not raw stderr, credentials or provider bodies.
The last successful account/profile/model choice persists. A model removed from
the catalog remains visibly invalid; it is never silently replaced.

The official CLI auth store is used without reading/copying credentials. Parent
environment keys, custom providers and authentication plugins are not imported
into the deny-all profile. Such setups are not claimed as supported. Retry and
cancellation do not require restarting AtrisShare.

Sequence AI receives the sequence/source metadata, selected clip IDs, explicit
revision and instruction after disclosure consent. It receives no video, frames,
audio or local transcripts through this path and cannot visually identify events.
It returns the same validated operation batches as manual editing. A proposal can
be previewed, accepted or rejected; acceptance is one atomic undo group. Stale,
cancelled, invalid or wrong-scope proposals cannot replace current edits.

## Project lifecycle

Project cards and the active-project selector share the same accessible actions:
open, rename, edit information and move to trash. Name/description changes use
expected revisions. Trash preserves source/export files, sequence/history, notes
and remote receipts. It clears an active project context, stops pending work,
revokes dispatch and cancels future schedules. Deleted projects cannot start work.
Restore returns project data without restarting cancelled jobs or schedules.
There is no automatic permanent purge or remote publication rollback.

## API and MCP

All desktop routes require the existing bearer/host/origin checks and explicit
account/project context:

| Route | Purpose |
| --- | --- |
| `GET /api/sequence` | Persistent sequence snapshot |
| `POST /api/sequence/operations` | Atomic `{context, expectedRevision, operations}` batch |
| `POST /api/sequence/undo`, `/redo` | Revision-controlled history |
| `POST /api/sequence/legacy`, `/clips` | Explicit saved-edit/candidate append |
| `POST /api/sequence/render` | Snapshot-bound preview/export |
| `GET /api/sequence/jobs`, `/proposals` | Durable status/history |
| `POST /api/sequence/jobs/:id/cancel` | Durable render cancellation |
| `POST /api/sequence/proposals` | Consented selected-model proposal |
| `POST /api/sequence/proposals/:id/preview`, `/accept`, `/reject`, `/cancel` | Human review lifecycle |
| `GET /api/ai/connection`, `POST /api/ai/connection/tests` | Inference health and explicit test |
| `POST /api/ai/connection/tests/:id/cancel` | Awaited test cancellation |
| `PATCH /api/projects/:id`, `DELETE /api/projects/:id`, `POST /api/projects/:id/restore` | Scoped project lifecycle |
| `GET /api/projects?accountId=…&state=trashed` | Trash view |

The sequence AI panel issues revocable 30-minute MCP grants with an explicit source
allowlist. `sequence_sources`, `sequence_read`, `sequence_propose`, `sequence_preview`,
`sequence_render_status` and `sequence_render_cancel` use the same domain/service.
`sequence_export` is available only when separately enabled at grant creation and
exports the current applied revision, never implicitly accepts a proposal.
Transcript text is omitted. No accept/approve/publish/vault tool exists. Grants are
invalid after runtime restart or a trash/restore cycle, and destination changes are
revalidated. Desktop bearer credentials are never passed to external MCP clients.

Engineering tests use real SQLite, real FFmpeg media and controlled model/JSONL
responses. These do not establish real provider inference or installed-application
acceptance. The expanded [final acceptance matrix](ACCEPTANCE.md) remains authoritative.
