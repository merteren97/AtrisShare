# Local workspace — desktop, Studio and supervised YouTube

## What works

- React/Vite UI in browser development and a Tauri 2 native shell.
- Explicit demo target identities for YouTube, X, TikTok and LinkedIn. These are
  local records, not connected social accounts, OAuth sessions or publishable targets.
- Project creation/opening, persistent account/project selection, separate
  account-wide and project memory scopes.
- Memory creation, inspection, editing and deletion; categories, source/time,
  suggested/confirmed state, immutable provenance and optimistic revision checks.
- Search/category/state filters, current-scope audit, loading/error/retry states,
  Turkish/English UI and persistent dark/light appearance preferences.
- SQLite migration/repository layer and an internal Windows DPAPI credential port.
- YouTube OAuth/PKCE, channel/subject checks, vault storage, refresh and disconnect;
  see [setup and live-acceptance limitations](YOUTUBE.md).
- Account/project-scoped managed media, owned catalog pagination/linking, immutable
  publication review, resumable upload, processing receipts and reconciliation.
  These provider flows have controlled tests; live Google acceptance is pending.
- Partial single-clip editor: trim, centered original/vertical/square crop, caption,
  gain, revisioned save, undo/redo, reopen and progress/cancel export; retry starts
  a new export. Multi-track, split and proxies are not implemented.
- Custom Windows titlebar with drag/minimize/maximize/restore/close controls.

## Development commands

Use Node.js 22 LTS, npm 10+ and `npm ci`. The workspace pins Node **22.23.2** as a
development dependency, so npm scripts use the same executable that is staged for
the desktop. Node's built-in SQLite is experimental in this release; its database
files are ordinary SQLite files, but the application API may require adaptation
when upgrading Node.

```bash
npm run dev             # Vite + authenticated local API, 127.0.0.1:1438
npm run tauri:dev       # Native shell; Rust owns the API, Vite serves UI only
npm run check           # Type checks, storage/API/provider/media/Studio tests, build
npm run test:runtime    # Stage and exercise the isolated packaged Node/API
npm run preview         # Feature manifest only
```

Native development also requires the platform's Tauri 2 prerequisites. On Windows:
Rust stable, Microsoft C++ Build Tools and WebView2.

