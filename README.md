<div align="center">
  <h1>AtrisShare</h1>
  <p><strong>Create, edit and share — with AI assistance and you in control.</strong></p>
  <p>
    <a href="README.md"><strong>English</strong></a> ·
    <a href="README.tr.md">Türkçe</a> ·
    <a href="https://atrishub.com">AtrisHub</a>
  </p>
  <p>
    <img src="https://img.shields.io/badge/status-Foundation%20Preview-orange" alt="Foundation Preview" />
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="Apache License 2.0" /></a>
  </p>
</div>

## What is AtrisShare?

AtrisShare is an open-source, local-first workspace being built for AI-assisted
video creation and social publishing across **YouTube, X, TikTok and LinkedIn**.
The goal is one place to edit videos manually or with an AI assistant, discover
short-form clips, write posts, manage multiple accounts and organize publishing.

**Foundation Preview `0.1.0-preview.0`:** this repository currently contains a
buildable TypeScript workspace, domain contracts and development documentation.
The desktop app, social connections, video processing, AI/MCP integrations,
notifications and publishing are **planned, not implemented**. There is no
desktop installer or live publishing in this preview.

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

Account-scoped memory is planned for brand voice, audience context, previous
edits and publishing history. Context will be checked before each operation;
changing accounts must not leak another account's preferences or approvals.

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

All four connectors are planned. Actual features depend on the official API,
account permissions, app review, quotas and available access tiers. A YouTube
catalog does not by itself provide permission or an API to download source footage.
Shorts/short-video behavior will be validated per platform, not assumed from a
file name or a fixed duration. See [platform notes](docs/PLATFORMS.md).

## Run the foundation preview

Prerequisites: **Node.js 22 LTS** (see `.nvmrc`) and **npm 10+**.
From this repository directory:

```bash
npm ci
npm run check
```

`check` type-checks and builds the scaffold, then prints a JSON preview manifest.
It does not start a desktop app, contact a provider or publish content.

```bash
npm run typecheck  # Static contract checks
npm run build      # Compile to dist/
npm run preview    # Build and print the preview manifest
```

`.env.example` documents reserved future local settings; the preview CLI does
not read them. Rust, Tauri prerequisites and FFmpeg are not needed for this stage.

## Repository layout

```text
apps/
  preview-cli/       Runnable foundation manifest
  desktop/           Planned React + Tauri application boundary
packages/
  domain/            Initial TypeScript contracts
  ai-bridge/         Planned CLI/runtime integration
  connectors/        Planned official social APIs
  media-engine/      Planned timeline and video pipeline
  storage/           Planned SQLite and account memory
services/
  local-api/         Planned trusted application API
  mcp-server/        Planned scoped AI tools
  worker/            Planned media and publishing workers
docs/                Public architecture, roadmap and platform notes
```

Only `domain` and `preview-cli` currently contain executable/compilable source.
The other boundaries have implementation notes; they are not working services.

## Roadmap and contributions

The next milestone is the local desktop foundation and durable account/project
state, followed by one end-to-end, approval-gated YouTube flow. Manual editing,
AI/MCP, automatic clipping, scheduling and additional platforms follow in phases.

- [Roadmap](docs/ROADMAP.md)
- [Architecture and trust boundaries](docs/ARCHITECTURE.md)
- [Contributing](CONTRIBUTING.md)
- [Security reporting](SECURITY.md)
- [Changelog](CHANGELOG.md)

## Atris ecosystem

Discover the Atris applications at **[atrishub.com](https://atrishub.com)**.
AtrisShare is a standalone repository; running this foundation preview does not
require AtrisHub credentials or an AtrisAgent checkout.

## License

Licensed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE).
Third-party AI tools, platform APIs, media assets and future bundled binaries
retain their own licenses and terms.
