# Local workspace — desktop, Studio, AI/MCP and supervised YouTube

## What works

- React/Vite UI in browser development and a Tauri 2 native shell.
- Real local video workspaces (`platform: "local"`, `status: "local"`) without social login.
  Legacy demo records remain preserved, but the desktop and HTTP API cannot create new ones.
- Direct Video editor navigation, a full-width manual timeline and centralized Accounts
  connections for YouTube, X, TikTok and LinkedIn.
- Project creation/opening, persistent account/project selection, separate
  account-wide and project memory scopes.
- Memory creation, inspection, editing and deletion; categories, source/time,
  suggested/confirmed state, immutable provenance and optimistic revision checks.
- Search/category/state filters, current-scope audit, loading/error/retry states,
  Turkish/English UI and persistent dark/light appearance preferences.
- SQLite migration/repository layer and an internal Windows DPAPI credential port.
- In-app encrypted YouTube Desktop OAuth setup, OAuth/PKCE, channel/subject checks,
  vault storage, refresh and disconnect;
  see [setup and live-acceptance limitations](YOUTUBE.md).
- Account/project-scoped managed media, owned catalog pagination/linking, immutable
  publication review, resumable upload, processing receipts and reconciliation.
  These provider flows have controlled tests; live Google acceptance is deferred to Phase 9.
- Completed limited Phase 3 editor: trim/split/remove with 1–32 ordered kept ranges,
  real gap-removing concat/shared A/V origin/silence padding including audio offsets,
  centered original/vertical/square crop, static caption and gain. CAS save,
  undo/redo branching, reopen and progress/cancel export; retry starts a new export.
  Full-source/hash-linked H.264/AAC proxies ≤1280×720 preserve rotation/aspect and
  source-time playback. Multi-track editing is absent; Phase 5 adds timed clip captions.
- Phase 4 core features implemented: isolated OpenCode 1.19.5-only discovery,
  model selection, metadata/current-timeline + separately optional memory/transcript context,
  persistent bound proposals, human preview/accept/reject and durable cancellation.
  Official SDK 1.32.2 stdio MCP uses separate UI-issued 30-minute scoped grants.
  Local whisper.cpp/FFmpeg transcription, progress, durable cancel/restart fencing
  and consent-gated MCP transcript reading are implemented. Live CLI inference and
  all-feature end-to-end acceptance are deferred to Phase 9; additional CLI adapters
  are future extensions, not incomplete Phase 0–4 obligations.
- Custom Windows titlebar with drag/minimize/maximize/restore/close controls.
  User-facing phase badges are absent.
- Reviewed clip discovery, local speech/scene/silence evidence, opt-in model ranking,
  configurable limits, boundary/framing/timed-caption correction, sequential exports
  and private YouTube review drafts. See [CLIPS](CLIPS.md) for API and recovery limits.

## Development commands

Use Node.js 22 LTS, npm 10+ and `npm ci`. The workspace pins Node **22.23.2** as a
development dependency, so npm scripts use the same executable that is staged for
the desktop. Node's built-in SQLite is experimental in this release; its database
files are ordinary SQLite files, but the application API may require adaptation
when upgrading Node.

