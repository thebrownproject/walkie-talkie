# Walkie-Talkie

Inter-session messaging for AI coding agents. Built as a Claude Code plugin with MCP server + skills.

## Architecture

Two components:

1. **Broker** (`broker.ts`) — Standalone Bun HTTP server on localhost:9900. Manages session registry and message routing. Runs independently of Claude Code sessions. Zero dependencies.

2. **Plugin** (`server.ts`) — MCP channel server that runs inside each Claude Code session. Polls the broker, pushes messages into Claude via `mcp.notification()`, exposes tools for sending. Follows the exact same pattern as the official Telegram channel plugin.

```
Broker (localhost:9900)
  ↕ HTTP
Plugin (MCP server, per-session)
  ↕ stdio (JSON-RPC)
Claude Code
```

## Plugin Structure

```
walkie-talkie/
├── .claude-plugin/
│   ├── plugin.json          # Plugin manifest
│   └── marketplace.json     # GitHub distribution
├── .mcp.json                # MCP server config
├── server.ts                # MCP channel server (~80 lines)
├── broker.ts                # Standalone broker (~150 lines)
├── package.json             # @modelcontextprotocol/sdk
├── skills/
│   ├── start/SKILL.md       # /walkie-talkie:start
│   ├── join/SKILL.md        # /walkie-talkie:join
│   ├── list/SKILL.md        # /walkie-talkie:list
│   ├── send/SKILL.md        # /walkie-talkie:send
│   └── broadcast/SKILL.md   # /walkie-talkie:broadcast
└── README.md
```

Same pattern as Telegram plugin (MCP server + skills in one package).

## Key Config Files

**plugin.json:**
```json
{
  "name": "walkie-talkie",
  "description": "Inter-session messaging for AI coding agents",
  "version": "1.0.0",
  "author": { "name": "Fraser Brown" },
  "keywords": ["messaging", "multi-agent", "channel", "orchestration"]
}
```

**.mcp.json:**
```json
{
  "mcpServers": {
    "walkie-talkie": {
      "command": "bun",
      "args": ["run", "--cwd", "${CLAUDE_PLUGIN_ROOT}", "--shell=bun", "--silent", "start"]
    }
  }
}
```

`${CLAUDE_PLUGIN_ROOT}` resolves to the plugin's install directory at runtime.

**package.json:**
```json
{
  "name": "walkie-talkie",
  "version": "1.0.0",
  "type": "module",
  "scripts": { "start": "bun install --no-summary && bun server.ts" },
  "dependencies": { "@modelcontextprotocol/sdk": "^1.0.0" }
}
```

## How the MCP Channel Works

The channel follows the exact pattern from the Telegram plugin source (`~/.claude/plugins/cache/claude-plugins-official/telegram/0.0.1/server.ts`):

1. Declare MCP server with channel capability:
   ```typescript
   const mcp = new Server(
     { name: 'walkie-talkie', version: '1.0.0' },
     {
       capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
       instructions: 'Messages from other sessions arrive as <channel source="walkie-talkie" from="...">...',
     },
   )
   ```

2. Connect via stdio:
   ```typescript
   await mcp.connect(new StdioServerTransport())
   ```

3. Push incoming messages as notifications:
   ```typescript
   await mcp.notification({
     method: 'notifications/claude/channel',
     params: {
       content: msg.content,
       meta: { source: 'walkie-talkie', from: msg.from, message_id: msg.id },
     },
   })
   ```

4. Claude receives as `<channel>` tags and responds via exposed MCP tools (send, broadcast, list_sessions).

The polling loop replaces grammy's Telegram getUpdates with a simple `setInterval` + `fetch` against the local broker.

## Broker API

All endpoints on `http://127.0.0.1:9900`:

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | /register | Register session (name, role, runtime). `force: true` to re-register after crash. |
| DELETE | /register/:name | Unregister session, drop inbox |
| GET | /registry | List all active sessions |
| POST | /send | Send message to specific session. Validates sender is registered. |
| POST | /broadcast | Send to all sessions (excludes sender) |
| GET | /poll/:name | Return and clear inbox. Immediate return, no long-poll. |
| POST | /subscribe | Subscribe session to a topic |
| DELETE | /subscribe | Unsubscribe from topic |
| POST | /publish | Publish message to topic subscribers |
| GET | /health | `{ status, uptime_seconds, session_count, total_queued_messages }` |

Stale sessions auto-unregister after 5 minutes of no polling.

## MCP Tools Exposed

| Tool | Purpose |
|------|---------|
| send | Send message to a named session (`to`, `text`, optional `reply_to`) |
| broadcast | Send message to all sessions (`text`) |
| list_sessions | List connected sessions and roles |
| subscribe | Subscribe to a topic |
| publish | Publish to a topic |

## Installation

**Development (local testing):**
```bash
# Start broker separately
bun broker.ts

# Load plugin in Claude Code
claude --plugin-dir ./walkie-talkie
```

**From GitHub marketplace:**
```bash
/plugin marketplace add thebrownproject/walkie-talkie
/plugin install walkie-talkie@walkie-talkie
```

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| WALKIE_TALKIE_NAME | `session-{timestamp}` | Session name for registration |
| WALKIE_TALKIE_ROLE | `""` | Description of what session is doing |
| WALKIE_TALKIE_BROKER | `http://127.0.0.1:9900` | Broker URL |

## Cross-Runtime Support

The broker is just HTTP. Any runtime can participate:

```bash
# Register from Codex/script
curl -X POST localhost:9900/register -H "Content-Type: application/json" \
  -d '{"name":"tests","role":"test runner","runtime":"codex"}'

# Poll for messages
curl localhost:9900/poll/tests

# Send a message
curl -X POST localhost:9900/send -H "Content-Type: application/json" \
  -d '{"from":"tests","to":"backend","content":"All tests passing"}'
```

## Build Order

1. `broker.ts` — Bun HTTP server, zero deps, test with curl
2. Validate channel API — minimal MCP server spike (30 min)
3. `server.ts` — MCP channel server, polls broker, exposes tools
4. Plugin scaffolding — plugin.json, .mcp.json, package.json
5. Skills — SKILL.md files for CLI commands
6. End-to-end test — two Claude Code sessions talking
7. README and GitHub marketplace

## Design Decisions

- **No long-poll.** Simple 2-second interval polling (same as Telegram's approach via grammy). Long-poll adds complexity for negligible benefit in AI-to-AI messaging.
- **Broker runs separately.** Doesn't die when a Claude Code session ends. Start once, all sessions connect to it.
- **In-memory only (v1).** No SQLite, no persistence. Sessions and messages are ephemeral. SQLite is Phase 5.
- **No auth.** Localhost trust model. Broker binds to 127.0.0.1 only.
- **Sender validation.** Broker rejects /send from unregistered sessions.
- **Force re-register.** Crashed sessions can rejoin with `force: true` without waiting for stale timeout.
- **Broadcast excludes sender.** Sessions don't receive their own broadcasts.

## Reference Implementation

The Telegram channel plugin is the canonical reference:
- Source: `~/.claude/plugins/cache/claude-plugins-official/telegram/0.0.1/server.ts`
- Pattern: MCP Server + StdioServerTransport + grammy polling + mcp.notification() + reply/react/edit tools
- Walkie-Talkie replaces grammy with fetch polling, removes access control/photo handling/chunking
