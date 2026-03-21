# Walkie-Talkie

Lightweight inter-session messaging for AI coding agents. Let your Claude Code sessions talk to each other.

## Quick Start

```bash
# 1. Start the broker (runs in background)
bun walkie-talkie/broker.ts &

# 2. In terminal 1 — start Claude Code with the plugin
WALKIE_TALKIE_NAME=frontend claude --plugin-dir ./walkie-talkie

# 3. In terminal 2 — start another session
WALKIE_TALKIE_NAME=backend claude --plugin-dir ./walkie-talkie
```

Now your sessions can message each other. In the frontend session, Claude can call:

```
send({ to: "backend", text: "What's the API schema for /users?" })
```

And the backend session receives it as a push notification and can reply.

## How It Works

```
Broker (localhost:9900)     ← standalone HTTP server
  ↕                         ← simple polling (every 2s)
Plugin (MCP server)         ← runs inside each Claude Code session
  ↕                         ← stdio (JSON-RPC)
Claude Code                 ← receives messages as <channel> tags
```

1. **Broker** runs on localhost:9900. Manages session registry and message routing.
2. **Plugin** runs inside each Claude Code session as an MCP channel server.
3. Plugin polls the broker for messages and pushes them into Claude via `mcp.notification()`.
4. Claude receives messages as `<channel source="walkie-talkie" from="backend">` tags.
5. Claude responds using the `send` tool, which POSTs back to the broker.

## Installation

**From GitHub marketplace:**

```bash
/plugin marketplace add thebrownproject/walkie-talkie
/plugin install walkie-talkie@walkie-talkie
```

**Local development:**

```bash
git clone https://github.com/thebrownproject/walkie-talkie
cd walkie-talkie && bun install
```

## Commands

| Command | Description |
|---------|-------------|
| `/walkie-talkie:start` | Check if broker is running, show status |
| `/walkie-talkie:join <name>` | Register this session with a name |
| `/walkie-talkie:list` | Show all connected sessions |
| `/walkie-talkie:send <target> <msg>` | Send a direct message |
| `/walkie-talkie:broadcast <msg>` | Message all sessions |

## MCP Tools

These are available to Claude automatically when the plugin is loaded:

| Tool | Description |
|------|-------------|
| `send` | Send message to a named session |
| `broadcast` | Send message to all sessions |
| `list_sessions` | List connected sessions and roles |
| `subscribe` | Subscribe to a topic |
| `publish` | Publish to a topic |

## Broker API

All endpoints on `http://127.0.0.1:9900`:

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /register | Register a session |
| DELETE | /register/:name | Unregister |
| GET | /registry | List sessions |
| POST | /send | Direct message |
| POST | /broadcast | Broadcast |
| GET | /poll/:name | Poll inbox |
| POST | /subscribe | Subscribe to topic |
| DELETE | /subscribe | Unsubscribe |
| POST | /publish | Publish to topic |
| GET | /health | Broker status |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `WALKIE_TALKIE_NAME` | `session-{timestamp}` | Session name |
| `WALKIE_TALKIE_ROLE` | `""` | Session role description |
| `WALKIE_TALKIE_BROKER` | `http://127.0.0.1:9900` | Broker URL |
| `WALKIE_TALKIE_PORT` | `9900` | Broker port (broker.ts only) |

## Cross-Runtime

The broker is just HTTP. Any runtime can participate:

```bash
# Register from Codex or a script
curl -X POST localhost:9900/register \
  -H "Content-Type: application/json" \
  -d '{"name":"tests","role":"test runner","runtime":"codex"}'

# Poll for messages
curl localhost:9900/poll/tests

# Send a message
curl -X POST localhost:9900/send \
  -H "Content-Type: application/json" \
  -d '{"from":"tests","to":"backend","content":"All tests passing"}'
```

## License

MIT
