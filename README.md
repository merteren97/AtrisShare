<div align="center">
  <h1>AtrisShare</h1>
  <p><strong>Create, edit and share — with AI assistance and you in control.</strong></p>
  <p>
    <a href="README.md"><strong>English</strong></a> ·
    <a href="README.tr.md">Türkçe</a> ·
    <a href="https://atrishub.com">AtrisHub</a>
  </p>
  <p>
    <img src="https://img.shields.io/badge/status-Local%20Workspace%20Preview-orange" alt="Local Workspace Preview" />
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="Apache License 2.0" /></a>
  </p>
</div>

## What is AtrisShare?

AtrisShare is an open-source, local-first workspace being built for AI-assisted
video creation and social publishing across **YouTube, X, TikTok and LinkedIn**.
The goal is one place to edit videos manually or with an AI assistant, discover
short-form clips, write posts, manage multiple accounts and organize publishing.

**Local Workspace Preview `0.1.0-preview.1`:** the React/Tauri desktop, authenticated
local API, SQLite projects, persistent account/project selection and scoped memory
are implemented. Create real local video projects without a social account, organize work and
create/edit/delete notes with provenance and suggested/confirmed states. Dark/light
themes and Turkish/English UI are available. Windows DPAPI provides an internal
credential vault. The application does not create simulated social accounts;
legacy local records remain preserved without publication authority.

**Phase 2 features are implemented; live acceptance is deferred to Phase 9:** YouTube Desktop
OAuth/PKCE, subject/channel verification, vault storage, refresh/disconnect, owned
catalog pagination and local-file linking, immutable publication review, resumable
upload, processing checks and receipts/reconciliation. Tests exercise the real
services with controlled providers, **not live Google**. A live connection or
publication requires your own OAuth app, authorized channel and explicit human
approval; no live Google acceptance is claimed. See [YouTube](docs/YOUTUBE.md).

**Phase 3 is complete within its limited manual-editor scope:** immutable source
media, full-source compatible proxies (H.264/AAC, at most 1280×720, rotation and
display aspect preserved), source-time playback, trim/split/remove with 1–32 ordered,
non-overlapping kept ranges within outer bounds and real gap-removing concatenation.
Exports preserve a shared A/V origin and pad missing audio intervals, including audio offsets. Centered
original/vertical/square crop, static caption, gain, revision-checked save,
undo/redo branching, reopen and export progress/cancel are available. Retry starts
a new export. Multi-track editing is not implemented; Phase 5 adds timed clip captions.

**Phase 4 core feature implementation is complete:** an isolated OpenCode bridge,
model selection, persistent reviewable edit proposals, local timestamped transcription
and official-SDK stdio MCP with explicit transcript-read consent. Local native checks
covered actual OpenCode 1.19.5 discovery and an external SDK client's deterministic
proposal → preview → human apply → undo flow, **not live LLM inference**. OpenCode is
the required first real adapter; additional CLI adapters are future extensions.
Windows has a custom titlebar and kill-on-close runtime ownership; the UI has no
phase badges. Local scheduling, tray/reminders and additional official API adapters are implemented below.
No signed installer is released.

**Phase 5 clip discovery is implemented:** Studio → Clips offers local timestamped
speech/scene/silence ranking, or explicitly opted-in OpenCode model ranking with
rationales. Choose 2–180-second limits, inspect evidence, correct boundaries/static
framing and timed captions, export multiple candidates and prepare private YouTube
review drafts. Source/transcript hashes, account/project/destination and timeline
revision are bound to persistent analyses. No face tracking or visual-model analysis;
scores are editing hints. Real local media/UI checks and controlled AI ranking are
engineering evidence; live model/Google acceptance remains at Phase 9.
See [clip workflow and limits](docs/CLIPS.md).

**Phases 6–8:** durable one-off/daily/weekly IANA-zone scheduling creates a fresh
human review per occurrence, with DST/missed-run/expiry recovery. X/LinkedIn text
and video, TikTok video, explicit crosspost variants and opt-in scoped AI text
proposals are implemented behind official app/scopes/role gates. Windows tray/
reminders, scoped memory JSON export and hash-verified package/license staging are
available. Live-provider and clean-install acceptance remains Phase 9; packaging
does not authorize release. See [scheduling](docs/SCHEDULING.md),
[social setup](docs/SOCIAL.md), [data](docs/DATA.md) and [packaging](docs/PACKAGING.md).

## Workflow

1. Connect one or more accounts and select the exact channel/profile destination.
2. Import your footage or inspect your authorized channel's video catalog and edit history.
3. Edit on a non-destructive timeline, manually or with an optional AI side panel.
4. Ask AI for interesting clips — for example, 30-second vertical videos — with
   timestamped evidence, then review and adjust the candidates.
