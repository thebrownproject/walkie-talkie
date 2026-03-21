# Simplification Review

Reviewed on 2026-03-22. Read-only analysis of `server.ts` (352 lines) and `broker.ts` (344 lines).

Overall assessment: Both files are lean for what they do. The broker is a clean HTTP handler and the server is a straightforward MCP wrapper. There is no dead code, no unused imports, and no speculative abstractions. The findings below are all in the "tighten what exists" category, not "this is bloated."

Estimated removable lines: ~45-55 across both files.

## Finding 1: Duplicate registration guard across 4 tool handlers

**Priority:** Warning
**Category:** REDUNDANT
**File:** `server.ts:166, 176, 202, 212`
**Issue:** The `if (!registered) throw new Error('not joined yet...')` check is copy-pasted into send, broadcast, subscribe, and publish. This is a DRY violation that will grow with every new tool.

**Before:**
```typescript
case 'send': {
  if (!registered) throw new Error('not joined yet, use the join tool first')
  // ...
}
case 'broadcast': {
  if (!registered) throw new Error('not joined yet, use the join tool first')
  // ...
}
case 'subscribe': {
  if (!registered) throw new Error('not joined yet, use the join tool first')
  // ...
}
case 'publish': {
  if (!registered) throw new Error('not joined yet, use the join tool first')
  // ...
}
```

**After:**
```typescript
// Guard once before the switch, for all tools except join and list_sessions
const needsRegistration = !['join', 'list_sessions'].includes(req.params.name)
if (needsRegistration && !registered) {
  return { content: [{ type: 'text', text: 'not joined yet, use the join tool first' }], isError: true }
}

switch (req.params.name) {
  case 'join': { /* ... */ }
  case 'send': { /* no guard needed */ }
  // ...
}
```

