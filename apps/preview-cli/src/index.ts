import { MEDIA_TOOL_NAMES, SOCIAL_PLATFORMS } from "../../../packages/domain/src/index.js";

console.log(JSON.stringify({
  application: "AtrisShare",
  version: "0.1.0-preview.0",
  stage: "foundation-preview",
  implemented: ["workspace scaffold", "TypeScript domain contracts", "preview manifest"],
  plannedPlatforms: SOCIAL_PLATFORMS,
  plannedMediaTools: MEDIA_TOOL_NAMES,
  livePublishingEnabled: false,
  desktopAvailable: false,
  website: "https://atrishub.com",
  roadmap: "docs/ROADMAP.md"
}, null, 2));
