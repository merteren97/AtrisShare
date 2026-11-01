# Preview roadmap

This is a milestone plan, not a release-date commitment. Features through Phases
0–4 are implemented within their defined scope. Phase 3's **limited manual-editor
scope is complete** and Phase 4's **core feature implementation is complete**.
Live AI/YouTube and all-feature end-to-end acceptance are deliberately deferred to
the new final **Phase 9**, covering everything delivered in Phases 0–8. Deferred
live acceptance is not missing feature implementation or a blocker to subsequent work.

| Phase | Milestone | Completion evidence |
| --- | --- | --- |
| 0 | Foundation preview | Standalone workspace, EN/TR README, Apache-2.0, ignore rules, contracts, working build/manifest |
| 1 — implemented | Local desktop and state | React/Tauri shell, authenticated loopback API, SQLite migrations, scoped memory CRUD/audit and Windows DPAPI port; local Windows native checks |
| 2 — features implemented; final acceptance at 9 | First supervised YouTube flow | In-app encrypted Desktop OAuth setup, OAuth/PKCE, verified identity/channel, refresh/disconnect, immutable managed media, owned catalog pagination/linking, digest-bound human review, resumable upload, processing receipts/reconciliation and durable leases; controlled providers, not live Google |
| 3 — implemented, limited scope | Manual video editor | Full-source/hash-linked compatible proxy ≤1280×720 H.264/AAC with rotation/aspect preserved and source-time playback; trim/split/remove, 1–32 ordered kept ranges within outer bounds, real concat/shared A/V origin/audio-offset silence padding; global crop/static caption/gain, CAS save, undo/redo branching, reopen and export progress/cancel. No multi-track or timed captions |
| 4 — core features implemented; final acceptance at 9 | AI runtime bridge, local transcription and MCP | Required first real adapter: isolated OpenCode 1.19.5, actual CLI model IDs/user selection, bound persistent proposals, preview/human review and durable cancellation. Local whisper.cpp/FFmpeg transcription with timestamps/language/hash validation and restart leases. Explicit transcript context/read opt-in, separate memory opt-in; official SDK 1.32.2 stdio MCP with scoped 30-minute grants. Additional CLI adapters are future extensions |
| 5 | AI clip discovery | Timestamped analysis, ranked/explained candidates, configurable short clips, reframing/captions and final review |
| 6 | Durable queue and schedules | One-off/daily/weekly local scheduling, approval notification per occurrence, restart/offline/DST recovery, reconciliation |
| 7 | Additional platforms and text | X/LinkedIn composer, TikTok video flow, multiple destinations/accounts, capability-aware cross-posting |
| 8 | Hardening, packaging and feature completion | Complete Phases 0–8 features; accessibility, local/native checks, packaging, license inventory, release notes and accurate support matrix; prepare final acceptance inputs |
| 9 — final acceptance | Live providers and all-feature end-to-end validation | Execute the [acceptance matrix](ACCEPTANCE.md) for Phases 0–8: real OAuth/AI, human-approved private publication, recovery, external MCP, native UI/process cleanup and clean install; record evidence and unresolved failures |

## Ordering

Continue feature implementation through Phase 8, including hardening and packaging,
then run Phase 9's consolidated live/all-feature acceptance. Local regressions,
builds and rendered/native UI checks continue throughout as engineering evidence.
Every live upload needs explicit human approval of the current destination/payload/
artifact hashes; final acceptance uses an authorized private test publication.
No secrets were provided and no live OAuth or AI inference tests were run.
**Release authorization is possible only after Phase 9 and a separate explicit
request**; neither Phase 8 packaging nor Phase 9 completion auto-authorizes release.

Prior Phase 3 local native checks used a real six-second source and full-source proxy;
0–2 + 4–6 exported four seconds with decoded-frame gap verification and unchanged
source hash. Phase 4 native discovery returned nine routes from installed OpenCode
1.19.5. An external official-SDK client submitted a deterministic proposal against
the actual API, rendered a preview, and a human applied/undid it in the native UI.
That is MCP interoperability evidence, **not live LLM inference** or final Phase 9
acceptance. No live YouTube acceptance was performed. Phase status is documented
here; UI phase badges are absent.

The first connector is the implemented supervised YouTube flow. Manual editing
precedes AI editing so both share a real media pipeline. AI clip automation builds
on those primitives; scheduling builds on the implemented approval/publisher boundary
and persistent jobs. Their complete live workflows are tested together at Phase 9.

Multi-account isolation, memory provenance and approval checks are cross-cutting
requirements from Phase 1 onward, not late additions. The account memory system
grows incrementally: initial records in Phase 1, edit/publication history in
Phases 2–3, scoped AI retrieval in Phase 4 and clipping context in Phase 5.

## Decisions to validate during implementation

- Available platform API products/scopes, app reviews, quotas and test accounts.
- How channel-owned footage is supplied; no assumption of arbitrary URL downloads.
- Future visual-analysis providers, cost and media disclosure; local whisper.cpp
  transcription is implemented, while automated clip analysis belongs to Phase 5.
- Live inference with the implemented first OpenCode adapter at Phase 9; additional
  CLI adapters/versions require their own support verification when added, not
  incomplete Phase 0–4 obligations.
- OS credential vault, background/tray behavior and packaged target platforms.
- FFmpeg build, codec and distribution licenses before bundling binaries.
- Detailed time-zone/DST, approval expiry and missed-run product behavior.
- Any future AtrisHub login or hosted/always-on scheduling integration.
