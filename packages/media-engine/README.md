# Media engine — managed media and single-clip export

`src/index.ts` implements streamed immutable import, SHA-256 verification, FFprobe
inspection and cancellable FFmpeg export. The local API owns orchestration; scoped
artifact metadata, revisioned edit history and render leases live in storage.

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

## Manual editor slice

The shared `MediaEdit` schema supports one clip's in/out seconds, centered original,
9:16 or square crop, static burned-in caption and −60…24 dB audio gain. Export
produces a new H.264/AAC MP4 (no audio stream is added to silent sources), reports
progress, probes/verifies the result and cleans partial output on failure/cancel.
Caption text is read from a static text file with expansion disabled.

Studio saves optimistic revisions with undo/redo and reopen. Export uses the saved
revision; retry starts a **new export**, not a resumed render. The player shows the
stored source/export, not unsaved field changes. Multi-track, split, proxies,
transcription, AI editing and automatic clip discovery are not implemented.

Tests include real managed bytes, controlled child-process failures and an external
FFmpeg/FFprobe fixture when tools are available. Temporary-tool or controlled-provider
checks do not establish live Google publication acceptance.
