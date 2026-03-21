#!/usr/bin/env bun
/**
 * Walkie-Talkie Channel Plugin -- MCP server for Claude Code.
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
let NAME = process.env.WALKIE_TALKIE_NAME ?? `session-${Date.now()}`
let ROLE = process.env.WALKIE_TALKIE_ROLE ?? ''
const POLL_INTERVAL = 2000
const NOTIFICATION_STAGGER_MS = 150 // delay between rapid-fire notifications
const MAX_RETRIES = 3
const RETRY_BASE_MS = 500 // exponential backoff: 500, 1000, 2000
let registered = false

const mcp = new Server(
  { name: 'walkie-talkie', version: '1.0.0' },
  {
    capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
    instructions: [
      'Messages from other coding sessions arrive as <channel source="walkie-talkie" from="..." message_id="...">.',
      'Reply with the send tool, passing the sender name as "to".',
      'Use the join tool first to set your session name, role, and optionally subscribe to topics.',
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

async function registerWithBroker(name: string, role: string): Promise<void> {
  const oldName = NAME
  NAME = name
  ROLE = role

  // Unregister old name if it was different and we were registered
  if (registered && oldName !== name) {
    await brokerFetch(`/register/${encodeURIComponent(oldName)}`, { method: 'DELETE' }).catch(() => {})
  }

  const res = await brokerFetch('/register', {
    method: 'POST',
    body: JSON.stringify({ name: NAME, role: ROLE, runtime: 'claude-code', force: true }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({})) as Record<string, unknown>
    throw new Error(data.error as string ?? `HTTP ${res.status}`)
  }
  registered = true
  process.stderr.write(`walkie-talkie: registered as "${NAME}"\n`)
}

// Tools

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'join',
      description: 'Join the walkie-talkie network with a name, role, and optional topics',
      inputSchema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'Session name (e.g. "frontend", "backend", "tests")' },
          role: { type: 'string', description: 'What this session is doing (e.g. "building React components")' },
          topics: {
            type: 'array' as const,
            items: { type: 'string' },
            description: 'Topics/channels to subscribe to (e.g. ["project-a", "deploys"])',
          },
        },
        required: ['name'],
      },
    },
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
      case 'join': {
        await registerWithBroker(args.name as string, (args.role as string) ?? '')
        const topics = args.topics as string[] | undefined
        const subscribed: string[] = []
        if (topics?.length) {
          for (const topic of topics) {
            const res = await brokerFetch('/subscribe', {
              method: 'POST',
              body: JSON.stringify({ name: NAME, topic }),
            })
            if (res.ok) subscribed.push(topic)
          }
        }
        const parts = [`joined as "${NAME}"`]
        if (ROLE) parts.push(`role: ${ROLE}`)
        if (subscribed.length) parts.push(`subscribed to: ${subscribed.join(', ')}`)
        return { content: [{ type: 'text', text: parts.join(' | ') }] }
      }
      case 'send': {
        if (!registered) throw new Error('not joined yet, use the join tool first')
        const res = await brokerFetch('/send', {
          method: 'POST',
          body: JSON.stringify({ from: NAME, to: args.to, content: args.text, reply_to: args.reply_to }),
        })
        const data = await res.json() as Record<string, unknown>
        if (!res.ok) throw new Error(data.error as string)
        return { content: [{ type: 'text', text: `sent to ${args.to} (id: ${data.sent})` }] }
      }
      case 'broadcast': {
        if (!registered) throw new Error('not joined yet, use the join tool first')
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
        const data = await res.json() as { sessions: Record<string, { name: string; role: string; runtime: string; last_seen: string; subscriptions: string[] }> }
        const lines = Object.values(data.sessions).map(s => {
          const parts = [`${s.name} (${s.runtime})`]
          if (s.role) parts.push(s.role)
          if (s.subscriptions?.length) parts.push(`topics: ${s.subscriptions.join(', ')}`)
          parts.push(`last seen: ${s.last_seen}`)
          return parts.join(' | ')
        })
        return { content: [{ type: 'text', text: lines.length ? lines.join('\n') : 'no sessions online' }] }
      }
      case 'subscribe': {
        if (!registered) throw new Error('not joined yet, use the join tool first')
        const res = await brokerFetch('/subscribe', {
          method: 'POST',
          body: JSON.stringify({ name: NAME, topic: args.topic }),
        })
        const data = await res.json() as Record<string, unknown>
        if (!res.ok) throw new Error(data.error as string)
        return { content: [{ type: 'text', text: `subscribed to "${args.topic}"` }] }
      }
      case 'publish': {
        if (!registered) throw new Error('not joined yet, use the join tool first')
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

// Clean up on exit -- unregister from broker when session closes
function cleanup() {
  if (!registered) return
  // Fire-and-forget unregister (process is dying, can't await)
  fetch(`${BROKER}/register/${encodeURIComponent(NAME)}`, { method: 'DELETE' }).catch(() => {})
  process.stderr.write(`walkie-talkie: unregistered "${NAME}" on exit\n`)
}
process.on('SIGTERM', cleanup)
process.on('SIGINT', cleanup)
process.on('exit', cleanup)

// Only auto-register if WALKIE_TALKIE_NAME was explicitly set
// Otherwise, wait for the user to call the join tool
if (process.env.WALKIE_TALKIE_NAME) {
  for (let i = 0; i < 3; i++) {
    try {
      await registerWithBroker(NAME, ROLE)
      break
    } catch {}
    await new Promise(r => setTimeout(r, 2000))
  }
  if (!registered) {
    process.stderr.write(`walkie-talkie: broker not available at ${BROKER}, use the join tool to connect later\n`)
  }
} else {
  process.stderr.write(`walkie-talkie: waiting for join -- use the join tool or set WALKIE_TALKIE_NAME\n`)
}

// Deliver a single notification with retry + exponential backoff
async function deliverNotification(msg: {
  id: string; from: string; content: string; topic?: string; reply_to?: string
}): Promise<boolean> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
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
      process.stderr.write(`walkie-talkie: delivered ${msg.id} (attempt ${attempt + 1})\n`)
      return true
    } catch (err) {
      const delay = RETRY_BASE_MS * Math.pow(2, attempt)
      process.stderr.write(`walkie-talkie: notification failed for ${msg.id} (attempt ${attempt + 1}/${MAX_RETRIES}): ${err}\n`)
      if (attempt < MAX_RETRIES - 1) {
        await new Promise(r => setTimeout(r, delay))
      }
    }
  }
  return false
}

// Poll loop -- self-scheduling to prevent overlapping requests
// Uses ack/nack protocol so the broker retains messages until confirmed delivered
async function pollLoop() {
  if (!registered) { setTimeout(pollLoop, POLL_INTERVAL); return }
  try {
    const res = await brokerFetch(`/poll/${encodeURIComponent(NAME)}`)
    if (!res.ok) { setTimeout(pollLoop, POLL_INTERVAL); return }
    const messages = await res.json() as Array<{
      id: string; from: string; content: string; topic?: string; reply_to?: string
    }>
    if (messages.length === 0) { setTimeout(pollLoop, POLL_INTERVAL); return }

    process.stderr.write(`walkie-talkie: polled ${messages.length} message(s) for "${NAME}"\n`)

    const delivered: string[] = []
    const failed: string[] = []

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]
      process.stderr.write(`walkie-talkie: delivering ${msg.id} from "${msg.from}": ${msg.content.slice(0, 80)}\n`)

      const ok = await deliverNotification(msg)
      if (ok) {
        delivered.push(msg.id)
      } else {
        failed.push(msg.id)
      }

      // Stagger between notifications to avoid overwhelming the transport
      if (i < messages.length - 1) {
        await new Promise(r => setTimeout(r, NOTIFICATION_STAGGER_MS))
      }
    }

    // Acknowledge successfully delivered messages
    if (delivered.length > 0) {
      await brokerFetch(`/ack/${encodeURIComponent(NAME)}`, {
        method: 'POST',
        body: JSON.stringify({ message_ids: delivered }),
      }).catch(err => {
        process.stderr.write(`walkie-talkie: ack failed: ${err}\n`)
      })
    }

    // Nack failed messages so they return to the inbox for next poll
    if (failed.length > 0) {
      process.stderr.write(`walkie-talkie: nacking ${failed.length} failed message(s)\n`)
      await brokerFetch(`/nack/${encodeURIComponent(NAME)}`, {
        method: 'POST',
        body: JSON.stringify({ message_ids: failed }),
      }).catch(err => {
        process.stderr.write(`walkie-talkie: nack failed: ${err}\n`)
      })
    }
  } catch {
    // broker unreachable -- silently retry
  }
  setTimeout(pollLoop, POLL_INTERVAL)
}
setTimeout(pollLoop, POLL_INTERVAL)