5. Prepare a video/Short or a text post, with platform-specific previews and metadata.
6. Publish now or queue a one-off, daily or weekly occurrence in your time zone.
7. Receive a notification and approve the final destination and content before
   each publication. Unapproved scheduled jobs wait; they do not auto-publish.

Account/project-scoped notes support brand voice, audience and decisions; successful
exports/publications add scoped history notes. AI can optionally use confirmed
account/project notes. Each memory operation checks its explicit context;
implemented YouTube approvals bind the
original account, project, destination, metadata and artifact SHA-256. Each explicit
approval is single-use with a 10-minute dispatch window. Cancellation persists
dispatch revocation; it cannot promise to undo effects already accepted remotely.

## AI choice and video tooling

`OpenCodeBridge` safely discovers a native installation and currently accepts only
verified **OpenCode 1.19.5**; other versions fail closed. Install/login with the
official CLI. AtrisShare preserves its auth-store path without reading or copying
credentials. Temporary working/config/cache/database state is isolated and cleaned;
effective config and agent permissions are checked, with files, tools, skills and
MCP unavailable to the child. Model IDs come from the actual CLI, not proof of
account entitlement. Codex CLI, Claude Code and Antigravity CLI are not implemented.

Generate sends your request and scoped metadata/current timeline to the selected
model. Confirmed account/project memory is a separate opt-in. Speech stays local
unless you explicitly check **include transcript** (`includeTranscript`): this adds
at most **16,000 text characters / 150 segments**, with timestamps, language, duration,
source hash and a `truncated` flag. No media bytes, frames or audio are sent.
The temporary CLI transcript is removed; local AtrisShare
proposal/run history persists. Immutable proposals bind scope, source hash and base
revision; humans preview and accept/reject. Cancellation is durable across runtimes;
CLI calls are one-shot, with no resume. See [AI bridge](packages/ai-bridge/README.md).

External **MCP stdio** uses official SDK **1.32.2** and a separate, UI-minted
30-minute account/project/destination/artifact grant, revocable in the UI and
invalidated by runtime restart. The UI provides the actual
command and `ATRIS_SHARE_MCP_ORIGIN` / `ATRIS_SHARE_MCP_GRANT` environment config;
never pass the desktop bearer to external clients. Tools inspect metadata, read
timelines/optional confirmed memory, start/check/cancel local transcription, propose
edits, render previews/check status and create publication review requests.
`transcript_read` is advertised/allowed only with explicit transcript opt-in;
`offset`/`limit` pagination returns at most 100 segments and verifies actual source
bytes against the hash. Start/status/cancel return metadata with empty segments,
so an unconsented grant gets no speech text. There is no approve or publish tool.
See [MCP setup](services/mcp-server/README.md).

## Platform status

YouTube connection and supervised publishing code are implemented with controlled-provider
coverage; live connection/publication acceptance is deferred to Phase 9. X, LinkedIn
and TikTok adapters also have controlled-provider coverage and app-specific prerequisites.
Actual features depend on the official API,
account permissions, app review, quotas and available access tiers. A YouTube
catalog does not by itself provide permission or an API to download source footage.
Shorts/short-video behavior will be validated per platform, not assumed from a
file name or a fixed duration. See [platform notes](docs/PLATFORMS.md).

## Run the local workspace

Prerequisites: **Node.js 22 LTS** (see `.nvmrc`) and **npm 10+**.
From this repository directory:

```bash
npm ci
npm run check
```

`check` runs type checks, storage/API/OAuth/publishing/media/Studio/AI/MCP tests and a
production frontend/core build. Provider tests use controlled transports and do
not connect to live Google or publish content. Real-media fixtures require external tools.

```bash
npm run dev        # Browser development: http://127.0.0.1:1438
npm run tauri:dev  # Native desktop development
npm run preview    # Print a feature/status manifest (not a frontend server)
```

Native development additionally requires Rust stable, Tauri 2 platform
prerequisites, and on Windows WebView2 plus Microsoft C++ Build Tools.
`npm ci` installs the pinned Node 22 runtime used by npm scripts and packaging.
Node 22's built-in SQLite API is marked experimental upstream; no separately
compiled SQLite addon is needed.

Media inspection/export uses **external FFmpeg and FFprobe**. Save their installed
file paths in **Settings → Video tools**, then fully quit and reopen the app.
Saved paths take precedence over `ATRIS_SHARE_FFMPEG` / `ATRIS_SHARE_FFPROBE` or
`PATH`; empty fields use those fallbacks. No media-tool binary is bundled.
Export requires H.264 (`libx264`), AAC for audio and `drawtext` for captions.
Imports accept up to **2 GiB** of self-contained MP4-family (`.mp4`/`.mov`) or WebM
content. `.mkv` is accepted only when the content is WebM, not general Matroska.
Authenticated Blob preview/download is limited to **256 MiB** and playback depends
on WebView codec support. Without FFprobe, valid imports can be stored without
probe metadata; editing requires probed duration and available tools.

