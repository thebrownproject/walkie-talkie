---
name: list
description: "List all sessions connected to Walkie-Talkie. Use when the user wants to see who's online, check connected sessions, or view the session registry."
---

# List Sessions

Use the `list_sessions` MCP tool to fetch all connected sessions from the broker.

Display as a formatted list showing:
- Session name
- Runtime (claude-code, codex, script, etc.)
- Role
- Last seen timestamp

If no sessions are online, say so.
