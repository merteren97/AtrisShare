# MCP server boundary — planned

Use the official MCP SDK when Phase 4 begins. Start with local stdio and a
project/account-scoped launch grant, then evaluate other transports if needed.
Tool arguments are validated at runtime and checked against scoped artifact
access. Clients get structured progress, results and cancellation.

Planned tool vocabulary is exported as `MEDIA_TOOL_NAMES`. Tools may propose
edits and request a human publication approval. There is no `publish` or
`approve` tool and no arbitrary shell/FFmpeg execution tool. OAuth tokens are
never supplied in tool results, prompts or CLI arguments.

MCP is the interoperability layer. FFmpeg/media workers perform actual editing;
MCP itself is not a video processing engine. No MCP transport exists yet.
