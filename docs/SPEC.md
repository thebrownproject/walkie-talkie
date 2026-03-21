# Walkie-Talkie

Lightweight inter-session communication for AI coding agents. Sessions register, discover each other, and exchange messages through a local broker.

## Problem

Developers run multiple AI coding sessions simultaneously (Claude Code, Codex, Cursor, etc.) across different terminals. These sessions are completely isolated — they can't discover each other, share context, or coordinate work. The result:

- Duplicate work across sessions
- Manual copy-pasting of context between terminals
- No awareness of what other sessions are doing
- Conflicting changes to shared files
- Developer becomes the message bus, relaying information between agents

Existing solutions are either too heavy (Paperclip — org charts, budgets, governance) or don't solve communication (Superset, cmux, Amux — manage sessions visually but sessions still can't talk).

Claude Code's native Agent Teams is closest but requires one session to spawn the others, is locked to a single project, and doesn't persist across restarts.

## Solution

A local message broker + channel plugin that lets any AI coding session:

1. **Register** — announce itself with a name and role
2. **Discover** — see what other sessions are online
3. **Message** — send direct messages or broadcast to all
4. **Subscribe** — listen to channels for scoped coordination
5. **Respond** — reply to messages from other sessions (bidirectional)

Runtime-agnostic. If it can make HTTP requests, it can join the network.

## Design Principles

1. **Lightweight** — broker is ~150 lines, channel plugin is ~80 lines
2. **Zero config** — start broker, join from any session, done
3. **Runtime-agnostic** — Claude Code, Codex, Cursor, scripts, anything with HTTP
4. **No hierarchy** — no lead/teammate, no org charts, just peers
5. **Local-first** — localhost only, no cloud, no auth complexity
6. **Ephemeral** — sessions come and go, broker handles cleanup
7. **Channel-native** — built on Claude Code's MCP channel architecture (same pattern as the Telegram plugin)

## Prior Art

| Tool | What it does | Gap |
|------|-------------|-----|
| Agent Teams (Claude Code) | One session spawns teammates, file-based mailbox | Locked to one project, lead must spawn others, no cross-runtime |
| Postal MCP | SQLite message queue between agents | No discovery, no channels, no registry |
| Paperclip | Full org chart, budgets, governance | Way too heavy for "let my terminals talk" |
| Superset / cmux / Amux | Manage and visualise multiple sessions | Sessions still can't communicate |
| Conductor | GitHub-native task orchestration | Tied to GitHub Issues, not lightweight messaging |

## Architecture

```
┌──────────────────────────────────────────┐
│              WALKIE-TALKIE               │
│            BROKER (Bun HTTP)             │
│           localhost:9900                 │
│                                          │
│  ┌─────────────┐  ┌──────────────────┐  │
│  │  Registry    │  │  Message Store   │  │
│  │              │  │                  │  │
│  │  name        │  │  inbox/frontend  │  │
│  │  role        │  │  inbox/backend   │  │
│  │  runtime     │  │  inbox/tests     │  │
│  │  joined_at   │  │                  │  │
│  │  last_seen   │  │  channels/       │  │
│  │  subscriptions│ │    api-changes   │  │
│  └─────────────┘  │    deploys        │  │
│                    └──────────────────┘  │
└───────┬──────────┬──────────┬───────────┘
        │          │          │
   ┌────┴───┐ ┌───┴────┐ ┌───┴────┐
   │Channel │ │Channel │ │  HTTP  │
   │Plugin  │ │Plugin  │ │ Client │
   │(MCP)   │ │(MCP)   │ │(curl)  │
   └───┬────┘ └───┬────┘ └───┬────┘
       │          │          │
   Claude     Claude      Codex
   Code #1    Code #2    / Script
   (frontend) (backend)  (tests)
```

### How it connects to Claude Code

The channel plugin follows the exact same architecture as the official Telegram channel plugin (confirmed by reading the source at `~/.claude/plugins/cache/claude-plugins-official/telegram/0.0.1/server.ts`):

1. MCP server declares `capabilities: { tools: {}, experimental: { 'claude/channel': {} } }`
2. Connects to Claude Code via `StdioServerTransport` (JSON-RPC over stdio)
3. Pushes incoming messages via `mcp.notification({ method: 'notifications/claude/channel', params: { content, meta } })`
4. Claude receives messages as `<channel source="walkie-talkie" from="..." ...>content</channel>` tags
5. Claude responds by calling exposed MCP tools (send, broadcast, etc.)

The only difference from Telegram: instead of grammy polling Telegram's getUpdates API, we use a simple `setInterval` + `fetch` to poll the local broker.

### Components