```bash
npm run dev             # Vite + authenticated local API, 127.0.0.1:1438
npm run tauri:dev       # Native shell; Rust owns the API, Vite serves UI only
npm run check           # Type checks, storage/API/provider/media/Studio/AI/MCP tests, build
npm run test:runtime    # Stage and exercise the isolated packaged Node/API
npm run preview         # Feature manifest only
npm run mcp:stdio       # After npm run build; UI-issued MCP env required, see below
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

Staging also bundles `mcp.mjs` for UI-issued external-client launch alongside the
pinned Node executable. `MCP-THIRD-PARTY-NOTICES.txt` retains full bundled-dependency
license texts; Node/Zod licenses and linked legal comments are included. Packaged
MCP launch does not require an external Node installation.

Desktop/dev entry points automatically prepare FFmpeg/FFprobe on Windows/Linux x64.
Working legacy `media-tools.json`, environment and PATH tools are reused. Missing
tools download from pinned `eugeneware/ffmpeg-static` `b6.1.1` assets into
`tools/ffmpeg-b6.1.1-<platform>-<arch>` under the workspace data directory.
Full license/source notices and executable bytes are SHA-256 verified; partial
downloads never activate. Verified caches work offline, failures retry every minute,
and shutdown aborts downloads. Stable paths are shared by editing/transcription;
the next availability poll activates them without restarting. No video-tool form
or diagnostic badges appear in the normal UI. Embedded/test API instances remain
network-free unless `managedMediaTools` is enabled. Export uses H.264 (`libx264`),
AAC and `drawtext`. Desktop imports wait until processing is ready.

For local transcription, install compatible whisper.cpp `whisper-cli` and a GGML
model separately. `ATRIS_SHARE_WHISPER_CLI` selects the native executable (otherwise
`whisper-cli` on `PATH`); `ATRIS_SHARE_WHISPER_MODEL` requires an absolute local model
path. FFmpeg extracts 16 kHz mono 16-bit PCM. Maximum source/audio duration is two
hours; language and ordered timestamps are validated, and actual source bytes are
hash-checked before/after. No speech-recognition executable/model is automatically downloaded.
See [engine details](../packages/media-engine/README.md).

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
metadata, timelines, renders, publications and transcripts survive restart. Managed bytes live
under `media/`; v3 adds Studio tables, v4 adds durable AI runs/cancellation and v5
adds transcripts with owner leases/cancellation; v6 adds scoped clip analyses,
candidate corrections and batch/draft provenance while preserving earlier data.
V7 adds IANA schedules/occurrences, v8 social connections/posts, and v9 durable
remote-refresh leases. See [scheduling](SCHEDULING.md), [social](SOCIAL.md),
[memory export/retention](DATA.md) and [package resources](PACKAGING.md).
AtrisShare proposal/run history remains local; temporary
CLI transcripts are removed rather than retained or resumed.

Windows vault records use DPAPI **CurrentUser** encryption and atomic encrypted
file replacement under `vault/`. Credential references are random UUID generations, hashed
for filenames. Secrets cross the PowerShell helper through stdin, not argv, and
are never written as plaintext. Startup probes protect/unprotect before reporting
the vault available. A missing/failed/unsupported vault returns unavailable and
does not fall back to SQLite or browser storage. macOS/Linux vault backends are
not implemented. Local workspaces never write social credentials. YouTube account
credentials and resumable upload session URLs use the vault, while SQLite holds
references and safe metadata.

**Accounts → YouTube app setup** stores the Desktop app client ID and optional
secret in a reserved encrypted vault record, activates immediately and reloads on
restart. Valid local config takes precedence over the environment fallback; corrupt
or unreadable local config fails closed. The UI/API returns only readiness/source/
bounded errors, with no saved-value readback or browser storage. Active OAuth
sessions and configuration writes are race-fenced. Existing connected-account
grants retain their original client configuration. See [YouTube setup](YOUTUBE.md).

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

Trusted desktop API operations require `Authorization: Bearer <session key>`.
The separate `/api/mcp/*` surface requires a UI-minted scoped grant instead; it
cannot authorize desktop approval routes. Host and origin
checks are additional boundaries; neither replaces authentication. API errors are
bounded codes, never raw request bodies, SQL errors or tokens. JSON inputs are
strictly validated with a 32 KiB limit; raw media import has a separate 2 GiB streaming
limit. CORS preflight and the single-use
YouTube OAuth callback/static result page are unauthenticated; see [the boundary](YOUTUBE.md#local-api).

Closing the native window requests authenticated shutdown, aborts/awaits Studio
and AI work, waits, then kills/reaps the owned child if necessary. On Windows, Node starts
suspended, is assigned to a **kill-on-close Job Object**, then resumes; FFmpeg,
FFprobe and owned CLI descendants stay in that job. Closing the job kills the process tree
even after Node exits or the native owner is terminated. Stdin EOF and a parent-PID
watchdog also terminate the API when its owner disappears. There is no independent
background/tray mode; closing stops local work. It cannot undo remote requests
already accepted; interrupted uploads require reconciliation and exports need a new run.
Transcription cancellation is durable; five-minute owner leases with heartbeats
fence competing/stale workers. Expired running leases surface `transcript_interrupted`.
Failed/interrupted transcription needs an explicit new run, never automatic retry/resume.

The session key represents the current local application session, **not a social
OAuth identity**. This is a single-OS-user workspace, not a remote multi-user server.

## Workspace API

Every workspace request uses the desktop session bearer. JSON mutation bodies reject unknown fields.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/workspace` | Accounts, selection, selected account's projects, safe vault status and data path |
| POST | `/api/accounts` | `{displayName, platform: "local"}` creates a real local workspace; social identities require OAuth |
| GET | `/api/settings/media-tools` | Saved paths, active tool status and restart-needed flag |
| POST | `/api/settings/media-tools` | `{ffmpegPath, ffprobePath}`; verify local executables and save for next startup |
| POST | `/api/media/setup` | Retry background media preparation; no user-provided URLs, paths or commands |
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
| POST | `/api/media/:id/proxy` | `{context}`; new full-source compatible playback job (`202`) |
| POST | `/api/media/:id/render` | `{context, expectedRevision}`; new export job (`202`) |
| POST | `/api/renders/:id/cancel` | `{context}`; cancellation of a locally running export/proxy/preview |
| GET | `/api/transcription/setup` | Safe availability flags for FFmpeg, whisper.cpp and model |
| POST | `/api/media/:id/transcribe` | `{context}`; starts local transcription (`202`) |
| GET | `/api/media/:id/transcript?accountId=…&projectId=…` | Latest scoped transcript/status or `null`; trusted desktop can read segments |
| POST | `/api/transcripts/:id/cancel` | `{context}`; durable cancellation request/result |
| POST | `/api/publications` | `{context, artifactId, title, description, visibility, madeForKids, notifySubscribers}`; immutable review draft (`201`) |
| POST | `/api/publications/:id/approve` | `{context, digest}`; consumes the reviewed digest once, starts 10-minute dispatch window (`202`) |
| POST | `/api/publications/:id/reconcile` | `{context}`; queries existing upload session/video; never blindly initiates another upload (`202`) |
| POST | `/api/publications/:id/cancel` | `{context}`; cancels review or persists dispatch revocation for uploading/uncertain work (`202`) |

`edit` is `{inSeconds, outSeconds, crop, gainDb, caption, segments?}`. Times are finite
source seconds with end after start. Optional `segments` contains **1–32**
`{inSeconds, outSeconds}` ranges, chronological/non-overlapping and inside the outer
in/out bounds; without segments the envelope is the single clip. Gaps are removed
by real concat; video/audio keep a shared origin and missing/offset audio is padded
with silence. Sources without audio do not acquire an audio stream. Crop is
`original`, `vertical` or `square`; gain is −60…24 dB and static caption at most
2,000 characters. Save/undo/redo and export reject stale revisions with
`409 revision_conflict`. Timelines retain up to 200 edits; saving after undo replaces
the redo branch. Export never overwrites source bytes; retry creates a new job.

The player shows stored source/proxy/export content, not unsaved edit-field changes.
Proxies are full-source H.264/yuv420p/AAC (audio only when present), bounded to
1280×720 without upscaling and preserving rotation/display aspect. Source/proxy
switching retains source time; edits are not baked into proxy playback. Proxy and
proposal-preview artifacts cannot be used as publication artifacts.

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

## AI and external MCP API

The AI panel requires an explicit project/account/destination/artifact. Install/login
with official OpenCode; `ATRIS_SHARE_OPENCODE` optionally selects an absolute native
executable. Safe native discovery currently allows **1.19.5 only**; other versions
fail closed. The CLI auth-store path is preserved, credentials never read/copied by
AtrisShare. Temporary cwd/config/cache/database and transcript are cleaned. Effective
config/agent permissions are verified with no file/tool/skill/MCP access in the child.
Actual CLI-returned model IDs are not entitlement proof. See [bridge](../packages/ai-bridge/README.md).

Generate sends request text, scoped metadata/source probe/current timeline and
optional confirmed account/project memory to the selected model. Speech remains
local unless the explicit prompt checkbox sets `includeTranscript: true`, separately
from memory opt-in. Then a successful transcript is source-byte hash-checked and
included up to **16,000 text characters / 150 segments**, with timestamps, language,
duration, source hash and `truncated` metadata. It sends **no media bytes, frames or
audio**. Remote request consent is explicit.
Immutable proposals persist locally with scope/source SHA-256/base revision;
preview does not apply. Humans accept/reject; acceptance writes the shared timeline
with revision/source checks, so accepted edits can be undone. Cancellation persists across
runtime instances; calls are one-shot with no CLI resume.

These routes require the **desktop** session bearer:

| Method | Route | Input / result |
| --- | --- | --- |
| GET | `/api/ai/setup` | Safe availability/version, actual model IDs and CLI-managed auth status |
| GET | `/api/ai/runs?accountId=…&projectId=…&artifactId=…` | Latest 30 scoped runs/proposals |
| POST | `/api/ai/runs` | `{context, destinationId, artifactId, model, prompt, includeMemory, includeTranscript?, allowRemote: true}`; transcript defaults false; starts a run (`202`) |
| POST | `/api/ai/runs/:id/preview` | `{context}`; preview render without applying (`202`) |
| POST | `/api/ai/runs/:id/accept` or `/reject` | `{context}`; explicit human proposal review |
| POST | `/api/ai/runs/:id/cancel` | `{context}`; durable cancellation request |
| POST | `/api/ai/grants` | `{context, destinationId, artifactId, includeMemory, includeTranscript?}`; separate 30-minute MCP grant and actual command/args (`201`); transcript defaults false |
| POST | `/api/ai/grants/revoke` | `{context, token}`; revoke that scoped grant |

External clients receive the UI-issued command plus `ATRIS_SHARE_MCP_ORIGIN` and
`ATRIS_SHARE_MCP_GRANT` environment values, **never the desktop bearer**. In a checkout,
run `npm run build`, then `npm run mcp:stdio` with the UI-issued environment already
set. Packaged config launches bundled Node + `mcp.mjs`. Expiry, revoke or runtime
restart requires a new grant; selection changes never retarget an existing grant.

Only these dedicated routes accept the **MCP grant**:

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/mcp/capabilities` | Bound scope, tool list, separate memory/transcript flags and expiry |
| POST | `/api/mcp/call` | `{tool, arguments}`; strict scope-checked tool dispatch |

Actual tools are `media_inspect`, `timeline_read`, optional confirmed `memory_read`,
`timeline_propose`, `render_preview`, `render_status` and `publication_request`
(**review only**), plus `media_transcribe`, `transcript_status` and `transcript_cancel`.
Transcription controls return metadata with empty segments, never speech text;
cancel is confined to grant-tracked jobs. `transcript_read` is advertised/allowed
only with explicit transcript opt-in. It verifies actual source bytes against the
hash and takes integer `offset` (default 0) / `limit` (default/max 100), returning
segments and `nextOffset`. Unconsented grants cannot read speech. Preview/status
are confined to the grant's proposals/renders. There is no approve or publish tool.
The grant does not authorize
media download, timeline acceptance, vault access or human approval endpoints.
See [MCP launch/tools/packaging](../services/mcp-server/README.md).

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

Prior Phase 3 local native checks imported a real six-second source, exported 0–2 + 4–6 to
four seconds, verified decoded frames skipped the gap, played the full-source proxy
past 4.5 seconds, retained source time across source/proxy switches and preserved
the source hash. Save/undo/redo/reload passed.

Phase 4 native discovery used installed OpenCode **1.19.5** and returned **nine
actual routes**. A separate official-SDK client launched the UI-issued packaged
command and exercised the actual API with a deterministic proposal, preview and
human apply followed by manual undo/redo/reopen. No live LLM inference or YouTube
acceptance was performed and no secrets were provided. These checks are engineering
evidence, not final provider acceptance. Phase 3's limited scope and Phase 4 core
feature implementation are complete, including local transcription and consent gates.

Live AI/YouTube and all-feature end-to-end acceptance for Phases 0–8 run at final
[Phase 9](ACCEPTANCE.md), after Phase 8 hardening, packaging and feature completion.
Local regressions, builds and rendered/native UI checks continue; deferred live
acceptance does not mean missing features. Release authorization requires Phase 9
completion and a separate explicit request; no automatic earlier release.
