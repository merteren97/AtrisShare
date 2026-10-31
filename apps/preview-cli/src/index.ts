import { APP_VERSION, MEDIA_TOOL_NAMES, SOCIAL_PLATFORMS } from "../../../packages/domain/src/index.js";

console.log(JSON.stringify({
  application: "AtrisShare",
  version: APP_VERSION,
  stage: "local-workspace-preview",
  implemented: ["React/Tauri desktop", "authenticated loopback API", "SQLite projects and context",
    "account/project-scoped memory CRUD", "transactional audit", "Windows DPAPI vault port"],
  plannedPlatforms: SOCIAL_PLATFORMS,
  plannedMediaTools: MEDIA_TOOL_NAMES,
  livePublishingEnabled: false,
  desktopAvailable: true,
  website: "https://atrishub.com",
  roadmap: "docs/ROADMAP.md"
}, null, 2));