Local transcription uses an external **whisper.cpp `whisper-cli`** and compatible
GGML model: `ATRIS_SHARE_WHISPER_CLI` selects the executable (otherwise `whisper-cli`
on `PATH`); `ATRIS_SHARE_WHISPER_MODEL` must be an absolute local model path.
FFmpeg extracts 16 kHz mono 16-bit PCM; sources over **two hours** are rejected.
Language/timestamps and source hashes before/after processing are validated.
Progress, durable cancellation and lease-fenced restart interruption are implemented;
interrupted/failed jobs need an explicit new run, with no automatic retry or resume.
No speech tool/model is bundled or downloaded. See [media engine](packages/media-engine/README.md).

Start with **Video editor → Create project**. The local workspace option requires
no social login. Import footage, trim/split, save edits and export. **Accounts**
contains YouTube, X, TikTok and LinkedIn setup and connection management.
Select **All projects** for account notes or a specific project for project notes;
these scopes are intentionally separate. Selection and notes survive restarts.
On Windows, **Accounts → YouTube app setup** saves your Desktop OAuth client ID and
optional secret in the encrypted OS vault, activates immediately and survives restart.
You can import the Desktop client JSON downloaded from Google Cloud. Continue with
Google, then explicitly choose and confirm the discovered channel. A channel ID
is optional for new connections and required for an exact-account reconnection.
Saved values are never read back to the UI or stored in browser storage. Environment
configuration is a fallback. Follow [the connection guide](docs/YOUTUBE.md) for Phase 9 acceptance.
The **Video editor** navigation opens the editing workspace directly.

Data defaults to `%LOCALAPPDATA%\AtrisShare` on Windows, `~/Library/Application
Support/AtrisShare` on macOS and `$XDG_DATA_HOME/AtrisShare` (or
`~/.local/share/AtrisShare`) on Linux. `ATRIS_SHARE_DATA_DIR` can override it with
an **absolute path**. `.env.example` is a reference, not automatically loaded.
The session token remains in memory and rotates on every runtime launch.

See [local development and API](docs/LOCAL-WORKSPACE.md) for commands, lifecycle,
storage and validation details. CI checks are configured for Windows/Linux; native
Windows has been exercised locally. macOS/Linux desktop packages are unverified.

## Repository layout

```text
apps/
  preview-cli/       Feature/status manifest
  desktop/           React + Vite + Tauri application
packages/
  domain/            Contracts and runtime workspace schemas
  ai-bridge/         Isolated one-shot OpenCode adapter
   connectors/        Boundary; adapters currently live in local-api
  media-engine/      Managed media, proxies, kept-range export and local transcription
  storage/           SQLite migrations, repositories, DPAPI vault port
services/
  local-api/         Authenticated loopback application API
  mcp-server/        Official-SDK stdio tools with scoped launch grants
   worker/            Reserved standalone boundary; local scheduler runs in local-api
docs/                Public architecture, roadmap and platform notes
```

Desktop, domain, storage, local API, media engine and preview CLI are implemented.
YouTube authentication/publishing and lease-backed Studio jobs currently run inside
the local API, alongside AI proposal and transcription orchestration. The OpenCode
bridge, MCP tools, social adapters and durable local scheduler are implemented.
A separate always-on/cloud worker is not provided.

## Roadmap and contributions

Features through Phases 0–8 are implemented within their defined preview scope,
including the limited editor, AI/transcription/clips, local queue, social adapters
and package hardening. **Phase 9 is the final live providers and
all-feature end-to-end acceptance gate for Phases 0–8.** Local regressions, builds
and rendered/native UI checks continue as engineering evidence. Deferred acceptance
does not mean missing features. No secrets were supplied and no live OAuth or AI
inference tests were run. Release authorization requires completed Phase 9 and a
separate explicit request; it is never automatic.

- [Roadmap](docs/ROADMAP.md)
- [Final acceptance checklist](docs/ACCEPTANCE.md)
- [Architecture and trust boundaries](docs/ARCHITECTURE.md)
- [Contributing](CONTRIBUTING.md)
- [Security reporting](SECURITY.md)
- [Changelog](CHANGELOG.md)

## Atris ecosystem

Discover the Atris applications at **[atrishub.com](https://atrishub.com)**.
AtrisShare is a standalone repository; running this local workspace does not
require AtrisHub credentials or an AtrisAgent checkout.

## License

Licensed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE).
Third-party AI tools, platform APIs, media assets and bundled runtime dependencies
retain their own licenses and terms. Runtime staging includes full third-party
license notices; see [MCP packaging](services/mcp-server/README.md).
Temporary GPL-enabled FFmpeg builds used for local verification are not distribution
artifacts; any future bundling requires a separate build/codec license review.
