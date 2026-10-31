# Preview roadmap

This is a milestone plan, not a release-date commitment. Phases 0–1 are implemented.
Subsequent phases require their own implementation and checks.

| Phase | Milestone | Completion evidence |
| --- | --- | --- |
| 0 | Foundation preview | Standalone workspace, EN/TR README, Apache-2.0, ignore rules, contracts, working build/manifest |
| 1 — implemented | Local desktop and state | React/Tauri shell, authenticated loopback API, SQLite migrations, scoped memory CRUD/audit and Windows DPAPI port; Windows native acceptance |
| 2 | First supervised YouTube flow | Connect account, read/verify channel, import local media, explicit approval, publish and record receipt on an authorized test channel |
| 3 | Manual video editor | Non-destructive timeline, preview/proxies, trim/crop/captions/audio, cancel/retry render and undo |
| 4 | AI runtime bridge and MCP | First real CLI adapter, model discovery, scoped tools, AI side panel, previewable edit proposals, external MCP interoperability |
| 5 | AI clip discovery | Timestamped analysis, ranked/explained candidates, configurable short clips, reframing/captions and final review |
| 6 | Durable queue and schedules | One-off/daily/weekly local scheduling, approval notification per occurrence, restart/offline/DST recovery, reconciliation |
| 7 | Additional platforms and text | X/LinkedIn composer, TikTok video flow, multiple destinations/accounts, capability-aware cross-posting |
| 8 | Hardened public preview | Native acceptance, accessibility, packaging, license inventory, release notes and accurate support matrix |

## Ordering

Start with one verified end-to-end YouTube flow instead of implementing four
incomplete connectors. Manual editing precedes AI editing so both can share a
real media pipeline. AI clip automation builds on those primitives. Scheduling
builds on a proven approval/publisher boundary and persistent jobs.

Multi-account isolation, memory provenance and approval checks are cross-cutting
requirements from Phase 1 onward, not late additions. The account memory system
grows incrementally: initial records in Phase 1, edit/publication history in
Phases 2–3, scoped AI retrieval in Phase 4 and clipping context in Phase 5.

## Decisions to validate during implementation

- Available platform API products/scopes, app reviews, quotas and test accounts.
- How channel-owned footage is supplied; no assumption of arbitrary URL downloads.
- Transcription/visual-analysis providers, local options, cost and media disclosure.
- Which CLI adapter is implemented first and which capabilities it truly exposes.
- OS credential vault, background/tray behavior and packaged target platforms.
- FFmpeg build, codec and distribution licenses before bundling binaries.
- Detailed time-zone/DST, approval expiry and missed-run product behavior.
- Any future AtrisHub login or hosted/always-on scheduling integration.
