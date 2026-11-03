# AI runtime bridge — Phase 4 core implemented

`src/opencode.ts` implements `OpenCodeBridge`: installation/model discovery and
bounded, cancellable, one-shot edit generation. Phase 4 **core feature implementation
is complete**, including local transcription/context and scoped MCP integration in
the local API. OpenCode is the required first real adapter. Codex CLI, Claude Code
and Antigravity CLI adapters are future extensions, not incomplete Phase 0–4 obligations.
The port adapts AtrisAgent runtime-boundary patterns without sibling dependencies.

## Installation and isolation

- Install and authenticate with the official OpenCode CLI. Discovery checks native
  executables on absolute `PATH` entries and the Windows npm native installation;
  `ATRIS_SHARE_OPENCODE` can select an absolute native executable (Windows: `.exe`).
  Relative paths, npm shims and shell scripts are rejected.
- Only **1.19.5** has verified isolation semantics and is currently accepted.
  Other versions fail closed with `ai_version_unsupported`; a valid detected version
  remains visible separately from effective-configuration errors.
- The child retains the official CLI auth-store **path** (`XDG_DATA_HOME` or the
  normal `~/.local/share` base); AtrisShare never reads or copies credentials.
  CLI login/auth remains CLI-owned, separate from social OAuth.
- Each discovery/generation uses fresh temporary cwd/home/config/cache/state/tmp
  and database locations. Parent tokens and configuration are not forwarded.
  `--pure`, effective `debug config` and `debug agent` verification enforce the
  dedicated one-step agent with all permissions denied: no file access, tools,
  skills, plugins or MCP in the child. Verification failure blocks generation.
- Child output/time are bounded; cancellation kills the owned process tree and
  awaits close before cleanup. Temporary state, including the CLI transcript,
  is removed on completion, failure or cancellation. Calls never resume a CLI session.

## Model catalog refresh

The desktop runtime shares a bridge configured with `catalogDirectory` under its
own data directory across video, clips and text assistance. Product launch starts
discovery in the background; runtime/workspace readiness does not wait for it.
`GET /api/ai/setup?refresh=1` and the panel refresh actions bypass the setup TTL.
The social text setup route forwards its existing `refresh=1` flag to the same port.

Configured discovery refreshes a missing/expired catalog (one-hour TTL) through
the official `models --refresh --pure`. OpenCode can swallow download failures,
so the bridge also validates the newly-created isolated cache file and enumerates
models from its pinned raw snapshot before atomically publishing it. Catalogs are
bounded and keyed by executable/version. They contain public model metadata, not
credentials. A failed refresh retains last-known IDs/timestamp as `catalog.state:
stale` with `ai_catalog_refresh_failed`; it does not claim a successful update.

Inference uses a per-operation `OPENCODE_MODELS_PATH` copy of the verified snapshot,
not the CLI's bundled fallback. It does not fetch models or widen config/plugin/tool
permissions. A removed model cannot silently redirect generation. Independent port
callers should configure `catalogDirectory` and discover before generating; explicit
refresh without a directory retains only an in-memory snapshot.

## Requests and review

`models` returns actual CLI model IDs; these are **not proof of entitlement** or
successful inference. The user selects a returned model before Generate. The local
API supplies the request, account/destination/project/artifact metadata, source
probe and current timeline, plus optional **confirmed** account/project notes.
Memory is a separate opt-in. Local whisper.cpp transcription stays on-device until
the user explicitly checks the prompt's `includeTranscript` option (default false).
Then the API verifies actual source bytes against the transcript hash and supplies
at most **16,000 text characters / 150 segments**, including timestamps, language,
duration, source hash and `truncated` metadata. No media bytes, frames or audio are
supplied. Remote generation requires explicit request consent. Local speech
processing is described in [media engine](../media-engine/README.md). Phase 5 adds
[reviewed clip discovery](../../docs/CLIPS.md) and `rankClips`: the same isolated
JSONL lifecycle with a strict candidate-ID/rationale result schema. Clip ranking
requires separate explicit text consent. Timed-caption text is omitted from
metadata/current-timeline prompts and MCP timeline reads to preserve that boundary.

The strict result is a summary and validated `MediaEdit`. The API persists local
AtrisShare run/proposal history after temporary CLI transcript cleanup. Immutable
proposals bind account/project/destination/artifact, source SHA-256 and base timeline
revision. Preview does not apply edits. Human accept/reject is separate; acceptance
checks source/hash and revision, writes the shared manual timeline and supports
undo. Stale proposals cannot overwrite newer edits. Durable cancellation requests
are observed across runtime instances; interrupted runs are not resumed.

AI cannot approve or publish. External clients use the separate
[MCP capability boundary](../../services/mcp-server/README.md), never the desktop bearer.

## Engineering evidence and final acceptance

Controlled tests cover isolation, protocol validation, process cleanup/cancellation,
scope, persistence, stale proposals and human review. Prior local Windows native checks
discovered installed **OpenCode 1.19.5** and nine actual model routes. A separate
official-SDK MCP client exercised deterministic proposal → preview → human apply →
manual undo with unchanged source bytes. This is interoperability evidence, **not live
LLM inference**. No secrets were provided and no live OAuth/AI inference tests were
run. Local regressions, builds and rendered/native UI checks continue as engineering
evidence. Live AI/YouTube and all-feature end-to-end acceptance for Phases 0–8 are
deferred to final [Phase 9](../../docs/ACCEPTANCE.md), after Phase 8 hardening,
packaging and feature completion; this does not mean Phase 4 core features are
missing. Release authorization requires completed Phase 9 and a separate explicit request.
