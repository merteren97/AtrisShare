# MCP server — scoped stdio and local transcription tools

`src/index.ts` uses the official **`@modelcontextprotocol/sdk` 1.32.2** with stdio
transport. Phase 4 core feature implementation is complete. The server calls the running local API through
a separate scoped capability; media processing stays in the media engine.

## Launch from an external client

1. Run AtrisShare, select the exact account/project and source artifact, then open
   Studio's AI panel. Under MCP, create a grant; confirmed memory and transcript
   reading are separate explicit opt-ins. Speech remains local without transcript consent.
2. Copy the UI-generated client configuration. It contains the **actual Node
   executable and entrypoint** plus `ATRIS_SHARE_MCP_ORIGIN` (the running
   `http://127.0.0.1:port`, without a trailing slash) and `ATRIS_SHARE_MCP_GRANT`.
   Use those environment values only in the intended client process.
3. Keep AtrisShare running. The grant expires after **30 minutes**, can be revoked
   in the UI and is invalidated by runtime restart. Mint a new grant/config after
   expiry, revocation or restart. Selection changes never retarget an existing grant.

For standalone checkout use, install dependencies with `npm ci`, then build:

```bash
npm run build
```

With the two UI-issued environment variables already set in the launching process:

```bash
npm run mcp:stdio
```

That script runs `node dist/services/mcp-server/src/index.js`. For external clients,
prefer the exact command/args returned by the UI so stdout stays MCP-only.
`.env.example` is a reference, not automatically loaded. No static example grant
is provided. Never substitute the desktop session bearer: it is not shared with
external clients, and the MCP grant cannot call desktop approval routes.

Packaged runtime staging includes **`mcp.mjs`**, pinned Node **22.23.2**, linked
legal comments, `MCP-THIRD-PARTY-NOTICES.txt` with full bundled-dependency license
texts, and `NODE-LICENSE.txt` / `ZOD-LICENSE.txt`. UI-issued command paths resolve
the packaged resources; an external Node installation is not required there.

## Actual tools

| Tool | Capability |
| --- | --- |
| `media_inspect` | Bound artifact's metadata/hash/probe, not media bytes |
| `timeline_read` | Bound artifact's saved revision/history |
| `memory_read` | Confirmed account/project notes; advertised only with opt-in |
| `media_transcribe` | Start local whisper.cpp/FFmpeg transcription of the bound artifact; metadata only, empty segments |
| `transcript_status` | Latest bound transcript job/status or `null`; metadata only, empty segments |
| `transcript_cancel` | `{transcriptId}`; cancel only a job tracked by this grant; metadata only, empty segments |
| `transcript_read` | Advertised/allowed only with explicit transcript opt-in; successful hash-bound transcript, paginated segments |
| `timeline_propose` | Immutable source-hash/base-revision-bound edit proposal; does not apply it |
| `render_preview` | Render a proposal created by this grant; does not mutate the timeline |
| `render_status` | Status/progress for this grant's preview renders |
| `publication_request` | Create a publication **review** draft only; no upload or approval |

Inputs are strict runtime-validated schemas. Every call rechecks the grant's
account/project/destination/artifact scope and lifetime. Preview/status IDs are
restricted to the grant's own proposals/renders. Responses and time are bounded;
stdio EOF/client close aborts pending transport work. Revocation/expiry blocks
further calls; it does not erase retained local proposals or already-started jobs.

`media_transcribe` and `transcript_status` accept only `{}`. `transcript_read`
accepts integer `offset` (0–10,000, default 0) and `limit` (1–100, default 100),
returns up to 100 segments and `nextOffset` (`null` at the end). Before returning
speech it verifies **actual source bytes** against SHA-256, then rechecks the grant.
It is neither advertised nor callable without consent; start/status/cancel never
return speech text even for an opted-in grant. Transcript consent does not imply
memory consent. Local transcription needs external tools/model; see [setup and
limits](../../packages/media-engine/README.md). Durable cancellation and lease expiry
are persisted; interrupted jobs require an explicit new run, no automatic retry/resume.

There is no automated clip-analysis, `approve` or `publish` tool and no
arbitrary shell/file/FFmpeg tool. Human preview/accept/reject happens in the trusted
application; accepted proposals use the manual timeline and undo. Publication
requires the separate human review boundary. OAuth credentials and the desktop
bearer are never tool context.

## Engineering evidence and Phase 9 acceptance

An actual separate official-SDK client launched the packaged UI-issued command,
completed handshake/list against the real local API, submitted a **deterministic**
proposal and rendered a playable preview. Native human apply, manual undo/redo,
reopen and unchanged source bytes passed; an approval tool was unavailable and
the grant was rejected by the desktop approval endpoint. This verifies external
MCP interoperability, **not LLM inference or live publication**. Installed OpenCode
1.19.5 discovery returned nine routes; no live CLI inference or YouTube acceptance
was performed. No secrets were provided. Local regressions, builds and rendered/native
UI checks continue as engineering evidence. Final live AI/YouTube and all-feature
end-to-end validation for Phases 0–8 run at [Phase 9](../../docs/ACCEPTANCE.md), after
Phase 8 hardening, packaging and feature completion. Deferred acceptance is not a
missing Phase 4 feature. Release authorization requires Phase 9 completion and a
separate explicit request. See [AI bridge](../../packages/ai-bridge/README.md).
