# Walkie-Talkie

Inter-session messaging for AI coding agents. Built as a Claude Code plugin.

## How to Use

You have MCP tools for all walkie-talkie operations. Use ONLY these MCP tools. Do NOT use curl, Bash, or any other method to interact with the messaging system.

### Joining

Use the `join` MCP tool to register this session with a name and role. You MUST do this before sending or receiving messages.

### Sending Messages

Use the `send` MCP tool to message a specific session, or `broadcast` to message all sessions.

### Receiving Messages

Messages from other sessions arrive automatically as `<channel source="walkie-talkie" from="...">` tags. You do not need to poll - they appear in real-time.

### Other Tools

- `list_sessions` - see who's online
- `subscribe` - subscribe to a topic
- `publish` - publish to a topic

## MCP Tools Reference

| Tool | Purpose |
|------|---------|
| `join` | Register with a name, role, and optional topics. MUST be called first. |
| `send` | Send message to a named session (`to`, `text`, optional `reply_to`) |
| `broadcast` | Send message to all sessions (`text`) |
| `list_sessions` | List connected sessions and roles |
| `subscribe` | Subscribe to a topic |
| `publish` | Publish to a topic |

## Rules

- ALWAYS use MCP tools for all operations. Never use curl or Bash to interact with the messaging system.
- Call `join` before any other tool.
- Reply to incoming messages using `send` with the sender's name as `to`.
