# Media engine — managed media, proxies, kept-range export and local transcription

`src/index.ts` implements streamed immutable import, SHA-256 verification, FFprobe
inspection and cancellable FFmpeg export. `src/transcription.ts` implements local
whisper.cpp speech extraction/validation. The local API owns orchestration; scoped
artifact metadata, revisioned edits, transcripts and ownership leases live in storage.

## Supported media and limits

- Up to **2 GiB** per import/output. Self-contained MP4-family (`.mp4`/`.mov`) and
  WebM content only; a `.mkv` extension is accepted only for WebM, not full Matroska.
  Content inspection, not the extension, determines the container/MIME.
- Playlists and external MP4/WebM references are rejected before tools run. Files
  get exclusive managed UUID paths; imports/exports never overwrite source bytes.
  Internal `.mp4` storage names do not imply WebM bytes were transcoded on import.
- The API/UI separately cap authenticated Blob preview/download at **256 MiB**;
  browser/WebView codec support still determines playback.
- Missing FFprobe permits a structurally valid import with null probe metadata;
  editing needs probed duration. Inspection/export never fabricate results.

## External tools

Install FFmpeg and FFprobe separately. `ATRIS_SHARE_FFMPEG` / `ATRIS_SHARE_FFPROBE`
select executables; otherwise `ffmpeg` / `ffprobe` resolve on `PATH`. No binary is
bundled. Availability checks do not guarantee codec/filter support: export requires
H.264 `libx264`, AAC when audio exists and `drawtext` for captions.

Tools run without a shell, using argument arrays, a restricted environment and
local file/pipe protocols. Time/output limits and cancellation kill/reap children
before temporary cleanup. Native Windows additionally owns the runtime/media tree
in a kill-on-close Job Object. Temporary GPL-enabled builds used for local
verification are not distribution artifacts; any bundling needs separate build,
codec and license review.

## Phase 3 — completed limited manual-editor scope

The shared `MediaEdit` schema supports an outer in/out envelope and optional
`segments`: **1–32 chronological, non-overlapping kept ranges**, each with a positive
duration and entirely inside the envelope/source duration. Times are original-source
seconds; adjacent ranges are valid. Without segments, the envelope remains a single
clip. Studio supports trim, split and remove; gaps are removed by actual FFmpeg
concatenation, not metadata-only cuts. Output duration is the sum of kept durations.

Segment rendering uses the **same source-time origin for video and audio** rather
than independently zeroing their first packets. Missing audio before/after packets
is silence-padded before splitting, including positive audio offsets and ranges
outside the audio packet span. A source without audio remains without an audio stream.
Global centered original/9:16/square crop, static burned-in caption and −60…24 dB
gain apply across the kept ranges. Caption text uses a file with expansion disabled.

Export produces a new H.264/AAC MP4, reports progress, probes/verifies the result
and cleans partial output on failure/cancel. Studio saves optimistic revisions
(CAS) with undo/redo, branch replacement and reopen. Export uses the saved revision;
retry starts a **new export**, not a resumed render. Multi-track editing and timed
captions are not implemented.

## Full-source compatible playback

`proxy()` creates a source/hash-linked, full-video H.264/yuv420p + AAC MP4 (audio
only when present), bounded to **1280×720 without upscaling**, with even dimensions.
Input rotation is applied and display aspect is preserved, including anamorphic
inputs. The full source duration and shared A/V clock remain intact; no trim,
concatenation, FPS/tempo change or edit is baked into this proxy.

The player switches source/proxy at the same **source time**. It is not a live
preview of unsaved edits or a shortened edited-output clock. Export and AI proposal
preview are separate render kinds. Proxy/preview artifacts are excluded from the
publication/library surface; source bytes remain immutable. AI/MCP uses this engine
for proposal previews and local transcription; automated clip discovery is Phase 5 work.

## Local transcription — Phase 4 core implemented

- Install external **whisper.cpp `whisper-cli`** and a compatible GGML model.
  `ATRIS_SHARE_WHISPER_CLI` selects the native executable (prefer an absolute path),
  otherwise `whisper-cli` resolves on `PATH`. `ATRIS_SHARE_WHISPER_MODEL` must be an
  absolute local model path. The adapter checks required CLI flags and the model
  header; no speech executable/model is bundled or automatically downloaded.
- External FFmpeg extracts **16 kHz mono 16-bit PCM WAV**. The engine rejects
  audio over **two hours** rather than silently truncating it; the service also
  checks source duration and audio availability. Local CPU inference uses automatic
  language detection. Language, UTF-8/text bounds, ordered non-overlapping timestamps
  and duration are validated; CLI model/source paths and diagnostics are not returned.
- Scope-checked managed sources only; proxy/preview artifacts are excluded. The
  service verifies actual source bytes against SHA-256 **before and after** processing.
  Sanitized transcript text, language, duration and source hash persist in SQLite,
  scoped to account/project/artifact. This text is local but not vault-encrypted.
- Progress comes from actual CLI messages; extraction/loading remains indeterminate.
  Cancellation kills/reaps the child before temporary WAV/JSON cleanup. Durable
  cancellation, a workspace-wide claim and heartbeat-renewed five-minute owner
  leases fence concurrent/stale runtimes. Expired running leases report
  `transcript_interrupted`; failed/interrupted jobs require an explicit new run,
  with **no automatic retry/resume**.
- Speech stays local until explicit `includeTranscript` consent. AI context is
  capped at **16,000 text characters / 150 segments**, with `truncated` metadata;
  memory has its own opt-in. MCP start/status/cancel return metadata with empty
  segments. Only opt-in `transcript_read` exposes text, hash-checking actual source
  bytes and paginating with `offset`/`limit` (max 100). See [MCP](../../services/mcp-server/README.md).

Tests include real managed bytes, controlled child-process failures and an external
FFmpeg/FFprobe fixtures when tools are available. Prior local Windows native checks used a
real six-second source, a full-source proxy and 0–2 + 4–6 ranges exported to four
seconds; decoded frames confirmed the skipped gap and the source hash was unchanged.
Temporary-tool or controlled-provider checks do not establish live provider acceptance.
Local regressions/builds and rendered/native UI checks continue as engineering
evidence. Phase 3's limited scope and Phase 4 core features are complete; live
AI/YouTube and all-feature end-to-end validation for Phases 0–8 run at final
[Phase 9](../../docs/ACCEPTANCE.md), after Phase 8 hardening, packaging and feature
completion. No secrets were provided and no live OAuth/inference tests were run.
Release authorization requires Phase 9 completion and a separate explicit request.
