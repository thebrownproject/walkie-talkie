# Performance Review: Walkie-Talkie

**Reviewer:** Performance Review Agent
**Date:** 2026-03-22
**Scope:** `broker.ts`, `server.ts`
**Context:** Lightweight localhost message broker for AI coding sessions. Expected scale: low tens of concurrent sessions, not hundreds.

## Critical Issues

### 1. Repeated ISO-string-to-timestamp parsing in stale cleanup (broker.ts:68)

```ts
if (now - new Date(s.last_seen).getTime() > STALE_TIMEOUT)
```

`last_seen` is stored as an ISO string and re-parsed into a Date every 30 seconds for every session. While this is O(n) per interval (acceptable), the real problem is that `last_seen` is also set via `new Date().toISOString()` on every poll (line 180), meaning it is written as a string and read back via parsing constantly. Storing `last_seen` as a numeric timestamp (`Date.now()`) internally would eliminate all Date construction and string parsing in both the hot poll path and the cleanup loop.

**Impact:** On 100 sessions, the cleanup creates 100 Date objects and parses 100 ISO strings every 30s. Each poll also constructs a new Date just to turn it into a string. Minor at current scale, but a free optimization.

**Suggested fix:** Store `last_seen` as `number` (epoch ms) internally. Only convert to ISO string in the `/registry` GET response.

### 2. Spread-copy arrays on in-flight timeout can spike memory (broker.ts:187)

```ts
inboxes.set(name, [...existing.messages, ...inbox])
```

When an in-flight batch times out, the entire message array is spread-copied. If `INBOX_CAP` is 100 and the in-flight batch also holds ~100 messages, this creates a new 200-element array (which then gets trimmed back to 100 by `enqueue` on the next message, but NOT here). The same pattern appears in nack (lines 250, 255).

**Impact:** The prepend-via-spread on timeout does not enforce `INBOX_CAP`. If a session repeatedly times out without polling, messages accumulate: the in-flight batch returns to the inbox (up to 100 items), new messages arrive (up to 100), and the combined array can exceed the cap because the cap is only enforced inside `enqueue()`, not in the timeout/nack code paths.

**Suggested fix:** After any inbox reconstruction (lines 187, 250, 255), apply the same cap: `if (inbox.length > INBOX_CAP) inbox.splice(0, inbox.length - INBOX_CAP)`. Consider extracting this into a helper.

## Important Issues

### 3. Sequential channel subscriptions in join tool (server.ts:152-158)

```ts
for (const channel of channels) {
  const res = await brokerFetch('/subscribe', { ... })
  if (res.ok) subscribed.push(channel)
}
```

Each subscription is a separate sequential HTTP request. If a user joins with 5 channels, that is 5 round-trips in series.

**Impact:** Join latency scales linearly with channel count. At localhost latency (~1ms) this is negligible, but it is an easy win for correctness of pattern.

**Suggested fix:** Use `Promise.all()` or add a batch subscribe endpoint to the broker.

### 4. Poll loop delivery stagger blocks the entire loop (server.ts:310-325)

```ts
for (let i = 0; i < messages.length; i++) {
  const ok = await deliverNotification(msg) // up to 3 retries with backoff (500+1000+2000 = 3.5s worst case)
  // ...
  await new Promise(r => setTimeout(r, NOTIFICATION_STAGGER_MS)) // 150ms
}
```

Delivery is fully sequential per message. For a batch of N messages where delivery fails:
- Best case: N * 150ms stagger = significant delay
- Worst case per message: 3 retries with exponential backoff = 500 + 1000 + 2000 = 3500ms
- Worst case for 10 failed messages: 10 * 3500ms + 9 * 150ms = ~36.35 seconds

During this entire period, the poll loop is blocked. No new messages are fetched or processed.

**Impact:** A transport hiccup that causes notification failures will stall the poll loop for tens of seconds. New messages queue up on the broker, and the `IN_FLIGHT_TIMEOUT` (10s) may expire during retry, causing the broker to return messages to the inbox (duplicating delivery attempts).

**Suggested fix:** Consider a circuit-breaker pattern: after 2 consecutive failures, nack the remaining batch immediately and schedule a shorter retry interval. Also consider delivering notifications concurrently (the stagger exists to avoid "overwhelming the transport", but 2-3 concurrent deliveries would be safe).

### 5. channels Map never shrinks (broker.ts:270, 287)

```ts
if (!channels.has(channel)) channels.set(channel, new Set())
channels.get(channel)!.add(name)
```

When a session unsubscribes or is cleaned up as stale, the session name is removed from the channel's Set (line 61, 287), but the channel key itself is never deleted from the Map, even when the Set becomes empty. Over time, the `channels` Map accumulates empty Sets for every channel name ever created.

**Impact:** Negligible memory at realistic scale (empty Sets are tiny), but it is a resource leak in principle. More importantly, `/publish` iterates an empty Set for dead channels, which is a wasted Map lookup.

**Suggested fix:** In `unregister()` and the unsubscribe handler, delete the channel key when its Set becomes empty:
```ts
if (subs.size === 0) channels.delete(channelName)
```

### 6. Object.fromEntries on sessions Map for every /registry call (broker.ts:128)

```ts
return json({ sessions: Object.fromEntries(sessions) })
```

This copies the entire sessions Map into a plain object, then `JSON.stringify` serializes it. It allocates a full intermediate object on every request.

**Impact:** At 100 sessions, this is trivial. At 1000+ sessions, you are creating a 1000-key object plus its JSON string on every health-check-style call. Unlikely to matter at actual scale.

**Suggested fix:** Could serialize directly from the Map if this ever becomes a hot path. Not urgent.

## Minor Issues / Suggestions

### 7. new Date().toISOString() called repeatedly for each message (broker.ts:146, 167, 310)