```bash
npm run tauri -w @atris-share/desktop -- build --debug --no-bundle
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

The first command builds a native debug executable using embedded frontend assets
and staged runtime resources. It does not create an installer. Native tests need
`npm ci` and `npm run build:core` first. The packaged runtime smoke test also checks
stdin ownership shutdown; the Rust tests check native-owned startup/auth/shutdown.

`npm run tauri:build` configures an unsigned NSIS build; installer/signing/updater
and clean-machine acceptance belong to later release hardening. The first runtime
staging downloads the exact Node release's full license text from its upstream
tag; subsequent staging can reuse that version's local copy. No Node installation
is required by the staged native executable.

Media inspection/export requires separately installed FFmpeg and FFprobe, selected
with `ATRIS_SHARE_FFMPEG` / `ATRIS_SHARE_FFPROBE` or found on `PATH`. Export uses
H.264 (`libx264`), AAC for audio and `drawtext` for captions. No media binary is
bundled; temporary GPL-enabled verification builds are not distribution artifacts.
Missing tools are reported as unavailable. Structurally valid imports can be stored
without FFprobe metadata, but editing needs a probed duration and available tools.

## Storage and vault

Default roots:

| OS | Data root |
| --- | --- |
| Windows | `%LOCALAPPDATA%\AtrisShare` |
| macOS | `~/Library/Application Support/AtrisShare` |
| Linux | `$XDG_DATA_HOME/AtrisShare` or `~/.local/share/AtrisShare` |

Set an absolute `ATRIS_SHARE_DATA_DIR` before launching to override it. For example:

```powershell
$env:ATRIS_SHARE_DATA_DIR = 'D:\AtrisShareData'
npm run tauri:dev
```

`.env.example` is documentation; the API does not automatically load `.env` files.
SQLite lives at `atris-share.sqlite` with WAL and foreign keys enabled. A single
migration owner uses `user_version`, rejects newer schemas and serializes first
initialization with `BEGIN IMMEDIATE`. Selection, projects, notes, audit, artifact
metadata, timelines, renders and publications survive restart. Managed bytes live
under `media/`; the v3 migration adds Studio tables while preserving earlier data.

Windows vault records use DPAPI **CurrentUser** encryption and atomic encrypted
file replacement under `vault/`. Credential references are random UUID generations, hashed
for filenames. Secrets cross the PowerShell helper through stdin, not argv, and
are never written as plaintext. Startup probes protect/unprotect before reporting
the vault available. A missing/failed/unsupported vault returns unavailable and
does not fall back to SQLite or browser storage. macOS/Linux vault backends are
not implemented. Demo workflows never write social credentials. YouTube account
credentials and resumable upload session URLs use the vault, while SQLite holds
references and safe metadata.

Workspace memory, SQLite and managed media are **not encrypted by DPAPI**; only vault
records are. The application data directory is private local user data and should
not be committed or distributed as sample content.

## Runtime lifetime and authentication

Browser development: the Vite plugin owns a loopback API on an ephemeral port. A
same-origin, host-checked bootstrap route requiring a custom request header returns
the session configuration. It has no cross-origin permission and no cache. The
frontend retains the token only in module memory, not local/session storage or URLs.

Native development and bundles: Rust owns the Node child, generates the random
32-byte session key, removes Node injection environment variables and obtains a
version/PID/loopback-address-checked readiness handshake. The only frontend IPC
returns this session configuration to the main local window. Native development
explicitly allowlists Vite's exact origin; bundles use only native Tauri origins.
Bundled debug and release apps resolve packaged resources, not checkout files.

All API operations require `Authorization: Bearer <session key>`. Host and origin
checks are additional boundaries; neither replaces authentication. API errors are
bounded codes, never raw request bodies, SQL errors or tokens. JSON inputs are
strictly validated with a 32 KiB limit; raw media import has a separate 2 GiB streaming
limit. CORS preflight and the single-use
YouTube OAuth callback/static result page are unauthenticated; see [the boundary](YOUTUBE.md#local-api).

Closing the native window requests authenticated shutdown, aborts/awaits Studio
work, waits, then kills/reaps the owned child if necessary. On Windows, Node starts
suspended, is assigned to a **kill-on-close Job Object**, then resumes; FFmpeg,
FFprobe and descendants stay in that job. Closing the job kills the process tree
even after Node exits or the native owner is terminated. Stdin EOF and a parent-PID
watchdog also terminate the API when its owner disappears. There is no independent
background/tray mode; closing stops local work. It cannot undo remote requests
already accepted; interrupted uploads require reconciliation and exports need a new run.

The session key represents the current local application session, **not a social
OAuth identity**. This is a single-OS-user workspace, not a remote multi-user server.

## Workspace API

Every request is authenticated. JSON mutation bodies reject unknown fields.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/workspace` | Accounts, selection, selected account's projects, safe vault status and data path |
| POST | `/api/accounts` | `{displayName, platform}` creates a demo target |
| PUT | `/api/context` | `{accountId, projectId}` validates and persists selection |
| GET | `/api/projects?accountId=…` | List only this account's projects |
| POST | `/api/projects` | `{accountId, name, description}` |
| GET | `/api/memory?accountId=…&projectId=…` | Scoped notes; **both keys required**, empty project ID means account-wide |
| POST | `/api/memory` | `{context, kind, text, reviewState}` |
| PATCH | `/api/memory/:id` | Same fields plus `expectedRevision` |
| DELETE | `/api/memory/:id` | `{context, expectedRevision}` |
| GET | `/api/audit?accountId=…&projectId=…` | Last 50 current-scope events |

`context` is always `{accountId: UUID, projectId: UUID | null}`; omission is not an
implicit scope. Repository methods verify project ownership before querying.
Read/update/delete predicates include account **and** project; compound foreign
keys back up the application checks. Changing the active UI account never retargets
a captured operation. Old frontend reads are aborted/epoch-fenced before display.

Memory updates retain their source/time, increase revision and reject stale
updates/deletes with `409 revision_conflict`. Each successful mutation and its
content-free audit event commit together. Recognizable secrets are masked in user
notes/diagnostics, but automatic masking cannot identify every arbitrary credential;
the memory is not a credential store. Memory content never grants permission.

## Studio API

