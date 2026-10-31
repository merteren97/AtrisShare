# Social connector boundary — planned

Implement account connection, capability discovery, destination verification,
quota/rate-limit handling, media upload and publish-result reconciliation per
platform. Start with YouTube, then X, LinkedIn and TikTok subject to API access.
Use official APIs/OAuth and preserve provider subject + destination identity.

All publication calls are internal to the trusted publisher, after a fresh
identity/scope check and consumption of a matching human approval. Cross-posts
are separate destination jobs, with independent success/failure state.

Current `SocialConnector` is a publishing TypeScript port only. The first YouTube
authentication adapter is implemented in `services/local-api/src/youtube*.ts`,
with controlled-provider tests and live acceptance pending; it cannot publish.
See [platform status](../../docs/PLATFORMS.md).
