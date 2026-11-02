# Security reporting

Only the latest preview source is in scope during early development. The
local workspace exposes an authenticated loopback-only API and an internal
Windows DPAPI vault. The YouTube Desktop OAuth/PKCE connection slice adds a
single-use state-bound loopback callback, vault-backed credentials, identity/channel
verification, refresh and disconnect. Supervised publishing, IANA local scheduling,
scoped AI/MCP and official X/LinkedIn/TikTok adapters are implemented. Every actual
publication requires per-payload/per-occurrence human approval; memory/model output
is never authority. Live acceptance remains Phase 9. Demo accounts have no provider
credentials. See [data](docs/DATA.md) and [packaging](docs/PACKAGING.md).

For a vulnerability, use the repository's **Security → Advisories → Report a
vulnerability** private reporting flow when it is enabled. If that option is
unavailable, open a minimal issue requesting a private reporting channel without
including exploit details or sensitive data. Maintainers should enable private
reporting before the first public preview publication.

Never include OAuth tokens, CLI credentials, private media, personal account
data or credential-vault exports in issues, logs or attachments. A useful private
report includes the affected version/commit, reproduction steps, expected impact
and sanitized diagnostics. No response-time guarantee is offered at this stage.