Every message creation calls `new Date().toISOString()`. When broadcasting to N sessions, the same timestamp is shared (good), but `new Date()` is constructed once per send/broadcast/publish call rather than being hoisted.

**Impact:** Negligible. Date construction is fast (~50ns in V8/JSC).

### 8. Regex validation runs on every /register call (broker.ts:98)

```ts
if (!/^[\w\-]{1,64}$/.test(name))
```

The regex is created inline on every request. In V8/JSC, literal regexes are typically cached by the engine, so this is likely a non-issue. Hoisting to a module-level `const NAME_RE = /^[\w\-]{1,64}$/` would make the intent clearer and guarantee no re-compilation.

**Impact:** Negligible.

### 9. Fire-and-forget cleanup on exit may not complete (server.ts:237)

```ts
fetch(`${BROKER}/register/${encodeURIComponent(NAME)}`, { method: 'DELETE' }).catch(() => {})
```

On `exit`, the process is dying and the fetch is fire-and-forget. The TCP connection may not complete before the process terminates. This means stale sessions can linger for up to 5 minutes (the `STALE_TIMEOUT`) even after a clean shutdown.

**Impact:** Not a performance issue per se, but stale sessions consume memory and show up in `/registry` results. The broker's 30s cleanup interval handles this eventually.

**Suggested fix:** For `SIGTERM` and `SIGINT`, await the fetch before exiting. Only use fire-and-forget for the `exit` event where you truly cannot await.

### 10. Poll response returns original inbox array reference (broker.ts:203)

```ts
inFlight.set(name, { messages: [...inbox], polled_at: Date.now() })
inboxes.set(name, [])
return json(inbox)
```

The original `inbox` array reference is passed to `json()` (which calls `JSON.stringify`). Meanwhile, the in-flight copy is a spread-copy. This is correct (stringify reads the array synchronously before the function returns), but the pattern is fragile. If Bun ever deferred serialization, the emptied inbox would serialize as `[]`.

**Impact:** No current issue. Defensive improvement only.

### 11. No request body size limit (broker.ts:88)

```ts
body = await req.json() as Record<string, unknown>
```

`req.json()` will parse an arbitrarily large body. A malicious or buggy client could send a multi-megabyte JSON payload and the broker would parse and allocate it all.

**Impact:** Localhost-only service reduces the threat surface. But if the broker is ever exposed on a network, this becomes a denial-of-service vector.

**Suggested fix:** Check `Content-Length` header and reject bodies above a reasonable limit (e.g., 64KB).

### 12. Linear routing -- all routes checked sequentially (broker.ts:95-340)

The request handler is a linear chain of `if` statements. Every request walks through all route checks until a match is found. The `/health` endpoint (likely the most frequently called) is the second-to-last check.

**Impact:** With ~12 route checks, each involving a string comparison, this costs roughly 100-200ns per request. Completely negligible for this use case.

**Suggested fix:** None needed. A router abstraction would add complexity without measurable benefit at this scale.

## Already Optimized

- **Self-scheduling poll loop (server.ts:296-351):** Using `setTimeout` instead of `setInterval` prevents overlapping poll requests. This is the correct pattern for an async poll loop.
- **INBOX_CAP (broker.ts:9, 54):** Inbox size is bounded at 100 messages, preventing unbounded memory growth on the hot path.
- **IN_FLIGHT_TIMEOUT (broker.ts:10, 184):** Messages that are polled but never acknowledged are returned to the inbox after 10 seconds. This prevents message loss.
- **Stale session cleanup (broker.ts:65-73):** The 30-second interval is appropriate. Checking timestamps on a Map of ~10-50 sessions is essentially free.
- **Ack/Nack protocol (server.ts:327-346):** Messages are not discarded until the client confirms delivery. Failed deliveries are nacked back to the broker. This is solid reliability design.
- **Notification stagger (server.ts:322-324):** 150ms between notifications is reasonable to avoid overwhelming a stdio transport.
- **Exponential backoff on retries (server.ts:283):** Prevents thundering-herd retries when the transport is struggling.
- **Bun.serve (broker.ts:75):** Bun's HTTP server is high-performance, single-threaded, and well-suited for this localhost use case.
- **localhost binding (broker.ts:76):** Binding to 127.0.0.1 avoids network overhead and security exposure.

## Scaling Estimate

| Sessions | Messages/sec | Expected Performance |
|----------|-------------|---------------------|
| 2-5 | Low | No issues whatsoever |
| 10-20 | Moderate | Comfortable. All operations are O(n) where n = sessions. |
| 50-100 | High | Broadcast creates 50-100 message copies per call. Stale cleanup iterates 50-100 sessions. Still fine. |
| 500+ | Very High | The `channels` Map leak and inbox spread-copies become relevant. The linear routing adds microseconds. Consider a proper message queue at this point. |

The practical ceiling for this architecture is around 100-200 concurrent sessions before you would want to consider structural changes. For its intended purpose (a handful of Claude Code sessions on one machine), this is well within comfortable limits.

## Summary

- **Critical:** 2 (timestamp parsing inefficiency, unbounded inbox on timeout/nack)
- **Important:** 4 (sequential subscriptions, poll loop blocking on retries, channels Map leak, registry serialization)
- **Minor/Suggestions:** 6 (repeated Date construction, inline regex, fire-and-forget cleanup, fragile array reference, no body size limit, linear routing)
- **Already Optimized:** 9 patterns identified as well-designed

The codebase is clean, well-structured, and appropriate for its scale. The two critical findings (timestamp storage format and inbox cap bypass on timeout/nack) are the highest-value fixes. The poll loop blocking during retry backoff (finding #4) is the most likely to cause user-visible issues in practice: a transport hiccup could stall message delivery for 30+ seconds.