All routes below require the same runtime bearer header and host/origin checks.
Studio `context` is `{accountId: UUID, projectId: UUID}`: a project is required.
Scoped GETs require both query keys `accountId` and `projectId`; ID paths alone do
not grant access. JSON mutations reject unknown fields. OAuth and account/catalog
routes are in [YouTube](YOUTUBE.md#local-api).

| Method | Route | Input / result |
| --- | --- | --- |
| GET | `/api/studio?accountId=…&projectId=…` | Artifacts, publications, latest 30 renders and tool availability; may reconcile processing records |
| POST | `/api/media/import?accountId=…&projectId=…&filename=…` | Raw bytes (`application/octet-stream`), up to 2 GiB; returns managed artifact (`201`) |
| GET | `/api/media/:id/content?accountId=…&projectId=…` | Authenticated media bytes, at most 256 MiB; larger files return `413 studio_blob_limit` |
| POST | `/api/media/:id/link` | `{context, videoId}`; verifies channel ownership before linking |
| GET | `/api/media/:id/timeline?accountId=…&projectId=…` | `{revision, cursor, edits}` |
| PUT | `/api/media/:id/timeline` | `{context, expectedRevision, edit}` |
| POST | `/api/media/:id/timeline/undo` or `/redo` | `{context, expectedRevision}` |
| POST | `/api/media/:id/render` | `{context, expectedRevision}`; new export job (`202`) |
| POST | `/api/renders/:id/cancel` | `{context}`; requests cancellation of a locally running export |
| POST | `/api/publications` | `{context, artifactId, title, description, visibility, madeForKids, notifySubscribers}`; immutable review draft (`201`) |
| POST | `/api/publications/:id/approve` | `{context, digest}`; consumes the reviewed digest once, starts 10-minute dispatch window (`202`) |
| POST | `/api/publications/:id/reconcile` | `{context}`; queries existing upload session/video; never blindly initiates another upload (`202`) |
| POST | `/api/publications/:id/cancel` | `{context}`; cancels review or persists dispatch revocation for uploading/uncertain work (`202`) |

`edit` is `{inSeconds, outSeconds, crop, gainDb, caption}`. Times are finite seconds
within source duration with end after start; crop is `original`, `vertical` or
`square`; gain is −60…24 dB and caption is at most 2,000 characters. Save/undo/redo
and export reject stale revisions with `409 revision_conflict`. Timelines retain
up to 200 edits. Export does not overwrite source bytes; retry creates a new job.
The player shows stored source/export content, not unsaved edit-field changes.

Import accepts self-contained MP4-family (`.mp4`/`.mov`) and WebM only. `.mkv`
requires WebM content, not full Matroska. Limits are distinct: 2 GiB managed
import/export storage versus 256 MiB Blob preview/download, with WebView-dependent
playback. Media content URLs contain context, never bearer credentials.

Publication `digest` is the server-produced canonical SHA-256 over the immutable
payload, including account/project/destination, artifact SHA-256/bytes/MIME and all
publication metadata. `visibility` is `private`, `unlisted` or `public`. Approval
is an explicit human decision, not draft creation or account connection. Session
URLs remain encrypted in the vault, never in frontend responses. Durable leases
and connection/expiry/revocation checks fence dispatch. Cancellation cannot promise
to reverse accepted remote effects; processing/terminal cancellation is currently
rejected. See [dispatch and reconciliation](YOUTUBE.md#review-dispatch-and-reconciliation).

## Verification scope

Source tests cover authentication/origin/input boundaries, scope isolation across
reads/writes/deletes, migration concurrency, restart persistence, revision conflicts,
redaction, vault round trips and isolated runtime shutdown. Windows native debug
build and actual WebView CRUD/reload/DPAPI status/close were exercised locally.
Rendered checks covered both themes/languages, keyboard dialog focus, filtering,
deletion/cancellation and resizing. macOS/Linux native and signed installer
acceptance remain outside this milestone.

Studio/media/publishing source tests cover real managed bytes, container rejection,
scope/revision isolation, approval replay/expiry, lease/restart recovery, dispatch
revocation, upload reconciliation and provider transport validation. Provider tests
are controlled, not live Google. Real FFmpeg/FFprobe fixtures use external tools
when available; a skipped fixture is not media acceptance. Live connection and
publication still need a user-owned OAuth app, authorized channel and human approval.
