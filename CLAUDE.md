# Walkie-Talkie

Inter-session messaging for AI coding agents. Built as a Claude Code plugin.

## How to Use

You have MCP tools for all walkie-talkie operations. Use ONLY these MCP tools. Do NOT use curl, Bash, or any other method to interact with the messaging system.

### Joining

Use the `join` MCP tool to register this session with a name, role, and optional channels. You MUST do this before sending or receiving messages.

### Sending Messages

- `send` - message a specific session
- `broadcast` - message all sessions
- `publish` - message all subscribers of a channel

### Receiving Messages

Messages from other sessions arrive automatically as `<channel source="walkie-talkie" from="...">` tags. You do not need to poll - they appear in real-time.

### Channels

Channels are group frequencies. Subscribe to receive targeted messages.

- `subscribe` - tune into a channel
- `unsubscribe` - leave a channel
- `publish` - send to all channel subscribers

You can also subscribe to channels when joining: `join(name, role, channels: ["my-project"])`.

## MCP Tools Reference

| Tool | Purpose |
|------|---------|
| `join` | Register with a name, role, and optional channels. MUST be called first. |
| `send` | Send message to a named session (`to`, `text`, optional `reply_to`) |
| `broadcast` | Send message to all sessions (`text`) |
| `list_sessions` | List connected sessions, roles, and channels |
| `update_role` | Update this session's role description (`role`) |
| `subscribe` | Subscribe to a channel (`channel`) |
| `unsubscribe` | Unsubscribe from a channel (`channel`) |
| `publish` | Publish to a channel (`channel`, `text`) |

## Rules

- ALWAYS use MCP tools for all operations. Never use curl or Bash to interact with the messaging system.
- Call `join` before any other tool.
- Reply to incoming messages using `send` with the sender's name as `to`.