**Why:** Removes 4 duplicate lines, centralizes the policy, and makes adding new tools safer (you can't forget the guard).


## Finding 2: Repetitive broker-call-then-check-error pattern in tool handlers

**Priority:** Suggestion
**Category:** REDUNDANT
**File:** `server.ts:165-219`
**Issue:** Four tool handlers (send, broadcast, subscribe, publish) all follow the exact same pattern: call brokerFetch, parse JSON, check `!res.ok`, throw error, return success text. The only differences are the endpoint, the body, and the success message.

**Before:**
```typescript
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
```

**After:**
```typescript
// Extract the fetch-parse-check pattern once
async function brokerPost(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await brokerFetch(path, { method: 'POST', body: JSON.stringify(body) })
  const data = await res.json() as Record<string, unknown>
  if (!res.ok) throw new Error(data.error as string)
  return data
}

// Then each handler becomes one-liners:
case 'send': {
  const data = await brokerPost('/send', { from: NAME, to: args.to, content: args.text, reply_to: args.reply_to })
  return { content: [{ type: 'text', text: `sent to ${args.to} (id: ${data.sent})` }] }
}
case 'subscribe': {
  await brokerPost('/subscribe', { name: NAME, channel: args.channel })
  return { content: [{ type: 'text', text: `subscribed to "${args.channel}"` }] }
}
```

**Why:** Removes ~12 lines of repetition. Every handler currently re-implements the same 3-line fetch/parse/check sequence. The `brokerPost` helper makes intent clear and the `brokerFetch` wrapper already exists as precedent for this pattern.


## Finding 3: Ack/nack partial-ack code paths are unused complexity

**Priority:** Warning
**Category:** OVER_ENGINEERED
**File:** `broker.ts:206-260`
**Issue:** The ack and nack endpoints both support two modes: partial (specific message IDs) and full (entire batch). But `server.ts` only ever sends partial acks/nacks with explicit message ID lists (lines 330, 341). The "full ack" and "full nack" branches (no message_ids provided) are never exercised by any client. This is 15+ lines of branching for a code path with zero callers.

**Before (ack handler):**
```typescript
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
```

**After:**
```typescript
const ackedSet = new Set(acked ?? [])
const remaining = ackedSet.size > 0
  ? batch.messages.filter(m => !ackedSet.has(m.id))
  : []

if (remaining.length === 0) {
  inFlight.delete(name)
} else {
  batch.messages = remaining
}
return json({ acked: batch.messages.length - remaining.length, remaining: remaining.length })
```

**Why:** The current ack handler is 12 lines with an if/else branch. The nack handler mirrors this at another 14 lines. Collapsing the branches makes both handlers ~6 lines each and removes the untested full-ack/full-nack code paths. If you later need full ack, passing an empty array already works as a no-op.

Note: An even simpler option is to just remove the full-ack branch entirely and require message_ids always. The server always provides them.


## Finding 4: The nack endpoint may be unnecessary entirely

**Priority:** Suggestion
**Category:** OVER_ENGINEERED
**File:** `broker.ts:233-260`, `server.ts:337-346`
**Issue:** The nack path exists so failed notifications get returned to the inbox. But the broker already handles this via `IN_FLIGHT_TIMEOUT` (10 seconds). If the server never acks a message, it automatically returns to the inbox on the next poll. The explicit nack just makes that happen slightly faster (immediately vs up to 10 seconds).

In practice, a notification failure in `deliverNotification` means the MCP transport is broken, which means the session is likely dead anyway and faster requeue does not help.

**Before (server.ts):**
```typescript
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
```

**After:**
```typescript
// Failed messages will auto-return to inbox via IN_FLIGHT_TIMEOUT (10s)
if (failed.length > 0) {
  process.stderr.write(`walkie-talkie: ${failed.length} message(s) failed delivery, will retry on next poll\n`)
}
```

**Why:** Removes 7 lines from server.ts and 27 lines from broker.ts (the entire `/nack` endpoint). The timeout-based fallback already exists and works. The nack path adds an HTTP round-trip that itself can fail (and is silently caught), adding complexity for minimal benefit. If you want to keep the nack for future use, that is fine, but it is currently unnecessary weight.


## Finding 5: deliverNotification retry with exponential backoff is unlikely to help

**Priority:** Suggestion
**Category:** OVER_ENGINEERED
**File:** `server.ts:262-291`
**Issue:** `deliverNotification` retries 3 times with exponential backoff (500ms, 1000ms, 2000ms). But `mcp.notification()` sends over stdio to Claude Code. If it fails once, it almost certainly fails on retry because the transport is broken (Claude closed stdin, pipe error, etc.). The retry loop adds 3.5 seconds of blocking delay per failed message before moving on, during which the poll loop is stalled.

The worst case: 10 messages in a batch, all failing, means 10 x 3.5s = 35 seconds of blocking before the next poll. That is a long stall for a transport that is already dead.

**Before:**
```typescript
async function deliverNotification(msg: {
  id: string; from: string; content: string; channel?: string; reply_to?: string
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
      if (attempt < MAX_RETRIES - 1) {
        await new Promise(r => setTimeout(r, delay))
      }
    }
  }
  return false
}
```

**After:**
```typescript
async function deliverNotification(msg: {
  id: string; from: string; content: string; channel?: string; reply_to?: string
}): Promise<boolean> {
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
    return true
  } catch (err) {
    process.stderr.write(`walkie-talkie: notification failed for ${msg.id}: ${err}\n`)
    return false
  }
}
```

**Why:** Removes 10 lines and 3 constants (`MAX_RETRIES`, `RETRY_BASE_MS`, `NOTIFICATION_STAGGER_MS`). The ack/nack protocol already handles retry at the broker level. Retrying a broken stdio pipe is not useful. If this turns out to be wrong (there are transient stdio failures that recover), the retry can be added back, but the current implementation is speculative.

Note: If you remove the retry, the `NOTIFICATION_STAGGER_MS` delay between messages (Finding 6) also becomes less necessary, since there is no longer a worst-case 35-second stall. You could keep a small stagger or remove it too.


## Finding 6: Broker routing as if/else chain vs. a lookup table

**Priority:** Suggestion
**Category:** VERBOSE
**File:** `broker.ts:94-340`
**Issue:** The broker's `fetch` handler is a 250-line if/else chain matching `method + path`. Each branch does its own path parsing, body extraction, and validation. This is fine at 10 endpoints, but there is a lighter-weight option that keeps the same zero-dependency constraint while being easier to scan.

**Before (abbreviated):**
```typescript
async fetch(req) {
  const url = new URL(req.url)
  const path = url.pathname
  const method = req.method

  let body: Record<string, unknown> = {}
  // ... parse body ...

  if (method === 'POST' && path === '/register') { /* ... */ }
  if (method === 'DELETE' && path.startsWith('/register/')) { /* ... */ }
  if (method === 'GET' && path === '/registry') { /* ... */ }
  if (method === 'POST' && path === '/send') { /* ... */ }
  if (method === 'POST' && path === '/broadcast') { /* ... */ }
  if (method === 'GET' && path.startsWith('/poll/')) { /* ... */ }
  if (method === 'POST' && path.startsWith('/ack/')) { /* ... */ }
  if (method === 'POST' && path.startsWith('/nack/')) { /* ... */ }
  if (method === 'POST' && path === '/subscribe') { /* ... */ }
  if (method === 'DELETE' && path === '/subscribe') { /* ... */ }
  if (method === 'POST' && path === '/publish') { /* ... */ }
  if (method === 'GET' && path === '/health') { /* ... */ }

  return json({ error: 'not found' }, 404)
}
```

**After (option -- extract handlers):**
```typescript
// Each handler is a named function, making the fetch body a clean dispatch
const routes: Array<{
  method: string
  match: (path: string) => string | null  // returns param or '' for exact match, null for no match
  handler: (body: Record<string, unknown>, param: string) => Response | Promise<Response>
}> = [
  { method: 'POST', match: p => p === '/register' ? '' : null, handler: handleRegister },
  { method: 'DELETE', match: p => p.startsWith('/register/') ? decodeURIComponent(p.slice(10)) : null, handler: handleUnregister },
  // ...
]

async fetch(req) {
  // ... parse body ...
  for (const route of routes) {
    if (method !== route.method) continue
    const param = route.match(path)
    if (param !== null) return route.handler(body, param)
  }
  return json({ error: 'not found' }, 404)
}
```

**Why:** This is a judgment call. The current if/else chain is honest and readable. The router pattern is slightly more structured but adds an abstraction. I would NOT recommend this unless you are adding more endpoints. At 10-12 endpoints, the if/else chain is fine. Flagging it only because it was specifically asked about.


## Finding 7: Tool definitions are verbose -- schema boilerplate dominates

**Priority:** Suggestion
**Category:** VERBOSE
**File:** `server.ts:69-141`
**Issue:** The tool definition list is 72 lines, but most of it is JSON Schema boilerplate (`type: 'object' as const`, `properties`, `required`). A small helper could cut this in half.

**Before:**
```typescript
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
```

**After:**
```typescript
function tool(name: string, description: string, props: Record<string, { type: string; description: string }>, required: string[]) {
  return { name, description, inputSchema: { type: 'object' as const, properties: props, required } }
}

// Then:
tool('send', 'Send a message to another session', {
  to: { type: 'string', description: 'Target session name' },
  text: { type: 'string', description: 'Message content' },
  reply_to: { type: 'string', description: 'Message ID to reply to (optional)' },
}, ['to', 'text']),
```

**Why:** Saves ~20 lines across 6 tool definitions. The helper is trivial and makes the tool list scannable at a glance. However, the current verbose form is also the standard pattern in MCP examples, so keeping it is defensible for familiarity.


## Finding 8: Conditional spread for optional meta fields

**Priority:** Suggestion
**Category:** VERBOSE
**File:** `server.ts:275-276`
**Issue:** The conditional spread pattern for optional fields is correct but slightly verbose.

**Before:**
```typescript
meta: {
  source: 'walkie-talkie',
  from: msg.from,
  message_id: msg.id,
  ...(msg.channel ? { channel: msg.channel } : {}),
  ...(msg.reply_to ? { reply_to: msg.reply_to } : {}),
},
```

**After:**
```typescript
meta: {
  source: 'walkie-talkie',
  from: msg.from,
  message_id: msg.id,
  ...(msg.channel && { channel: msg.channel }),
  ...(msg.reply_to && { reply_to: msg.reply_to }),
},
```

**Why:** Saves 2 characters per line and is a common JS idiom. Very minor. Both are perfectly readable.


## Non-Findings (things that are fine as-is)

**Poll loop using setTimeout recursion:** This is the correct pattern. `setInterval` would overlap if a poll takes longer than the interval. The recursive `setTimeout` naturally prevents overlap. No change needed.

**Ack protocol overall:** The poll-then-ack-or-nack flow is a real messaging pattern (similar to AMQP basic.ack). It is not over-engineered as a concept. The specific implementation has some unused branches (Finding 3) but the protocol itself is the right call for reliable delivery.

**Broker if/else chain (Finding 6):** As noted, this is fine at the current endpoint count. Adding a router framework would be over-engineering.

**Module-level mutable state (`NAME`, `ROLE`, `registered`):** These are process-level singletons for a single-purpose MCP server. Class wrapping or dependency injection would be over-engineering.

**`brokerFetch` wrapper:** This is the right level of abstraction. It sets the Content-Type header in one place. No change needed.


## Summary

```
[SIMPLIFICATION_REVIEW_COMPLETE]

Scope Reviewed:
- server.ts (352 lines) -- full review
- broker.ts (344 lines) -- full review

Critical Issues:
- 0 items (no dead code, no severe bloat)

Warnings:
- 2 items (Finding 1: duplicate registration guard, Finding 3: unused ack/nack branches)

Suggestions:
- 6 items (Findings 2, 4, 5, 6, 7, 8)

Lines Removable: ~45-55 (conservative, applying Findings 1-5)
Complexity Reduced: Notification retry loop simplified, ack/nack
  branching flattened, tool handler boilerplate deduplicated
```

### Recommended priority order

1. **Finding 1** (duplicate guard) -- quick win, removes a real DRY violation
2. **Finding 2** (brokerPost helper) -- pairs well with Finding 1
3. **Finding 5** (remove retry backoff) -- removes speculative complexity, eliminates worst-case 35s stall
4. **Finding 3** (flatten ack/nack branches) -- removes untested code paths
5. **Finding 4** (remove nack entirely) -- most aggressive, discuss before applying
6. **Findings 6-8** -- style-level, apply if touching those areas anyway
