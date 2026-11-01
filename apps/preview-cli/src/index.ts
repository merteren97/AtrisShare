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
    "single-clip trim/crop/caption/gain, revisioned undo/redo and external FFmpeg export",
    "custom Windows titlebar and native runtime process-tree ownership"],
  liveYouTubeAcceptance: "pending",
  plannedPlatforms: SOCIAL_PLATFORMS,
  plannedMediaTools: MEDIA_TOOL_NAMES,
   publishingAvailable: true,
   publicationRequirements: "verified YouTube connection, explicit per-draft human approval; live acceptance pending",
  desktopAvailable: true,
  website: "https://atrishub.com",
  roadmap: "docs/ROADMAP.md"
}, null, 2));
