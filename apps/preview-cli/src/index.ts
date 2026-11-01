import { APP_VERSION, MEDIA_TOOL_NAMES, SOCIAL_PLATFORMS } from "../../../packages/domain/src/index.js";

console.log(JSON.stringify({
  application: "AtrisShare",
  version: APP_VERSION,
  stage: "local-workspace-preview",
  implemented: ["React/Tauri desktop", "authenticated loopback API", "SQLite projects and context",
    "account/project-scoped memory CRUD", "transactional audit", "Windows DPAPI vault port",
    "YouTube Desktop OAuth/PKCE, identity/channel verification, refresh and disconnect (live acceptance pending)",
    "scoped managed source import, owned channel catalog and media linking",
    "canonical immutable drafts, explicit expiring approval, resumable upload and receipt reconciliation (controlled-provider verified)",
    "single-source split/kept ranges, trim/crop/caption/gain, revisioned undo/redo, full-length proxies and external FFmpeg export",
    "isolated OpenCode proposal adapter and model discovery (live inference acceptance pending)",
    "local whisper.cpp transcription with timestamped segments and explicit AI/MCP transcript opt-in",
    "encrypted in-app Google Desktop OAuth app configuration",
    "scoped MCP stdio, immutable edit proposals and human preview/accept/reject",
    "custom Windows titlebar and native runtime process-tree ownership"],
  liveYouTubeAcceptance: "pending",
  liveAiInferenceAcceptance: "pending",
  availableMcpTools: ["media_inspect", "timeline_read", "memory_read (opt-in)", "media_transcribe", "transcript_status", "transcript_cancel", "transcript_read (opt-in)", "timeline_propose", "render_preview", "render_status", "publication_request (review only)"],
  finalAcceptancePhase: 9,
  plannedPlatforms: SOCIAL_PLATFORMS,
  plannedMediaTools: MEDIA_TOOL_NAMES,
  publishingAvailable: true,
  publicationRequirements: "verified YouTube connection, explicit per-draft human approval; live acceptance pending",
  desktopAvailable: true,
  website: "https://atrishub.com",
  roadmap: "docs/ROADMAP.md"
}, null, 2));
