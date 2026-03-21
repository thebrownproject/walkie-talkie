#!/usr/bin/env bun
/**
 * Walkie-Talkie Broker — lightweight message routing for AI coding sessions.
 * Zero dependencies. Bun HTTP server on localhost.
 */

const PORT = parseInt(process.env.WALKIE_TALKIE_PORT ?? '9900', 10)
const STALE_TIMEOUT = 5 * 60 * 1000 // 5 minutes
const INBOX_CAP = 100
const IN_FLIGHT_TIMEOUT = 10_000 // 10 seconds before un-acked messages return to inbox
const startedAt = Date.now()

interface Session {
  name: string
  role: string
  runtime: string
  joined_at: string
  last_seen: string
  subscriptions: string[]
}

interface Message {
  id: string
  from: string
  to: string | null
  content: string
  channel?: string
  timestamp: string
  reply_to?: string
}

const sessions = new Map<string, Session>()
const inboxes = new Map<string, Message[]>()
const channels = new Map<string, Set<string>>()

// In-flight messages: messages that have been polled but not yet acknowledged
interface InFlightBatch {
  messages: Message[]
  polled_at: number
}
const inFlight = new Map<string, InFlightBatch>()

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function enqueue(name: string, msg: Message) {
  const inbox = inboxes.get(name)
  if (!inbox) return
  inbox.push(msg)
  if (inbox.length > INBOX_CAP) inbox.splice(0, inbox.length - INBOX_CAP)
}

function unregister(name: string) {
  sessions.delete(name)
  inboxes.delete(name)
  inFlight.delete(name)
  for (const subs of channels.values()) subs.delete(name)
}