#### 1. Broker (`broker.ts`)

Standalone Bun HTTP server. Runs independently of any coding session. Manages the registry and message routing.

**State:**
- In-memory registry of connected sessions
- Per-session message inbox (array of pending messages)
- Channel subscriptions (map of channel -> subscriber names)
- Heartbeat tracking for stale session cleanup

**Endpoints:**

```
POST   /register              Register a session (or force re-register)
DELETE /register/:name         Unregister a session
GET    /registry               List all active sessions
POST   /send                   Send message to a specific session
POST   /broadcast              Send message to all sessions (excludes sender)
GET    /poll/:name             Poll for new messages (returns immediately)
POST   /subscribe              Subscribe to a channel
DELETE /subscribe              Unsubscribe from a channel
POST   /publish                Publish to a channel (routes to subscribers' inboxes)
GET    /health                 Broker health check
```

**Data Structures:**

```typescript
// Session registration
interface Session {
  name: string           // "frontend", "backend", "tests"
  role: string           // "building React components"
  runtime: string        // "claude-code", "codex", "cursor", "script"
  joined_at: string      // ISO timestamp
  last_seen: string      // Updated on each poll
  subscriptions: string[] // Channel subscriptions
}

// Message
interface Message {
  id: string             // crypto.randomUUID()
  from: string           // Sender session name (must be registered)
  to: string | null      // Recipient name, null for broadcast/channel
  content: string        // Message body
  channel?: string       // If published to a channel
  timestamp: string      // ISO timestamp
  reply_to?: string      // Message ID this is replying to
}

// Health response
interface Health {
  status: "ok"
  uptime_seconds: number
  session_count: number
  total_queued_messages: number
}
```

**Behaviour:**
- Sessions that haven't polled in 60 seconds are marked stale
- Sessions that haven't polled in 5 minutes are automatically unregistered (inbox dropped)
- Broker starts on port 9900 by default (configurable via `WALKIE_TALKIE_PORT`)
- Messages persist in inbox until polled (max 100 per session, FIFO overflow)
- Broker logs to stderr, not stdout
- `POST /register` with an existing name and `force: true` evicts the stale session and re-registers (handles crash/reconnect)
- `POST /send` validates that `from` is a registered session (rejects spoofed senders)
- `POST /broadcast` excludes sender from delivery (sessions don't receive their own broadcasts)
- `POST /publish` routes to channel subscribers' inboxes (same as broadcast but scoped to channels)

**Note on broadcast vs channels:** Broadcast delivers to all sessions. Channels deliver to subscribers only. Both use the same inbox mechanism. If you find yourself subscribing all sessions to a channel, just use broadcast. Channels are for scoped coordination (e.g. only frontend and backend care about "api-changes", tests don't).

#### 2. Channel Plugin (`plugin/`)

Claude Code channel plugin (MCP server). Each Claude Code session runs one instance. Handles registration, polling, and message delivery.

**Structure:**
```
plugin/
├── .claude-plugin/
│   └── plugin.json
├── .mcp.json
├── server.ts            # MCP server + broker client
├── package.json         # @modelcontextprotocol/sdk, grammy not needed
└── skills/
    ├── start/
    │   └── SKILL.md     # /walkie-talkie:start
    ├── join/
    │   └── SKILL.md     # /walkie-talkie:join <name>
    ├── list/
    │   └── SKILL.md     # /walkie-talkie:list
    ├── send/
    │   └── SKILL.md     # /walkie-talkie:send <target> <msg>
    └── broadcast/
        └── SKILL.md     # /walkie-talkie:broadcast <msg>
```

**MCP Server Core (follows Telegram plugin pattern exactly):**

```typescript
#!/usr/bin/env bun
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const BROKER = process.env.WALKIE_TALKIE_BROKER ?? 'http://127.0.0.1:9900'
let NAME = process.env.WALKIE_TALKIE_NAME ?? `session-${Date.now()}`
const ROLE = process.env.WALKIE_TALKIE_ROLE ?? ''

const mcp = new Server(
  { name: 'walkie-talkie', version: '1.0.0' },
  {
    capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
    instructions: [
      'Messages from other coding sessions arrive as <channel source="walkie-talkie" from="..." message_id="...">.',
      'Reply with the send tool, passing the sender name as "to".',
      'Use list_sessions to see who is online.',
      'Use broadcast to message all sessions.',
    ].join('\n'),
  },
)

// ... tool handlers (join, send, broadcast, list_sessions, subscribe, publish) ...

await mcp.connect(new StdioServerTransport())

// Register with broker (retry up to 3 times on failure when a name is preset)
let registered = false
for (let i = 0; i < 3; i++) {
  try {
    await fetch(`${BROKER}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: NAME, role: ROLE, runtime: 'claude-code', force: true }),
    })
    registered = true
    process.stderr.write(`walkie-talkie: registered as "${NAME}"\n`)
    break
  } catch {
    await new Promise(r => setTimeout(r, 2000))
  }
}
if (!registered) process.stderr.write(`walkie-talkie: broker not available, running without messaging\n`)

