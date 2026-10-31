# Local API boundary — planned

Trusted loopback service for the desktop, worker coordinator and scoped MCP
clients. Own runtime input validation, session authentication, account context,
repository access, audit events and approval issuance/consumption.

The publisher executes only after it resolves the exact destination, verifies
current permissions and checks a still-valid approval bound to the complete
immutable payload. A client-provided `AuthorizedPublication` object is not
proof of authorization; TypeScript interfaces are not a security boundary.

No HTTP server or API endpoints are implemented in the foundation preview.
