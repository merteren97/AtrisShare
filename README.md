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
are implemented. Create clearly labeled demo targets, organize projects and
create/edit/delete notes with provenance and suggested/confirmed states. Dark/light
themes and Turkish/English UI are available. Windows DPAPI provides an internal
credential vault; demo targets do not store social credentials.

**Phase 2 code is implemented; live acceptance is pending:** YouTube Desktop
OAuth/PKCE, subject/channel verification, vault storage, refresh/disconnect, owned
catalog pagination and local-file linking, immutable publication review, resumable
upload, processing checks and receipts/reconciliation. Tests exercise the real
services with controlled providers, **not live Google**. A live connection or
publication requires your own OAuth app, authorized channel and explicit human
approval; no live Google acceptance is claimed. See [YouTube](docs/YOUTUBE.md).

**Phase 3 is partial:** Studio imports immutable managed media and provides a manual
single-clip editor: trim, original/vertical/square crop, caption, audio gain,
revisioned save, undo/redo, reopen and export progress/cancel. Retry starts a new
export. Multi-track editing, split and proxies are not implemented. Windows has a
custom titlebar and kill-on-close ownership of the runtime/media process tree.
AI/MCP, notifications, scheduling and other social connections remain planned.
No signed installer is released.

## Planned workflow

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
exports/publications add scoped history notes. AI retrieval remains planned. Each memory
operation checks its explicit context; implemented YouTube approvals bind the
original account, project, destination, metadata and artifact SHA-256. Each explicit
approval is single-use with a 10-minute dispatch window. Cancellation persists
dispatch revocation; it cannot promise to undo effects already accepted remotely.

## AI choice and video tooling

The planned AI bridge adapts the CLI/runtime patterns used by AtrisAgent, with
capability-based model discovery rather than a single mandatory AI provider.
Initial runtime candidates are Codex CLI, Claude Code, OpenCode and Antigravity CLI.
They are not integrated yet and will require their official installation/login.

A local **MCP** interface is planned for compatible external AI clients. It will
expose bounded media inspection, clip suggestions, edit proposals and preview
rendering. FFmpeg-backed workers perform the editing. AI may request publication
approval; only the trusted application can accept a human decision and publish.

## Platform status

YouTube connection and supervised publishing code are implemented with controlled-provider
coverage; live connection/publication acceptance is pending. Other connectors are planned.
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

`check` runs type checks, storage/API/OAuth/publishing/media/Studio tests and a
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

Media inspection/export uses **external FFmpeg and FFprobe**, resolved through
`ATRIS_SHARE_FFMPEG` / `ATRIS_SHARE_FFPROBE` or `PATH`; no media-tool binary is bundled.
Export requires H.264 (`libx264`), AAC for audio and `drawtext` for captions.
Imports accept up to **2 GiB** of self-contained MP4-family (`.mp4`/`.mov`) or WebM
content. `.mkv` is accepted only when the content is WebM, not general Matroska.
Authenticated Blob preview/download is limited to **256 MiB** and playback depends
on WebView codec support. Without FFprobe, valid imports can be stored without
probe metadata; editing requires probed duration and available tools.

Start by adding a **demo account**, creating a project, then opening **Memory**.
Select **Account-wide** for account notes or a specific project for project notes;
these scopes are intentionally separate. Selection and notes survive restarts.
To connect a real YouTube channel on Windows, configure your Desktop OAuth client
and use **Accounts**; follow [the connection guide](docs/YOUTUBE.md).
Open **Studio** with a project selected to import media, save edits and export.

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
  ai-bridge/         Planned CLI/runtime integration
  connectors/        Planned official social APIs
  media-engine/      Managed media, FFprobe inspection and single-clip FFmpeg export
  storage/           SQLite migrations, repositories, DPAPI vault port
services/
  local-api/         Authenticated loopback application API
  mcp-server/        Planned scoped AI tools
  worker/            Reserved standalone queue/scheduling service
docs/                Public architecture, roadmap and platform notes
```

Desktop, domain, storage, local API, media engine and preview CLI are implemented.
YouTube authentication/publishing and lease-backed Studio jobs currently run inside
the local API. AI bridge, other connectors, MCP and a standalone worker queue remain planned.

## Roadmap and contributions

The next acceptance milestone is the implemented, approval-gated YouTube flow with
a user-owned OAuth app and authorized live channel. The single-clip editor is an
initial slice; fuller editing, AI/MCP, automatic clipping, scheduling and additional
platforms follow in phases.

- [Roadmap](docs/ROADMAP.md)
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
Third-party AI tools, platform APIs, media assets and future bundled binaries
retain their own licenses and terms.
Temporary GPL-enabled FFmpeg builds used for local verification are not distribution
artifacts; any future bundling requires a separate build/codec license review.