// Poll loop — identical pattern to grammy's getUpdates but against local broker
setInterval(async () => {
  try {
    const res = await fetch(`${BROKER}/poll/${NAME}`)
    if (!res.ok) return
    const messages = await res.json()
    for (const msg of messages) {
      await mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content: msg.content,
          meta: {
            source: 'walkie-talkie',
            from: msg.from,
            message_id: msg.id,
            ...(msg.channel ? { channel: msg.channel } : {}),
            ...(msg.reply_to ? { reply_to: msg.reply_to } : {}),
          },
        },
      })
    }
  } catch {
    // Broker unavailable — silently retry next interval
  }
}, 2000)
```

**Key differences from Telegram plugin:**
- No grammy dependency (simple fetch polling replaces Telegram's getUpdates)
- No access control (localhost trust model — no pairing, no allowlists)
- No photo/file handling (text messages only)
- No message chunking (agent-to-agent messages are short)
- ~80 lines total vs Telegram's ~600

**Exposed MCP Tools:**

```typescript
tools: [
  {
    name: 'send',
    description: 'Send a message to another session',
    inputSchema: {
      properties: {
        to: { type: 'string', description: 'Target session name' },
        text: { type: 'string', description: 'Message content' },
        reply_to: { type: 'string', description: 'Message ID to reply to (optional)' }
      },
      required: ['to', 'text']
    }
  },
  {
    name: 'broadcast',
    description: 'Send a message to all connected sessions',
    inputSchema: {
      properties: {
        text: { type: 'string', description: 'Message content' }
      },
      required: ['text']
    }
  },
  {
    name: 'list_sessions',
    description: 'List all connected sessions and their roles',
    inputSchema: { properties: {}, required: [] }
  },
  {
    name: 'subscribe',
    description: 'Subscribe to a channel for targeted updates',
    inputSchema: {
      properties: {
        channel: { type: 'string', description: 'Channel name to subscribe to' }
      },
      required: ['channel']
    }
  },
  {
    name: 'publish',
    description: 'Publish a message to a channel',
    inputSchema: {
      properties: {
        channel: { type: 'string', description: 'Channel to publish to' },
        text: { type: 'string', description: 'Message content' }
      },
      required: ['channel', 'text']
    }
  }
]
```

#### 3. HTTP Client (for non-Claude runtimes)

Any runtime that can make HTTP requests can participate. For Codex or scripts:

```bash
# Register
curl -X POST localhost:9900/register \
  -H "Content-Type: application/json" \
  -d '{"name":"tests","role":"running test suite","runtime":"codex"}'

# Poll for messages
curl localhost:9900/poll/tests

# Send a message
curl -X POST localhost:9900/send \
  -H "Content-Type: application/json" \
  -d '{"from":"tests","to":"backend","content":"All 47 tests passing"}'

# List who's online
curl localhost:9900/registry
```

No SDK needed. No dependencies. Just HTTP.

## Message Flow Examples

### Example 1: Frontend asks backend about API schema

```
Session "frontend" Claude calls:
  send({ to: "backend", text: "What's the auth endpoint schema?" })
    ↓
Channel plugin POSTs to broker:
  POST /send { from: "frontend", to: "backend", content: "What's the auth endpoint schema?" }
    ↓
Broker validates "frontend" is registered, stores in backend's inbox
    ↓
Session "backend" channel plugin polls:
  GET /poll/backend → receives message
    ↓
Plugin emits notification → Claude in backend sees:
  <channel source="walkie-talkie" from="frontend" message_id="msg-1">
  What's the auth endpoint schema?
  </channel>
    ↓
Claude in backend responds by calling:
  send({ to: "frontend", text: "POST /api/auth/login { email: string, password: string } → { token: string, user: User }", reply_to: "msg-1" })
    ↓
Frontend Claude receives the reply and continues building
```

### Example 2: Test runner broadcasts failure

```
Session "tests" (Codex via curl) calls:
  POST /broadcast { from: "tests", content: "FAILING: UserService.create() — unique constraint violation on email" }
    ↓
Broker copies message to all inboxes except "tests"
    ↓