// Stale session cleanup
setInterval(() => {
  const now = Date.now()
  for (const [name, s] of sessions) {
    if (now - new Date(s.last_seen).getTime() > STALE_TIMEOUT) {
      unregister(name)
      process.stderr.write(`broker: unregistered stale session "${name}"\n`)
    }
  }
}, 30_000)

Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url)
    const path = url.pathname
    const method = req.method

    // Parse JSON body when present
    let body: Record<string, unknown> = {}
    const contentType = req.headers.get('content-type') ?? ''
    if ((method === 'POST' || method === 'DELETE') && contentType.includes('application/json')) {
      try {
        body = await req.json() as Record<string, unknown>
      } catch {
        return json({ error: 'invalid JSON body' }, 400)
      }
    }

    // POST /register
    if (method === 'POST' && path === '/register') {
      const name = body.name as string
      if (!name) return json({ error: 'name required' }, 400)
      if (!/^[\w\-]{1,64}$/.test(name)) return json({ error: 'name must be 1-64 word chars or hyphens' }, 400)

      if (sessions.has(name) && !body.force) {
        return json({ error: 'name taken, use force: true to re-register' }, 409)
      }
      if (sessions.has(name)) unregister(name)

      const now = new Date().toISOString()
      sessions.set(name, {
        name,
        role: (body.role as string) ?? '',
        runtime: (body.runtime as string) ?? 'unknown',
        joined_at: now,
        last_seen: now,
        subscriptions: [],
      })
      inboxes.set(name, [])
      return json({ registered: name })
    }

    // DELETE /register/:name
    if (method === 'DELETE' && path.startsWith('/register/')) {
      const name = decodeURIComponent(path.slice('/register/'.length))
      if (!sessions.has(name)) return json({ error: 'not found' }, 404)
      unregister(name)
      return json({ unregistered: name })
    }

    // GET /registry
    if (method === 'GET' && path === '/registry') {
      return json({ sessions: Object.fromEntries(sessions) })
    }

    // POST /send
    if (method === 'POST' && path === '/send') {
      const from = body.from as string
      const to = body.to as string
      const content = body.content as string

      if (!from || !to || !content) return json({ error: 'from, to, content required' }, 400)
      if (!sessions.has(from)) return json({ error: `sender "${from}" not registered` }, 403)
      if (!sessions.has(to)) return json({ error: `target "${to}" not found` }, 404)

      const msg: Message = {
        id: crypto.randomUUID(),
        from,
        to,
        content,
        timestamp: new Date().toISOString(),
        reply_to: body.reply_to as string | undefined,
      }
      enqueue(to, msg)
      return json({ sent: msg.id })
    }

    // POST /broadcast
    if (method === 'POST' && path === '/broadcast') {
      const from = body.from as string
      const content = body.content as string

      if (!from || !content) return json({ error: 'from, content required' }, 400)
      if (!sessions.has(from)) return json({ error: `sender "${from}" not registered` }, 403)

      const msg: Message = {
        id: crypto.randomUUID(),
        from,
        to: null,
        content,
        timestamp: new Date().toISOString(),
      }
      for (const name of sessions.keys()) {
        if (name !== from) enqueue(name, msg)
      }
      return json({ broadcast: msg.id, recipients: sessions.size - 1 })
    }

    // GET /poll/:name
    if (method === 'GET' && path.startsWith('/poll/')) {
      const name = decodeURIComponent(path.slice('/poll/'.length))
      if (!sessions.has(name)) return json({ error: 'not registered' }, 404)

      const session = sessions.get(name)!
      session.last_seen = new Date().toISOString()

      // Return any timed-out in-flight messages back to the inbox
      const existing = inFlight.get(name)
      if (existing && Date.now() - existing.polled_at > IN_FLIGHT_TIMEOUT) {
        const inbox = inboxes.get(name) ?? []
        // Prepend timed-out messages so they get delivered first
        inboxes.set(name, [...existing.messages, ...inbox])
        inFlight.delete(name)
        process.stderr.write(`broker: returned ${existing.messages.length} timed-out in-flight message(s) to "${name}" inbox\n`)
      }

      // If there are still un-acked in-flight messages, don't send more
      if (inFlight.has(name)) {
        return json([])
      }

      const inbox = inboxes.get(name) ?? []
      if (inbox.length === 0) return json([])

      // Move messages to in-flight
      inFlight.set(name, { messages: [...inbox], polled_at: Date.now() })
      inboxes.set(name, [])
      return json(inbox)
    }

    // POST /ack/:name -- acknowledge successful delivery of polled messages
    if (method === 'POST' && path.startsWith('/ack/')) {
      const name = decodeURIComponent(path.slice('/ack/'.length))
      if (!sessions.has(name)) return json({ error: 'not registered' }, 404)

      const acked = body.message_ids as string[] | undefined
      const batch = inFlight.get(name)
      if (!batch) return json({ acked: 0 })

      if (acked && acked.length > 0) {
        // Partial ack: remove only the acknowledged messages
        const ackedSet = new Set(acked)
        const remaining = batch.messages.filter(m => !ackedSet.has(m.id))
        if (remaining.length === 0) {
          inFlight.delete(name)
        } else {
          batch.messages = remaining
        }
        return json({ acked: acked.length, remaining: remaining.length })
      } else {
        // Full ack: clear entire in-flight batch
        const count = batch.messages.length
        inFlight.delete(name)
        return json({ acked: count })
      }
    }

    // POST /nack/:name -- negative ack, return messages to inbox for retry
    if (method === 'POST' && path.startsWith('/nack/')) {
      const name = decodeURIComponent(path.slice('/nack/'.length))
      if (!sessions.has(name)) return json({ error: 'not registered' }, 404)

      const nacked = body.message_ids as string[] | undefined
      const batch = inFlight.get(name)
      if (!batch) return json({ returned: 0 })

      if (nacked && nacked.length > 0) {
        // Partial nack: return specific messages to inbox
        const nackedSet = new Set(nacked)
        const toReturn = batch.messages.filter(m => nackedSet.has(m.id))
        batch.messages = batch.messages.filter(m => !nackedSet.has(m.id))
        if (batch.messages.length === 0) inFlight.delete(name)

        const inbox = inboxes.get(name) ?? []
        inboxes.set(name, [...toReturn, ...inbox])
        return json({ returned: toReturn.length })
      } else {
        // Full nack: return all in-flight messages to inbox
        const inbox = inboxes.get(name) ?? []
        inboxes.set(name, [...batch.messages, ...inbox])
        const count = batch.messages.length
        inFlight.delete(name)
        return json({ returned: count })
      }
    }

    // POST /subscribe
    if (method === 'POST' && path === '/subscribe') {
      const name = body.name as string
      const channel = body.channel as string

      if (!name || !channel) return json({ error: 'name, channel required' }, 400)
      if (!sessions.has(name)) return json({ error: 'not registered' }, 404)

      if (!channels.has(channel)) channels.set(channel, new Set())
      channels.get(channel)!.add(name)

      const session = sessions.get(name)!
      if (!session.subscriptions.includes(channel)) session.subscriptions.push(channel)

      return json({ subscribed: { name, channel } })
    }

    // DELETE /subscribe
    if (method === 'DELETE' && path === '/subscribe') {
      const name = body.name as string
      const channel = body.channel as string

      if (!name || !channel) return json({ error: 'name, channel required' }, 400)
      if (!sessions.has(name)) return json({ error: 'not registered' }, 404)

      channels.get(channel)?.delete(name)
      const session = sessions.get(name)
      if (session) session.subscriptions = session.subscriptions.filter(t => t !== channel)

      return json({ unsubscribed: { name, channel } })
    }

    // POST /publish
    if (method === 'POST' && path === '/publish') {
      const from = body.from as string
      const channel = body.channel as string
      const content = body.content as string

      if (!from || !channel || !content) return json({ error: 'from, channel, content required' }, 400)
      if (!sessions.has(from)) return json({ error: `sender "${from}" not registered` }, 403)

      const subscribers = channels.get(channel)
      if (!subscribers || subscribers.size === 0) return json({ published: 0 })

      const msg: Message = {
        id: crypto.randomUUID(),
        from,
        to: null,
        content,
        channel,
        timestamp: new Date().toISOString(),
      }

      let count = 0
      for (const name of subscribers) {
        if (name !== from) {
          enqueue(name, msg)
          count++
        }
      }
      return json({ published: count, channel })
    }

    // GET /health
    if (method === 'GET' && path === '/health') {
      let totalQueued = 0
      for (const inbox of inboxes.values()) totalQueued += inbox.length
      let totalInFlight = 0
      for (const batch of inFlight.values()) totalInFlight += batch.messages.length
      return json({
        status: 'ok',
        uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
        session_count: sessions.size,
        total_queued_messages: totalQueued,
        total_in_flight_messages: totalInFlight,
      })
    }

    return json({ error: 'not found' }, 404)
  },
})

process.stderr.write(`walkie-talkie broker listening on http://127.0.0.1:${PORT}\n`)
