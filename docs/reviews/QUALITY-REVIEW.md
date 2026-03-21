# Walkie-Talkie Quality Review

**Date:** 2026-03-22
**Scope:** `broker.ts`, `server.ts`
**Reference:** `docs/telegram-reference.ts` (Telegram channel plugin)

## Critical Issues

### C1. Partial ack returns wrong count when message_ids contain non-existent IDs

**File:** `broker.ts:224`

The `/ack/:name` endpoint returns `acked: acked.length` (the count of IDs the client sent), not the count of messages actually removed from the in-flight batch. If a client sends a message ID that does not exist in the batch, the response still claims it was acked.

```typescript
return json({ acked: acked.length, remaining: remaining.length })
```

**Suggested fix:** Track the actual number removed: `acked: batch.messages.length - remaining.length` (calculated before the `batch.messages = remaining` assignment). This prevents the client from getting a false confirmation that a non-existent message was acknowledged.

### C2. No unhandledRejection / uncaughtException handlers in server.ts

**File:** `server.ts` (missing, compare to `telegram-reference.ts:56-61`)

The Telegram reference has:

```typescript
process.on('unhandledRejection', err => { ... })
process.on('uncaughtException', err => { ... })
```

The walkie-talkie server.ts has none. An unhandled promise rejection (e.g., from `mcp.notification()` failing in a way `deliverNotification` does not catch, or from an unexpected `brokerFetch` failure) will crash the process silently. Since this is an MCP server running as a child process of Claude Code, a silent crash means the user loses messaging with no feedback.

**Suggested fix:** Add both handlers near the top of `server.ts`, logging to stderr. Even a single-line handler prevents silent death.

### C3. cleanup() uses fire-and-forget fetch on 'exit' event, which cannot complete

**File:** `server.ts:237-242`

The `cleanup` function fires `fetch()` (async HTTP request) and is registered on `process.on('exit', cleanup)`. The `exit` event handler runs synchronously -- async operations scheduled in an `exit` handler will never complete because the event loop is about to die. The fetch is truly dead code on `exit`.

`SIGTERM` and `SIGINT` can work since the process is still alive, but only if `cleanup` calls `process.exit()` afterward (otherwise the process continues). Currently it does not, so after SIGTERM/SIGINT the process stays alive.

**Suggested fix:** For SIGTERM/SIGINT handlers, await the fetch (or at minimum, call `process.exit(0)` after a short timeout). Remove the `exit` handler since it cannot do async work. The Telegram reference handles this differently -- it calls `bot.stop()` and then `process.exit(0)` with a 2-second safety timeout.

### C4. In-flight timeout check only runs during poll, not proactively

**File:** `broker.ts:183-190`

Timed-out in-flight messages are only recovered when the same session polls again. If a session polls, goes away without acking, and never polls again (crash, network issue), those messages are permanently stuck in `inFlight` until the session is reaped by the stale cleanup interval. The stale cleanup at line 65-73 does call `unregister()` which deletes the in-flight entry, but that means the messages are dropped rather than returned.

This is not catastrophic for v1 (messages are ephemeral), but is worth documenting as a known edge case. If a session crashes mid-delivery, those in-flight messages are lost.

**Suggested fix:** Document as a known limitation, or add in-flight timeout recovery to the 30-second cleanup interval so timed-out batches get returned to inboxes even if the session never polls again.

## Important Issues

### I1. Pervasive `as` casts on request body fields with no runtime validation

**File:** `broker.ts:96, 107-109, 133-135, 147, 155-156, 211, 238, 264-265, 298-299`
**File:** `server.ts:144, 148-149, 169, 171, 183, 191, 207, 217`

Both files extract fields from parsed JSON with `as string`, `as string[]`, etc. with no runtime validation beyond null checks. Examples:

```typescript
const name = body.name as string    // broker.ts:96
const acked = body.message_ids as string[] | undefined  // broker.ts:211
```

If `body.name` is a number, `body.message_ids` is a string instead of an array, or `body.content` is an object, the code proceeds with the wrong type. The broker is localhost-only so this is not a security issue, but it can produce confusing runtime errors.

**Suggested fix:** Add lightweight validation functions or at minimum `typeof` guards for the critical fields (`name`, `from`, `to`, `content`, `message_ids`). Even something like:

```typescript
if (typeof body.name !== 'string') return json({ error: 'name must be a string' }, 400)
```

### I2. MCP tool inputSchema missing `type: 'object'` on some schemas, inconsistent `as const`

**File:** `server.ts:74-86, 91-99, 103-110, 115, 120-126, 129-138`