Both "frontend" and "backend" Claudes see the broadcast
Backend Claude recognises it's a backend issue and starts fixing
Frontend Claude notes the issue but continues its work
```

### Example 3: Channel-based coordination

```
Backend subscribes to "deploy" channel
Frontend subscribes to "deploy" channel
(Tests does not subscribe)

DevOps script publishes:
  POST /publish { from: "deploy-bot", channel: "deploy", content: "v2.3.1 deployed to staging" }
    ↓
Frontend and backend receive the notification (they're subscribed)
Tests does not receive it (not subscribed)
```

## Security Model

**Threat model:** Single developer, localhost only. Not designed for multi-user or networked deployment.

- Broker binds to 127.0.0.1 only (not 0.0.0.0)
- No authentication (localhost trust model)
- No encryption (local traffic only)
- Session names are self-reported (no verification)
- Sender validation: broker rejects /send from unregistered sessions
- Message content is plain text (no execution, no code injection)
- Channel plugin gates on source="walkie-talkie" to prevent confusion with other channels

**Future consideration:** If ever exposed beyond localhost, add API key per session, message signing, rate limiting.

## Tech Stack

- **Broker:** Bun (HTTP server, fast startup, zero dependencies)
- **Channel Plugin:** Bun, @modelcontextprotocol/sdk
- **Storage:** In-memory (Map/Array). Optional SQLite in Phase 5.
- **Protocol:** HTTP/JSON (broker API), JSON-RPC over stdio (MCP)

## File Structure

```
walkie-talkie/
├── SPEC.md                    # This file
├── broker/
│   ├── server.ts              # Bun HTTP server (~150 lines)
│   └── package.json           # Zero dependencies
├── plugin/
│   ├── .claude-plugin/
│   │   └── plugin.json
│   ├── .mcp.json
│   ├── server.ts              # MCP channel server (~80 lines)
│   ├── package.json           # @modelcontextprotocol/sdk
│   └── skills/
│       ├── start/
│       │   └── SKILL.md
│       ├── join/
│       │   └── SKILL.md
│       ├── list/
│       │   └── SKILL.md
│       ├── send/
│       │   └── SKILL.md
│       └── broadcast/
│           └── SKILL.md
├── examples/
│   ├── codex-client.sh        # Bash example for Codex/scripts
│   └── python-client.py       # Python example
└── README.md
```

## Tasks

### Phase 1: Broker (MVP)

- [ ] **T1: Scaffold broker project**
  - Create `broker/` directory with `package.json` and `server.ts`
  - Bun project, zero dependencies
  - Add startup script with configurable port (default 9900)

- [ ] **T2: Implement session registry**
  - In-memory Map<string, Session>
  - POST /register — add session (name, role, runtime). If name exists and `force: true`, evict stale session and re-register. If name exists without force, reject with 409.
  - DELETE /register/:name — remove session and drop its inbox
  - GET /registry — list all active sessions with metadata

- [ ] **T3: Implement message routing**
  - Per-session inbox as array of Message objects
  - POST /send — validate `from` is registered, route message to target session's inbox. Return 404 if target not found.
  - POST /broadcast — copy message to all inboxes except sender
  - GET /poll/:name — return and clear inbox (immediate return, no long-poll). Returns `[]` if empty.
  - Message IDs via crypto.randomUUID()
  - Inbox cap: 100 messages per session (drop oldest on overflow)

- [ ] **T4: Implement channel pub/sub**
  - Map<string, Set<string>> for channel -> subscriber names
  - POST /subscribe — add session to a channel
  - DELETE /subscribe — remove session from a channel
  - POST /publish — validate `from` is registered, route message to all channel subscribers' inboxes
  - Auto-unsubscribe on session unregister

- [ ] **T5: Implement heartbeat and cleanup**
  - Update last_seen on each /poll request
  - Background interval (every 30s): auto-unregister sessions that haven't polled in 5 minutes (drop their inbox and subscriptions)
  - GET /health — return `{ status: "ok", uptime_seconds, session_count, total_queued_messages }`

- [ ] **T6: Test broker with curl**
  - Start broker with `bun run broker/server.ts`
  - Test each endpoint as it's built:
    - Register two sessions, verify /registry
    - Send message between them, verify /poll returns it
    - Test broadcast (verify sender excluded)
    - Test channel subscribe/publish
    - Test force re-register
    - Test /health response
    - Verify stale cleanup (register, don't poll, wait for cleanup)

### Phase 2: Channel Plugin

- [ ] **T7: Validate channel notification API (spike)**
  - Build minimal MCP server with `experimental: { 'claude/channel': {} }`
  - Emit a test `mcp.notification({ method: 'notifications/claude/channel', ... })` on a timer
  - Load in Claude Code via `--plugin-dir`
  - Confirm Claude receives `<channel>` tag
  - This is a 30-minute validation before committing to the full plugin

- [ ] **T8: Scaffold channel plugin**
  - Create `plugin/` directory structure
  - `.claude-plugin/plugin.json` with name, description, version
  - `.mcp.json` pointing to server.ts via bun
  - `package.json` with @modelcontextprotocol/sdk dependency
  - `bun install`

- [ ] **T9: Implement MCP server + broker client**
  - Create Server with `claude/channel` capability and tools capability
  - Set instructions explaining the `<channel>` tag format
  - Connect via StdioServerTransport
  - Accept session name via `WALKIE_TALKIE_NAME` env var or auto-generate
  - On startup: POST /register to broker (retry up to 10 times with 2s delay)
  - Poll loop: `setInterval` + `fetch` to GET /poll/:name every 2 seconds
  - On each message: emit `mcp.notification` with content and meta
  - Handle broker unavailable gracefully (log to stderr, silently retry)

- [ ] **T10: Implement MCP tools**
  - ListToolsRequestSchema handler: return send, broadcast, list_sessions, subscribe, publish
  - CallToolRequestSchema handler: route to broker HTTP endpoints
  - Return confirmation text for each tool call
  - Error handling: broker offline, target session not found, unregistered sender

- [ ] **T11: End-to-end test**
  - Start broker
  - Open two Claude Code sessions with the plugin loaded
  - Send a message from session A to session B
  - Verify B receives it as a `<channel>` notification
  - Verify B can reply back via the send tool
  - Verify list_sessions shows both sessions
  - Test broadcast delivery

### Phase 3: CLI Skills

- [ ] **T12: Create /walkie-talkie:start skill**
  - Check if broker is running (GET /health)
  - If running: display status (uptime, session count)
  - If not: display instructions to start broker manually (`bun run broker/server.ts &`)
  - Note: auto-spawning background processes is cross-platform tricky. Keep it simple — just check and instruct.

- [ ] **T13: Create /walkie-talkie:join skill**
  - Accept name and optional role arguments
  - Register with broker via POST /register
  - Confirm registration and show who else is online

- [ ] **T14: Create /walkie-talkie:list skill**
  - Fetch registry from broker
  - Display formatted table of sessions (name, role, runtime, joined, last_seen)

- [ ] **T15: Create /walkie-talkie:send and /walkie-talkie:broadcast skills**
  - /send <target> <message> — send direct message
  - /broadcast <message> — send to all
  - Display confirmation with message ID

### Phase 4: Cross-Runtime Support & Docs

- [ ] **T16: Create bash example client**
  - Shell script demonstrating register, poll, send via curl
  - Can be sourced into any bash-based agent (Codex CLI)
  - Include polling loop example

- [ ] **T17: Create Python example client**
  - Simple requests-based client class
  - Register, poll, send, broadcast methods
  - Can be imported into any Python agent

- [ ] **T18: Write README**
  - Quick start (3 commands to get two sessions talking)
  - Architecture diagram
  - API reference for broker endpoints
  - Examples for Claude Code, Codex, scripts
  - Comparison with alternatives (Agent Teams, Postal MCP, Paperclip)

### Phase 5: Polish (only after adoption)

- [ ] **T19: Add optional SQLite persistence to broker**
  - Persist registry and message history across broker restarts
  - Flag: `--persist` to enable (default: in-memory only)

- [ ] **T20: Add message threading**
  - reply_to field links messages into threads
  - GET /thread/:message_id returns full conversation chain

- [ ] **T21: Add session status/presence**
  - Sessions can set status: "working", "idle", "blocked", "reviewing"
  - Status visible in registry listing
  - Optional: status change notifications to other sessions

- [ ] **T22: Package for distribution**
  - Publish broker as standalone bun package
  - Publish plugin to Claude Code plugin marketplace
  - GitHub repo with CI (lint, type-check)

## Known Limitations

1. **No message persistence across broker restarts** — in-memory only in Phase 1-4. Messages in flight are lost if broker dies.
2. **No turn-taking protocol** — two AI sessions messaging each other asynchronously can have messages cross in transit. The reply_to field helps but doesn't solve interleaved conversations.
3. **Notifications during active response** — if Claude is mid-task when a message arrives, it may buffer until the current turn completes. This is how Telegram works too and is acceptable.
4. **No message persistence across client crashes** — if a session crashes and is force re-registered or the broker restarts, in-flight recovery is still best-effort rather than durable storage.
5. **Single developer scope** — localhost only, no multi-user, no auth. By design.
