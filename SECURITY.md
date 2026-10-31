# Security reporting

Only the latest preview source is in scope during early development. The
foundation preview has no live social connectors, credential storage or server.

For a vulnerability, use the repository's **Security → Advisories → Report a
vulnerability** private reporting flow when it is enabled. If that option is
unavailable, open a minimal issue requesting a private reporting channel without
including exploit details or sensitive data. Maintainers should enable private
reporting before the first public preview publication.

Never include OAuth tokens, CLI credentials, private media, personal account
data or credential-vault exports in issues, logs or attachments. A useful private
report includes the affected version/commit, reproduction steps, expected impact
and sanitized diagnostics. No response-time guarantee is offered at this stage.
