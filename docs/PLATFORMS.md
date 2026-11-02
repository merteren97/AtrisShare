# Platform integration plan

**YouTube connection and supervised publishing features are implemented; live acceptance
is deferred to final Phase 9.** In-app encrypted Desktop OAuth setup, OAuth/PKCE,
channel/subject verification, vault storage, refresh/
disconnect, owned catalog pagination/linking, immutable review, resumable upload,
processing receipts and reconciliation have controlled-provider coverage, not live
Google acceptance. Live use needs a user-owned OAuth app, authorized channel and
explicit human approval. [Setup and current limits](YOUTUBE.md). X, LinkedIn and
TikTok official adapters also have controlled-provider coverage. App provisioning
and product restrictions still apply; see [social setup](SOCIAL.md).

| Platform | Operations / target | Integration discovery required |
| --- | --- | --- |
| YouTube | Implemented verification, owned metadata/linking and supervised video upload/reconciliation; short-form classification unverified | Phase 9 live acceptance, OAuth/API review, quotas, privacy restrictions and Shorts eligibility |
| X | Implemented native PKCE, identity, weighted text/video, receipts/readback | Approved exact loopback redirect/public client, write/media scopes and paid API access |
| TikTok | Implemented Desktop PKCE and video Direct Post, fresh creator/consent review | Developer-owned app secret, public creator-app eligibility/product/audit; unaudited private/SELF_ONLY restrictions. No text-only post |
| LinkedIn | Implemented member/authorized organization text-video, fresh ACL checks/receipts | LinkedIn-enabled native PKCE, products/scopes/roles, REST 202610. Member readback and remote revoke unavailable |

All implemented connectors join the [Phase 9 acceptance matrix](ACCEPTANCE.md)
after Phase 8 hardening, packaging and feature completion. Local regressions and
controlled-provider checks continue; they do not establish live provider acceptance.
No secrets were supplied and no live OAuth tests were run. Release authorization
requires Phase 9 completion and a separate explicit request.

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