The tool input schemas use `type: 'object' as const` on some schemas (e.g., join, send, broadcast, list_sessions) which is correct for the MCP SDK. However, the schemas lack `additionalProperties: false` which the Telegram reference also omits, so this is consistent.

The `list_sessions` schema at line 115 has `required: []` (empty array). Per JSON Schema, this is technically valid but misleading. It would be cleaner to omit `required` entirely when there are no required properties.

**Suggested fix:** Minor cleanup. Consider omitting `required: []` on `list_sessions`, replacing with just `{ type: 'object' as const, properties: {} }`.

### I3. Spec-to-implementation drift: "topic" vs "channel"

**File:** `docs/SPEC.md` uses "topic" throughout; `broker.ts` and `server.ts` use "channel"

The spec defines `topic` as the field name on messages and the subscribe/publish parameter. The actual implementation uses `channel`. This creates confusion when reading the spec alongside the code. The Message interface in broker.ts uses `channel?: string` (line 27), while the spec's Message interface shows `topic?: string`.

**Suggested fix:** Update SPEC.md to match the implementation (channel), or vice versa. Whichever you prefer, but they should agree.

### I4. Poll loop can overlap if broker is slow to respond

**File:** `server.ts:295-352`

The `pollLoop` function uses `setTimeout(pollLoop, POLL_INTERVAL)` at the end, which correctly prevents overlapping in the normal case. However, if `brokerFetch` hangs indefinitely (no timeout configured on fetch), the next poll never fires. The Telegram reference does not have this issue because grammy's `getUpdates` has a built-in long-poll timeout.

**Suggested fix:** Add an `AbortController` with a timeout to the poll fetch:

```typescript
const controller = new AbortController()
const timeout = setTimeout(() => controller.abort(), 5000)
const res = await brokerFetch(`/poll/...`, { signal: controller.signal })
clearTimeout(timeout)
```

### I5. registerWithBroker sets NAME before confirming success

**File:** `server.ts:46-64`

```typescript
const oldName = NAME
NAME = name      // set immediately
ROLE = role      // set immediately
// ... then try to register
const res = await brokerFetch('/register', { ... })
if (!res.ok) {
  // NAME and ROLE are already changed, but registration failed
  throw new Error(...)
}
```

If registration fails (broker down, name validation error), `NAME` and `ROLE` have already been mutated. Subsequent operations (poll loop, cleanup) will use the new name even though the broker does not know about it. The old name was also unregistered on line 52, so the session is now in limbo with neither name registered.

**Suggested fix:** Only mutate `NAME` and `ROLE` after confirming the register response is ok:

```typescript
if (registered && oldName !== name) {
  await brokerFetch(`/register/${encodeURIComponent(oldName)}`, { method: 'DELETE' }).catch(() => {})
}
const res = await brokerFetch('/register', { ... })
if (!res.ok) { throw ... }
NAME = name   // only after success
ROLE = role
registered = true
```

### I6. `enqueue` silently drops messages for unregistered sessions

**File:** `broker.ts:50-55`

```typescript
function enqueue(name: string, msg: Message) {
  const inbox = inboxes.get(name)
  if (!inbox) return   // silent drop
```

This is called from `/send` (line 149), `/broadcast` (line 169), `/publish` (line 318), and the in-flight timeout recovery (line 187). For `/send`, the caller already validates the target exists. But for `/broadcast` and `/publish`, if a session was unregistered between the `sessions.keys()` iteration and the `enqueue` call (race condition via concurrent request), the message is silently dropped for that session.

This is very unlikely in practice (single-threaded Bun), but the pattern is fragile. The real risk is that `inboxes` and `sessions` could get out of sync if a bug is introduced later.

**Suggested fix:** Either add a debug log in the `if (!inbox) return` branch, or ensure `inboxes` always has an entry when `sessions` does (which it currently does, but is not enforced by a type or abstraction).

## Minor Issues / Suggestions

### M1. Inconsistent naming: `channel` in broker vs `topic` in spec, `text` in server vs `content` in broker

**File:** `server.ts:95, 169` / `broker.ts:135`

The MCP tools use `text` as the parameter name for message content, but the broker API uses `content`. The server translates between them:

```typescript
body: JSON.stringify({ from: NAME, to: args.to, content: args.text, ... })
```

This is fine functionally, but a new contributor reading the tool schema (`text`) and the broker API (`content`) might be confused. Consider adding a brief comment in server.ts explaining the mapping, or aligning the names.

### M2. `let` used for constants that could be `const`

**File:** `server.ts:17` - `let ROLE` is reassigned in `registerWithBroker`, so `let` is correct. But the ALL_CAPS naming convention suggests a constant. Consider renaming to `currentRole` or similar to signal mutability.

