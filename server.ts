#!/usr/bin/env bun
/**
 * Walkie-Talkie Channel Plugin — MCP server for Claude Code.
 * Polls the broker and pushes messages into the session via channel notifications.
 * Exposes tools for sending messages to other sessions.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

const BROKER = process.env.WALKIE_TALKIE_BROKER ?? 'http://127.0.0.1:9900'
const NAME = process.env.WALKIE_TALKIE_NAME ?? `session-${Date.now()}`
const ROLE = process.env.WALKIE_TALKIE_ROLE ?? ''
const POLL_INTERVAL = 2000

const mcp = new Server(
  { name: 'walkie-talkie', version: '1.0.0' },
  {
    capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
    instructions: [
      'Messages from other coding sessions arrive as <channel source="walkie-talkie" from="..." message_id="...">.',
      'Reply with the send tool, passing the sender name as "to".',
      'Use list_sessions to see who else is online.',
      'Use broadcast to message all sessions at once.',
    ].join('\n'),
  },
)

async function brokerFetch(path: string, opts?: RequestInit): Promise<Response> {
  return fetch(`${BROKER}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...opts?.headers },
  })
}

// Tools

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'send',
      description: 'Send a message to another session',
      inputSchema: {
        type: 'object' as const,
        properties: {
          to: { type: 'string', description: 'Target session name' },
          text: { type: 'string', description: 'Message content' },
          reply_to: { type: 'string', description: 'Message ID to reply to (optional)' },
        },
        required: ['to', 'text'],
      },
    },
    {
      name: 'broadcast',
      description: 'Send a message to all connected sessions',
      inputSchema: {
        type: 'object' as const,
        properties: {
          text: { type: 'string', description: 'Message content' },
        },
        required: ['text'],
      },
    },
    {
      name: 'list_sessions',
      description: 'List all connected sessions and their roles',
      inputSchema: { type: 'object' as const, properties: {}, required: [] },
    },
    {
      name: 'subscribe',
      description: 'Subscribe to a topic for targeted updates',
      inputSchema: {
        type: 'object' as const,
        properties: {
          topic: { type: 'string', description: 'Topic name' },
        },
        required: ['topic'],
      },
    },
    {
      name: 'publish',
      description: 'Publish a message to a topic',
      inputSchema: {
        type: 'object' as const,
        properties: {
          topic: { type: 'string', description: 'Topic to publish to' },
          text: { type: 'string', description: 'Message content' },
        },
        required: ['topic', 'text'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>
  try {
    switch (req.params.name) {
      case 'send': {
        const res = await brokerFetch('/send', {
          method: 'POST',
          body: JSON.stringify({ from: NAME, to: args.to, content: args.text, reply_to: args.reply_to }),
        })
        const data = await res.json() as Record<string, unknown>
        if (!res.ok) throw new Error(data.error as string)
        return { content: [{ type: 'text', text: `sent to ${args.to} (id: ${data.sent})` }] }
      }
      case 'broadcast': {
        const res = await brokerFetch('/broadcast', {
          method: 'POST',
          body: JSON.stringify({ from: NAME, content: args.text }),
        })
        const data = await res.json() as Record<string, unknown>
        if (!res.ok) throw new Error(data.error as string)
        const rcpt = data.recipients as number
        const text = rcpt === 0
          ? `broadcast sent but no other sessions online (id: ${data.broadcast})`
          : `broadcast (id: ${data.broadcast}, ${rcpt} recipient${rcpt === 1 ? '' : 's'})`
        return { content: [{ type: 'text', text }] }
      }
      case 'list_sessions': {
        const res = await brokerFetch('/registry')
        const data = await res.json() as { sessions: Record<string, { name: string; role: string; runtime: string; last_seen: string }> }
        const lines = Object.values(data.sessions).map(
          s => `${s.name} (${s.runtime}) — ${s.role || 'no role set'} [last seen: ${s.last_seen}]`,
        )
        return { content: [{ type: 'text', text: lines.length ? lines.join('\n') : 'no sessions online' }] }
      }
      case 'subscribe': {
        const res = await brokerFetch('/subscribe', {
          method: 'POST',
          body: JSON.stringify({ name: NAME, topic: args.topic }),
        })
        const data = await res.json() as Record<string, unknown>
        if (!res.ok) throw new Error(data.error as string)
        return { content: [{ type: 'text', text: `subscribed to "${args.topic}"` }] }
      }
      case 'publish': {
        const res = await brokerFetch('/publish', {
          method: 'POST',
          body: JSON.stringify({ from: NAME, topic: args.topic, content: args.text }),
        })
        const data = await res.json() as Record<string, unknown>
        if (!res.ok) throw new Error(data.error as string)
        return { content: [{ type: 'text', text: `published to "${args.topic}" (${data.published} recipients)` }] }
      }
      default:
        return { content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }], isError: true }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { content: [{ type: 'text', text: `${req.params.name} failed: ${msg}` }], isError: true }
  }
})

// Connect to Claude Code
await mcp.connect(new StdioServerTransport())

// Register with broker
let registered = false
for (let i = 0; i < 10; i++) {
  try {
    const res = await brokerFetch('/register', {
      method: 'POST',
      body: JSON.stringify({ name: NAME, role: ROLE, runtime: 'claude-code', force: true }),
    })
    if (res.ok) {
      registered = true
      process.stderr.write(`walkie-talkie: registered as "${NAME}"\n`)
      break
    }
    const err = await res.json().catch(() => ({})) as Record<string, unknown>
    process.stderr.write(`walkie-talkie: register attempt ${i + 1} failed: HTTP ${res.status} ${JSON.stringify(err)}\n`)
  } catch {}
  await new Promise(r => setTimeout(r, 2000))
}
if (!registered) {
  process.stderr.write(`walkie-talkie: broker not available at ${BROKER}, running without messaging\n`)
}

// Poll loop — self-scheduling to prevent overlapping requests
async function pollLoop() {
  if (!registered) { setTimeout(pollLoop, POLL_INTERVAL); return }
  try {
    const res = await brokerFetch(`/poll/${encodeURIComponent(NAME)}`)
    if (!res.ok) { setTimeout(pollLoop, POLL_INTERVAL); return }
    const messages = await res.json() as Array<{
      id: string; from: string; content: string; topic?: string; reply_to?: string
    }>
    for (const msg of messages) {
      try {
        await mcp.notification({
          method: 'notifications/claude/channel',
          params: {
            content: msg.content,
            meta: {
              source: 'walkie-talkie',
              from: msg.from,
              message_id: msg.id,
              ...(msg.topic ? { topic: msg.topic } : {}),
              ...(msg.reply_to ? { reply_to: msg.reply_to } : {}),
            },
          },
        })
      } catch (err) {
        process.stderr.write(`walkie-talkie: failed to deliver message ${msg.id}: ${err}\n`)
      }
    }
  } catch {
    // broker unreachable — silently retry
  }
  setTimeout(pollLoop, POLL_INTERVAL)
}
setTimeout(pollLoop, POLL_INTERVAL)
