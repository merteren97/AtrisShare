# AI runtime bridge — planned

Adapt AtrisAgent's runtime-host boundary for model discovery, CLI profiles,
structured events, cancellation and MCP configuration. Candidate runtimes:
Codex CLI, Claude Code, OpenCode and Antigravity CLI. Availability must be
probed; model names and capabilities must not be fabricated.

No sibling source import, symlink or local dependency is present in this
template. Extract/adapt the required pieces in Phase 4 with attribution and
focused tests. CLI login remains owned by the official runtime.

AI sessions carry explicit account + project scope. They can propose edits,
render previews and request approval; they cannot approve or publish. The MCP
boundary also supports compatible external AI clients without requiring an
AtrisAgent installation. See [architecture](../../docs/ARCHITECTURE.md).
