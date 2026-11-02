# Social connector boundary

Implemented adapters provide account connection, capability discovery, destination verification,
quota/rate-limit handling, media upload and publish-result reconciliation per
platform. YouTube, X, LinkedIn and TikTok remain subject to official app access.
Use official APIs/OAuth and preserve provider subject + destination identity.

All publication calls are internal to the trusted publisher, after a fresh
identity/scope check and consumption of a matching human approval. Cross-posts
are separate destination jobs, with independent success/failure state.

Current `SocialConnector` is a publishing TypeScript port only. The first YouTube
authentication/publishing adapter is implemented in `services/local-api/src/youtube*.ts`;
additional adapters live in `social*.ts`. Both have controlled-provider tests and
human approval gates; live acceptance is pending. See [social setup](../../docs/SOCIAL.md).
See [platform status](../../docs/PLATFORMS.md).
