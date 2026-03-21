#!/usr/bin/env bun
/**
 * Walkie-Talkie Broker — lightweight message routing for AI coding sessions.
 * Zero dependencies. Bun HTTP server on localhost.
 */

const PORT = parseInt(process.env.WALKIE_TALKIE_PORT ?? '9900', 10)
const STALE_TIMEOUT = 5 * 60 * 1000 // 5 minutes
const INBOX_CAP = 100
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
  topic?: string
  timestamp: string
  reply_to?: string
}

const sessions = new Map<string, Session>()
const inboxes = new Map<string, Message[]>()
const topics = new Map<string, Set<string>>()

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
  for (const subs of topics.values()) subs.delete(name)
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

      const inbox = inboxes.get(name) ?? []
      inboxes.set(name, [])
      return json(inbox)
    }

    // POST /subscribe
    if (method === 'POST' && path === '/subscribe') {
      const name = body.name as string
      const topic = body.topic as string

      if (!name || !topic) return json({ error: 'name, topic required' }, 400)
      if (!sessions.has(name)) return json({ error: 'not registered' }, 404)

      if (!topics.has(topic)) topics.set(topic, new Set())
      topics.get(topic)!.add(name)

      const session = sessions.get(name)!
      if (!session.subscriptions.includes(topic)) session.subscriptions.push(topic)

      return json({ subscribed: { name, topic } })
    }

    // DELETE /subscribe
    if (method === 'DELETE' && path === '/subscribe') {
      const name = body.name as string
      const topic = body.topic as string

      if (!name || !topic) return json({ error: 'name, topic required' }, 400)
      if (!sessions.has(name)) return json({ error: 'not registered' }, 404)

      topics.get(topic)?.delete(name)
      const session = sessions.get(name)
      if (session) session.subscriptions = session.subscriptions.filter(t => t !== topic)

      return json({ unsubscribed: { name, topic } })
    }

    // POST /publish
    if (method === 'POST' && path === '/publish') {
      const from = body.from as string
      const topic = body.topic as string
      const content = body.content as string

      if (!from || !topic || !content) return json({ error: 'from, topic, content required' }, 400)
      if (!sessions.has(from)) return json({ error: `sender "${from}" not registered` }, 403)

      const subscribers = topics.get(topic)
      if (!subscribers || subscribers.size === 0) return json({ published: 0 })

      const msg: Message = {
        id: crypto.randomUUID(),
        from,
        to: null,
        content,
        topic,
        timestamp: new Date().toISOString(),
      }

      let count = 0
      for (const name of subscribers) {
        if (name !== from) {
          enqueue(name, msg)
          count++
        }
      }
      return json({ published: count, topic })
    }

    // GET /health
    if (method === 'GET' && path === '/health') {
      let totalQueued = 0
      for (const inbox of inboxes.values()) totalQueued += inbox.length
      return json({
        status: 'ok',
        uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
        session_count: sessions.size,
        total_queued_messages: totalQueued,
      })
    }

    return json({ error: 'not found' }, 404)
  },
})

process.stderr.write(`walkie-talkie broker listening on http://127.0.0.1:${PORT}\n`)
