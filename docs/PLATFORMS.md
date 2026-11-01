# Platform integration plan

**YouTube connection and supervised publishing code are implemented; live acceptance
is pending.** OAuth/PKCE, channel/subject verification, vault storage, refresh/
disconnect, owned catalog pagination/linking, immutable review, resumable upload,
processing receipts and reconciliation have controlled-provider coverage, not live
Google acceptance. Live use needs a user-owned OAuth app, authorized channel and
explicit human approval. [Setup and current limits](YOUTUBE.md). All other connectors
remain planned; access products/restrictions can change.

| Platform | Operations / target | Integration discovery required |
| --- | --- | --- |
| YouTube | Implemented verification, owned metadata/linking and supervised video upload/reconciliation; short-form classification unverified | Live acceptance, OAuth/API review, quotas, privacy restrictions and Shorts eligibility |
| X | Text composition and supported media posts | OAuth/user context, write/media product access, pricing tier, character/media constraints and rate limits |
| TikTok | Short-video preparation and permitted publishing flow | Content Posting API eligibility/review, consent UX, account restrictions, upload/processing states and visibility options |
| LinkedIn | Member and, where permitted, organization text/video posts | OAuth products/scopes, organization roles, media upload flow, API versioning and app review |

Official starting points:

- YouTube: <https://developers.google.com/youtube/v3>
- X: <https://docs.x.com/>
- TikTok: <https://developers.tiktok.com/doc/content-posting-api-get-started/>
- LinkedIn: <https://learn.microsoft.com/en-us/linkedin/marketing/>

## Connector rules

1. Detect capabilities for the authenticated account/destination, not just platform.
2. Keep social OAuth separate from AI CLI authentication. Store least-required
   scopes, expiry/refresh metadata and vault references; support disconnect/revoke.
3. Show destination identity and content constraints before approval. Unsupported
   text/video/scheduling operations must be explicit, not silently substituted.
4. Handle upload, processing, publish and result reconciliation as separate steps
   where required. Record provider IDs without leaking credentials.
5. Use local scheduling initially. Sending a post to a provider's own scheduler
   is an external side effect and needs explicit approval too.
6. Treat each cross-post destination as its own job; partial success is not total success.

## YouTube footage and Shorts

Reading a channel's video list/metadata does not supply a source-media download
API. Studio uses user-provided local files and ownership-verified channel/video mappings.
Add only authorized source-import paths after validating availability and terms.
Prior project timelines, transcript artifacts and channel metadata can inform
clip selection without pretending the channel catalog contains editable footage.

Produce configurable short-form renders, then validate actual platform
requirements. A 30-second 9:16 export is a useful target preset, not a guarantee
of classification as a Short or permission to post on another platform.