**File:** `server.ts:16` - Same for `let NAME`. Consider `currentName`.

### M3. No timeout on initial broker registration retry loop

**File:** `server.ts:247-253`

The startup retry loop tries 3 times with a 2-second delay. If the broker is permanently down, this blocks MCP server startup for 6 seconds. This is acceptable, but the Telegram reference exits hard on missing config (`process.exit(1)`) while walkie-talkie degrades gracefully. The graceful degradation is actually better UX here -- just noting the difference.

### M4. Stale timeout interval not cleaned up on shutdown

**File:** `broker.ts:65-73`

The `setInterval` for stale session cleanup is never cleared. For a long-running broker process this does not matter, but if the broker were ever imported as a module (for testing, for example), the interval would prevent garbage collection.

**Suggested fix:** Store the interval handle and clear it on shutdown, or call `.unref()` on the interval.

### M5. Notification stagger delay fires even when there is only one message

**File:** `server.ts:322-324`

The condition `if (i < messages.length - 1)` correctly avoids the stagger after the last message, so this is actually fine. No issue here, just confirming the logic is correct.

### M6. `brokerFetch` always sets Content-Type to application/json, even for GET requests

**File:** `server.ts:38-43`

```typescript
headers: { 'Content-Type': 'application/json', ...opts?.headers },
```

GET requests (poll, registry) do not have a body, so `Content-Type: application/json` is meaningless. This is harmless but technically incorrect per HTTP semantics.

**Suggested fix:** Only set Content-Type when there is a body, or accept this as a minor imperfection.

### M7. Missing `stdin` close handler that Telegram reference uses for clean shutdown

**File:** `server.ts` (missing, compare to `telegram-reference.ts:577-578`)

The Telegram reference listens for `stdin` end/close to detect when Claude Code closes the MCP connection:

```typescript
process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)
```

Walkie-talkie only listens for SIGTERM and SIGINT. If Claude Code closes the MCP connection by closing stdin (which is the normal shutdown path for stdio-based MCP servers), the walkie-talkie server might not unregister from the broker and could linger as a zombie process.

**Suggested fix:** Add `process.stdin.on('end', cleanup)` and `process.stdin.on('close', cleanup)` alongside the existing signal handlers.

### M8. Spec says "60 seconds" for stale, code uses 5 minutes

**File:** `docs/SPEC.md:156-157` vs `broker.ts:8`

The spec says "Sessions that haven't polled in 60 seconds are marked stale" then "5 minutes are automatically unregistered." The code has a single STALE_TIMEOUT of 5 minutes. There is no "marked stale" intermediate state -- sessions go straight from active to unregistered. This is simpler and probably better, but the spec is misleading.

### M9. The `json` helper does not handle serialization errors

**File:** `broker.ts:43-48`

If `JSON.stringify(data)` throws (e.g., circular reference), the error propagates up to Bun's fetch handler. Bun would likely return a 500, but the error message would be unhelpful. This is extremely unlikely given the simple data structures in use.

## What is Good

- **Clean architecture.** The broker/server split is well-conceived. The broker is stateless HTTP, the server handles MCP transport. Either can be swapped independently.

- **Ack/nack protocol.** This is a significant improvement over the spec's "messages cleared on poll" approach. The in-flight tracking with timeout recovery is thoughtful and handles the happy path well.

- **Consistent error handling pattern.** Both files use the same `try/catch -> { content, isError: true }` pattern for MCP tool errors. The broker returns structured JSON errors with appropriate HTTP status codes.

- **Self-scheduling poll loop.** Using `setTimeout` at the end of `pollLoop` instead of `setInterval` prevents overlapping polls. This is a better pattern than the spec's `setInterval` suggestion.

- **Delivery retry with backoff.** `deliverNotification` retries 3 times with exponential backoff (500ms, 1000ms, 2000ms). Combined with the nack protocol, failed deliveries are retried on two levels.

- **Graceful degradation.** The server starts even if the broker is unreachable, allowing the user to join later. This is better UX than hard-failing.

- **Minimal surface area.** Both files are well under 400 lines. No over-engineering, no unnecessary abstractions. The code does what it needs to and nothing more.

- **Consistent stderr logging.** Both files prefix log messages clearly (`broker:` / `walkie-talkie:`), making it easy to filter in multiplexed output.

## Summary

- **Critical:** 4
- **Important:** 6
- **Minor/Suggestions:** 9

The most impactful fixes are C2 (unhandled rejection handlers), C3 (cleanup on exit), I5 (name mutation before confirmation), and M7 (stdin close handler). These four together would significantly improve process lifecycle reliability. The type safety issues (I1) are a maintainability concern that grows with the codebase but are acceptable for v1.
