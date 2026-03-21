<p align="center">
  <img src="assets/logo.png" alt="Walkie-Talkie" width="300" />
</p>

<h1 align="center">Walkie-Talkie</h1>

<p align="center">
  Your Claude Code sessions can finally talk to each other.
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="#how-it-works">How It Works</a> ·
  <a href="#commands">Commands</a> ·
  <a href="#cross-runtime">Cross-Runtime</a> ·
  <a href="#event-bus">Event Bus</a>
</p>

## Quick Start

```bash
# 1. Clone the repo
git clone https://github.com/thebrownproject/walkie-talkie.git
cd walkie-talkie && bun install

# 2. Install the plugin in Claude Code
/plugin install thebrownproject/walkie-talkie

# 3. Start the broker
bun broker.ts &

# 4. Launch Claude Code with the channel enabled
claude --dangerously-load-development-channels plugin:walkie-talkie@walkie-talkie
```

Then tell Claude to join:

```
> join as frontend-developer "building the UI" my-project
```

That's it. Your session is on the network, subscribed to the `my-project` topic.

> **Tip:** Add an alias for convenience:
> ```bash
> alias wt-broker="bun ~/path/to/walkie-talkie/broker.ts &"
> alias wt="claude --dangerously-load-development-channels plugin:walkie-talkie@walkie-talkie"
> ```

## How It Works

```
Broker (localhost:9900)     ← standalone HTTP server, routes messages
  ↕                         ← polling every 2s
Plugin (MCP server)         ← runs inside each Claude Code session
  ↕                         ← stdio (JSON-RPC)
Claude Code                 ← receives messages as <channel> tags
```

1. **Broker** runs on localhost:9900. Manages session registry and message routing.
2. **Plugin** runs inside each Claude Code session as an MCP channel server.
3. Plugin polls the broker for messages and pushes them into Claude via channel notifications.
4. Claude receives messages inline and responds using MCP tools.

## Commands

| Command | Description |
|---------|-------------|
| `/walkie-talkie:start` | Check if broker is running, show status |
| `/walkie-talkie:join <name> [role] [topics...]` | Register this session with a name |
| `/walkie-talkie:list` | Show all connected sessions |
| `/walkie-talkie:send <target> <msg>` | Send a direct message |
| `/walkie-talkie:broadcast <msg>` | Message all sessions |

## Messaging

Three ways to send messages:

| Method | Scope | Use Case |
|--------|-------|----------|
| `send` | One session | Direct messages, questions, replies |
| `broadcast` | All sessions | Announcements, status updates |
| `publish` | Topic subscribers | Group coordination, scoped updates |

Messages support `reply_to` for threading conversations.

## Topics

Topics are group channels. Subscribe on join or anytime during a session.

```
> join as frontend-developer "building the UI" dashboard-team
```

Now `publish` to `dashboard-team` reaches only subscribers. Sessions can subscribe to multiple topics.

- `subscribe` / `unsubscribe` to join or leave topics
- `publish` sends to all topic subscribers (except sender)
- Topics are created implicitly when someone subscribes

## Cross-Runtime

The broker is plain HTTP. Any runtime can participate:

```bash
# Register
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

Works with Codex, scripts, cron jobs, Python, or anything that can make HTTP requests. No SDK needed.

## Event Bus

Walkie-Talkie doubles as a lightweight event bus. Any script can publish events that your Claude agents receive in real-time.

**Git hook** — notify agents when code is committed:
```bash
# .git/hooks/post-commit
MSG=$(git log -1 --pretty=format:"%h %s")
curl -s -X POST localhost:9900/publish \
  -H "Content-Type: application/json" \
  -d "{\"from\":\"git\",\"topic\":\"commits\",\"content\":\"New commit: $MSG\"}"
```

**Test watcher** — broadcast test results:
```bash
RESULT=$(bun test 2>&1 | tail -5)
curl -s -X POST localhost:9900/broadcast \
  -H "Content-Type: application/json" \
  -d "{\"from\":\"test-runner\",\"content\":\"$RESULT\"}"
```

**Deploy monitor** — publish deployment status:
```bash
curl -s -X POST localhost:9900/publish \
  -H "Content-Type: application/json" \
  -d '{"from":"deploy-bot","topic":"deploys","content":"v2.3.1 deployed to staging"}'
```

## Reliability

Messages are delivered reliably with an ack/nack protocol:

- Messages move to in-flight state when polled (not deleted)
- Server confirms delivery with `/ack` or returns failed messages with `/nack`
- Failed notifications are retried 3 times with exponential backoff
- 10-second safety timeout returns un-acked messages to the inbox
- Sessions auto-unregister on exit (immediate cleanup, no stale ghosts)

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `WALKIE_TALKIE_NAME` | _(none)_ | Pre-set session name (skips join) |
| `WALKIE_TALKIE_ROLE` | `""` | Session role description |
| `WALKIE_TALKIE_BROKER` | `http://127.0.0.1:9900` | Broker URL |
| `WALKIE_TALKIE_PORT` | `9900` | Broker port (broker.ts only) |

## Architecture

```
┌──────────────────────────────────────────┐
│           WALKIE-TALKIE BROKER           │
│            localhost:9900                │
│                                          │
│  ┌─────────────┐  ┌──────────────────┐  │
│  │  Registry    │  │  Message Store   │  │
│  │  + roles     │  │  + in-flight     │  │
│  │  + presence  │  │  + ack/nack      │  │
│  └─────────────┘  └──────────────────┘  │
└───────┬──────────┬──────────┬───────────┘
        │          │          │
   ┌────┴───┐ ┌───┴────┐ ┌───┴────┐
   │Channel │ │Channel │ │  HTTP  │
   │Plugin  │ │Plugin  │ │ Client │
   └───┬────┘ └───┬────┘ └───┬────┘
       │          │          │
   Claude     Claude      Codex
   Code #1    Code #2    / Script
```

## Security

Designed for single-developer, localhost use:

- Broker binds to `127.0.0.1` only
- No authentication (localhost trust model)
- Sender validation (rejects messages from unregistered sessions)
- Sessions auto-expire after 5 minutes of no polling

## License

MIT
