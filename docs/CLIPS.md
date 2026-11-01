# Clip discovery and review

Phase 5 implements **Studio → Clips**. A completed source-bound local transcript
is required. Import authorized footage, prepare its transcript, choose a minimum,
target and maximum duration, then **Find clips**. A channel catalog/link is context,
not a footage download API. Nothing in this workflow approves or uploads content.

## Analysis choices

- **Local signals** runs on this device, without an AI/provider request. FFmpeg
  samples video at 2 fps/320 px width for scene changes (threshold 0.3) and detects
  silence below −35 dB for at least 0.35 seconds. Timestamps use the source clock.
  Transcript coverage, complete sentence endings, duration fit, scene changes,
  silence and optional overlap with this source's current saved edit determine a
  reproducible 0–100 editorial score. This is not a reach/virality prediction.
- **Selected AI model** additionally uses the isolated OpenCode 1.19.5 bridge to
  rank existing candidates and explain its choices. Load actual CLI model IDs,
  select a model and explicitly consent to transcript disclosure. The provider
  may be remote and may charge for inference. The request contains at most
  16,000 excerpt characters, bounded segment timestamps/signal summaries, source
  hash, language and the owned channel-video link; optional edit-overlap/revision
  context is separately selected. No raw video, frames, audio, file paths,
  credentials or unrelated account/project memory are sent.

The model may select only validated candidate IDs; it cannot invent source ranges
or change the source timeline. Stored local scores remain separate from AI order
and rationale. No visual model, face tracking or semantic audio classifier is
implemented. Speech-language support depends on the installed whisper model;
sentence hints recognize common Latin/CJK terminal punctuation, not grammar.
Real remote-model ranking acceptance remains in Phase 9.

Limits: source duration ≤2 hours; minimum ≤ target ≤ maximum, each **2–180 seconds**;
up to **8 returned candidates**. At most 1,000 speech-start anchors are sampled,
overlapping windows are de-duplicated and at most 24 are considered for final ranking.
Sampling/truncation is recorded. Evidence stores actual transcript segment indices,
timestamps, excerpt and measured signals. Excerpts may include a segment extending
beyond the candidate; such partial-speech boundaries are flagged, never presented
as word-level alignment. Boundary corrections do not re-score the original evidence.

## Correct, export and prepare a draft

1. Inspect the source, evidence and context around both boundaries.
2. Adjust start/end within the configured limits. Select original, square or 9:16
   crop and a horizontal position (0 = left, 0.5 = center, 1 = right). This is a
   static crop, not subject tracking.
3. Use a static caption, or generate editable timed captions from actual speech
   segments. Up to 100 cues, each ≤300 characters, with ordered source timestamps.
   No word timings are fabricated. Regenerate after boundary changes and review
   recognition errors. Text that cannot fit the output frame fails visibly;
   shorten it and re-export. It is never silently clipped or dropped.
4. Save adjustments, select candidates and **Export selected**. Clips render
   sequentially through the shared FFmpeg pipeline with the same A/V origin and
   missing-audio padding as kept-range edits. Each export is an immutable, named
   artifact; play it in the card or open it in the library. Per-candidate failures
   remain editable and do not discard successful siblings.
5. For a connected YouTube account, set a title and **Prepare private YouTube
   draft**. The exact account/project/destination and completed export hash are
   bound to the existing immutable review payload. Default privacy is private,
   audience is not made-for-kids and subscriber notification is off; inspect these
   in Publishing. Cancel/recreate a draft to change metadata. Review and explicit
   human approval remain separate; neither AI nor clip analysis can approve/upload.

Timed captions render from literal text files with expansion disabled; generated
filter graphs use local script files to avoid Windows argument-length limits.
Source-time cues are intersected/remapped to kept output ranges. Existing manual
edits without the new optional fields retain their behavior. Manual saves preserve
timed cues; AI comparison shows their changes. AI metadata prompts and MCP
`timeline_read` omit timed-caption text to prevent bypassing transcript consent
(`timedCaptionsOmitted` marks omission in MCP). Use consent-gated transcript reading
for speech; the MCP tool set itself is unchanged.

## Persistence and recovery

SQLite migration 6 adds scoped `clip_analyses` without replacing previous data.
An analysis binds account/project/destination, artifact/source SHA-256, exact
transcript ID/digest, saved timeline revision, algorithm version/options, selected
model/session and evidence. Candidate changes use optimistic revision checks.
Changing the source timeline invalidates subsequent actions; start a new analysis.
Draft creation and candidate attachment are one database transaction, preventing
concurrent/stale draft duplication. Previous immutable exports/drafts survive edits.

Analysis/batch work uses a single database-wide active claim, renewable five-minute
lease, durable cross-runtime cancellation and a 40-minute job deadline. Cancellation
awaits owned render cleanup; completed siblings remain in the library. Expired work
is shown as interrupted, not silently resumed or retried. Start a new analysis after
an interrupted/failed analysis. No background scheduler is implied.

## Local API

All routes require the desktop session bearer and explicit scope. MCP grants do
not authorize them. Bodies reject unknown properties. Candidate correction permits
up to 128 KiB JSON so maximum-length Unicode cues fit; other routes retain 32 KiB.

| Route | Input / outcome |
| --- | --- |
| `GET /api/clips` | `accountId`, `projectId`, `artifactId`; last 20 analyses |
| `POST /api/clips` | `context`, `artifactId`, `destinationId`, `options`; durable analysis |
| `PUT /api/clips/:id` | `context`, `expectedRevision`, `candidateId`, `edit`; save correction |
| `POST /api/clips/:id/captions` | `context`, `candidateId`, `start`, `end`; local editable cues |
| `POST /api/clips/:id/render` | `context`, `expectedRevision`, `candidateIds`; sequential batch |
| `POST /api/clips/:id/cancel` | `context`; durable cancellation |
| `POST /api/clips/:id/draft` | `context`, `expectedRevision`, `candidateId`, `title`; private YouTube review draft only |

`options`: `minSeconds`, `targetSeconds`, `maxSeconds`, `count`, `model` (null for
local), `includeTranscript` (mandatory true for model ranking), `includeHistory`.
External FFmpeg/FFprobe and whisper/model setup are documented in the main README.
The pipeline is locally verified with real media and controlled AI outputs; live
AI/Google and consolidated native/end-to-end acceptance remain in Phase 9.
