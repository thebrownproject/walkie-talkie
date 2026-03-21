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
const MAX_RETRY_WINDOW_MS = 1500
let registered = false
let shuttingDown = false
let pollTimer: ReturnType<typeof setTimeout> | undefined

const mcp = new Server(
  { name: 'walkie-talkie', version: '1.0.0' },
  {
    capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
    instructions: [
      'Messages from other coding sessions arrive as <channel source="walkie-talkie" from="..." message_id="...">.',
      'Reply with the send tool, passing the sender name as "to".',
      'Use the join tool first to set your session name, role, and optionally subscribe to channels.',
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

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function schedulePoll(delay = POLL_INTERVAL) {
  if (shuttingDown) return
  pollTimer = setTimeout(pollLoop, delay)
}

async function registerWithBroker(name: string, role: string): Promise<void> {
  const oldName = NAME

  const res = await brokerFetch('/register', {
    method: 'POST',
    body: JSON.stringify({ name, role, runtime: 'claude-code', force: true }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({})) as Record<string, unknown>
    throw new Error(data.error as string ?? `HTTP ${res.status}`)
  }

  // Unregister the previous name only after the replacement is safely registered.
  if (registered && oldName !== name) {
    await brokerFetch(`/register/${encodeURIComponent(oldName)}`, { method: 'DELETE' }).catch(err => {
      process.stderr.write(`walkie-talkie: failed to unregister previous name "${oldName}": ${err}\n`)
    })
  }

  NAME = name
  ROLE = role
  registered = true
  process.stderr.write(`walkie-talkie: registered as "${NAME}"\n`)
}

// Tools

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'join',
      description: 'Join the walkie-talkie network with a name, role, and optional channels',
      inputSchema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'Session name (e.g. "frontend", "backend", "tests")' },
          role: { type: 'string', description: 'What this session is doing (e.g. "building React components")' },
          channels: {
            type: 'array' as const,
            items: { type: 'string' },
            description: 'Channels to subscribe to (e.g. ["project-a", "deploys"])',
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
      description: 'Subscribe to a channel for targeted updates',
      inputSchema: {
        type: 'object' as const,
        properties: {
          channel: { type: 'string', description: 'Channel name' },
        },
        required: ['channel'],
      },
    },
    {
      name: 'publish',
      description: 'Publish a message to a channel',
      inputSchema: {
        type: 'object' as const,
        properties: {
          channel: { type: 'string', description: 'Channel to publish to' },
          text: { type: 'string', description: 'Message content' },
        },
        required: ['channel', 'text'],
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
        const channels = args.channels as string[] | undefined
        const subscribed: string[] = []
        if (channels?.length) {
          for (const channel of channels) {
            const res = await brokerFetch('/subscribe', {
              method: 'POST',
              body: JSON.stringify({ name: NAME, channel }),
            })
            if (res.ok) subscribed.push(channel)
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
          if (s.subscriptions?.length) parts.push(`channels: ${s.subscriptions.join(', ')}`)
          parts.push(`last seen: ${s.last_seen}`)
          return parts.join(' | ')
        })
        return { content: [{ type: 'text', text: lines.length ? lines.join('\n') : 'no sessions online' }] }
      }
      case 'subscribe': {
        if (!registered) throw new Error('not joined yet, use the join tool first')
        const res = await brokerFetch('/subscribe', {
          method: 'POST',
          body: JSON.stringify({ name: NAME, channel: args.channel }),
        })
        const data = await res.json() as Record<string, unknown>
        if (!res.ok) throw new Error(data.error as string)
        return { content: [{ type: 'text', text: `subscribed to "${args.channel}"` }] }
      }
      case 'publish': {
        if (!registered) throw new Error('not joined yet, use the join tool first')
        const res = await brokerFetch('/publish', {
          method: 'POST',
          body: JSON.stringify({ from: NAME, channel: args.channel, content: args.text }),
        })
        const data = await res.json() as Record<string, unknown>
        if (!res.ok) throw new Error(data.error as string)
        return { content: [{ type: 'text', text: `published to "${args.channel}" (${data.published} recipients)` }] }
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

async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  if (pollTimer) clearTimeout(pollTimer)

  process.stderr.write('walkie-talkie: shutting down\n')
  const exitTimer = setTimeout(() => process.exit(0), 2000)

  if (registered) {
    try {
      const res = await brokerFetch(`/register/${encodeURIComponent(NAME)}`, { method: 'DELETE' })
      if (res.ok) {
        process.stderr.write(`walkie-talkie: unregistered "${NAME}" on exit\n`)
      }
    } catch (err) {
      process.stderr.write(`walkie-talkie: shutdown unregister failed: ${err}\n`)
    }
  }

  clearTimeout(exitTimer)
  process.exit(0)
}
process.stdin.on('end', () => { void shutdown() })
process.stdin.on('close', () => { void shutdown() })
process.on('SIGTERM', () => { void shutdown() })
process.on('SIGINT', () => { void shutdown() })

// Only auto-register if WALKIE_TALKIE_NAME was explicitly set
// Otherwise, wait for the user to call the join tool
if (process.env.WALKIE_TALKIE_NAME) {
  for (let i = 0; i < 3; i++) {
    try {
      await registerWithBroker(NAME, ROLE)
      break
    } catch {}
    await sleep(2000)
  }
  if (!registered) {
    process.stderr.write(`walkie-talkie: broker not available at ${BROKER}, use the join tool to connect later\n`)
  }
} else {
  process.stderr.write(`walkie-talkie: waiting for join -- use the join tool or set WALKIE_TALKIE_NAME\n`)
}

// Deliver a single notification with retry + exponential backoff
async function deliverNotification(msg: {
  id: string; from: string; content: string; channel?: string; reply_to?: string
}): Promise<boolean> {
  const startedAt = Date.now()
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
            ...(msg.channel ? { channel: msg.channel } : {}),
            ...(msg.reply_to ? { reply_to: msg.reply_to } : {}),
          },
        },
      })
      process.stderr.write(`walkie-talkie: delivered ${msg.id} (attempt ${attempt + 1})\n`)
      return true
    } catch (err) {
      const delay = RETRY_BASE_MS * Math.pow(2, attempt)
      process.stderr.write(`walkie-talkie: notification failed for ${msg.id} (attempt ${attempt + 1}/${MAX_RETRIES}): ${err}\n`)
      if (attempt < MAX_RETRIES - 1 && Date.now() - startedAt + delay <= MAX_RETRY_WINDOW_MS) {
        await sleep(delay)
      } else {
        if (attempt < MAX_RETRIES - 1) {
          process.stderr.write(`walkie-talkie: retry budget exhausted for ${msg.id}, deferring to next poll\n`)
        }
        break
      }
    }
  }
  return false
}

// Poll loop -- self-scheduling to prevent overlapping requests
// Uses ack/nack protocol so the broker retains messages until confirmed delivered
async function pollLoop() {
  if (shuttingDown) return
  if (!registered) { schedulePoll(); return }
  try {
    const res = await brokerFetch(`/poll/${encodeURIComponent(NAME)}`)
    if (!res.ok) { schedulePoll(); return }
    const messages = await res.json() as Array<{
      id: string; from: string; content: string; channel?: string; reply_to?: string
    }>
    if (messages.length === 0) { schedulePoll(); return }

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
        failed.push(...messages.slice(i).map(remaining => remaining.id))
        process.stderr.write(
          `walkie-talkie: delivery stalled on ${msg.id}, deferring ${messages.length - i} message(s) to next poll\n`,
        )
        break
      }

      // Stagger between notifications to avoid overwhelming the transport
      if (i < messages.length - 1) {
        await sleep(NOTIFICATION_STAGGER_MS)
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
  schedulePoll()
}
schedulePoll()
