# Security Review

Reviewed on 2026-03-22.

Scope: `broker.ts`, `server.ts`, `skills/*.md`, `CLAUDE.md`, `.mcp.json`, `.claude-plugin/`, `package.json`.
Compared against: `docs/telegram-reference.ts` (official Telegram channel plugin).

Threat model: single developer, localhost only. No authentication by design. The review focuses on what can go wrong within that model and what breaks if the boundary assumptions are violated.

## Critical

### 1. Session impersonation via unverified `from` field

**broker.ts:132-150** (POST /send), **broker.ts:154-172** (POST /broadcast), **broker.ts:295-323** (POST /publish)

The broker checks that `from` is a registered session name, but it does not verify that the HTTP request actually originates from that session. Any process on localhost can send `{ "from": "backend", "to": "frontend", "content": "..." }` and the message will appear to come from "backend".

Within the localhost trust model this is accepted as a known limitation. However, any malicious or misbehaving local process (browser extension proxy, compromised npm script, rogue dev tool) can forge messages from any registered session. The recipient session has no way to distinguish genuine messages from forged ones.

The Telegram plugin does not have this problem because Telegram itself authenticates senders via user IDs.

**Risk:** A forged message from a trusted session name could trick an AI agent into executing destructive actions (deleting files, pushing code, running commands), especially since CLAUDE.md instructs agents to treat incoming channel messages as peer instructions.

**Suggested fix:**
- Issue a session-specific opaque token on registration (returned in the `/register` response).
- Require that token as a header or body field on `/send`, `/broadcast`, `/publish`.
- This does not add "real auth" but prevents one session from impersonating another.

### 2. No stdin EOF shutdown handler causes zombie polling loops

**server.ts:240-242**

Already identified in CODE-REVIEW.md (finding #1), but it has a security dimension. When Claude Code closes the MCP connection, the server process continues running. The zombie keeps polling the broker, refreshing `last_seen`, and occupying the session name. A subsequent legitimate session that tries to register the same name will need `force: true`, which destroys any queued messages (see finding #3 in CODE-REVIEW.md).

More critically, if notifications fail (as they will after stdin closes), the ack/nack cycle causes messages to bounce between inbox and in-flight indefinitely, consuming broker memory without limit over time.

The Telegram reference handles this at lines 567-580 with `process.stdin.on('end'|'close')` and a forced `process.exit(0)` after a 2-second timeout.

**Risk:** Resource exhaustion on the broker. Session name squatting prevents legitimate re-registration without force. Messages lost during force re-register.

**Suggested fix:**
- Add `process.stdin.on('end', shutdown)` and `process.stdin.on('close', shutdown)` as the Telegram plugin does.
- Set a `shuttingDown` flag to stop rescheduling `pollLoop`.
- Unregister from the broker before exiting.
- Force `process.exit(0)` after a short timeout.

## Important

### 3. Channel and reply_to metadata values are unsanitized

**server.ts:268-278** (deliverNotification)

The `meta` object sent via `mcp.notification` includes `msg.channel` and `msg.reply_to`, both of which are caller-controlled strings passed through from the broker without validation. Claude Code renders channel notifications as `<channel source="walkie-talkie" from="..." channel="..." reply_to="...">`. If a `channel` value contains `"` or `>` characters, it can break the XML-like tag structure and potentially inject additional attributes.

The broker validates session names with `/^[\w\-]{1,64}$/` (broker.ts:98) but applies no validation to `channel` names or `reply_to` values.

The Telegram plugin sanitizes all metadata values before placing them in notification params (it strips or escapes special characters from file extensions, unique IDs, etc. -- see telegram-reference.ts:527-528).

**Risk:** A malicious local process could register a session, then publish to a channel named `evil" injected="true` and the meta object would carry that unsanitized value into Claude's context. While the MCP SDK likely handles serialization safely at the JSON-RPC level, the rendered `<channel>` tag in Claude's context could be malformed.

**Suggested fix:**
- Validate `channel` names at the broker level with the same regex used for session names: `/^[\w\-]{1,64}$/`.
- Validate `reply_to` as a UUID format (or at minimum `/^[\w\-]{1,64}$/`).
- Alternatively, sanitize all meta values in `deliverNotification` before passing them to `mcp.notification`.

### 4. No validation on channel name or message content length at the broker

**broker.ts:263-277** (POST /subscribe), **broker.ts:295-323** (POST /publish)

Channel names have no length limit or character validation. A caller can subscribe to a channel name that is megabytes long, or create thousands of distinct channel names. Similarly, `content` on `/send`, `/broadcast`, and `/publish` has no size limit.

**Risk:** Memory exhaustion via:
- Creating channels with extremely long names (each stored as a Map key and in the session's subscriptions array).
- Sending messages with very large content bodies (each message is stored in the recipient's inbox).
- The 100-message inbox cap (broker.ts:54) limits message count but not total byte size -- 100 messages of 10MB each would consume 1GB per session.

**Suggested fix:**
- Validate channel names with the same `/^[\w\-]{1,64}$/` regex used for session names.
- Add a content size limit (e.g., 64KB) and reject requests that exceed it.
- Consider a per-session total inbox byte limit in addition to the message count cap.

### 5. Unbounded session registration allows resource exhaustion

**broker.ts:95-116** (POST /register)

There is no limit on the number of concurrent sessions. A script can register thousands of sessions in a tight loop, each consuming memory for the session object, an inbox array, and in-flight tracking. The 5-minute stale cleanup only runs every 30 seconds and only removes sessions that have not polled -- freshly registered sessions survive the full 5 minutes.

**Risk:** Memory exhaustion. The broker runs in-process with no memory limit, so this could crash the broker and lose all state.

**Suggested fix:**
- Add a session count cap (e.g., 50). Reject registration when the limit is reached.
- Optionally add rate limiting on `/register` (e.g., max 5 registrations per second).

### 6. DELETE /register/:name has no sender verification

**broker.ts:118-124**

Any local process can unregister any session by sending `DELETE /register/frontend`. There is no check that the requester is the session being unregistered, or any session at all. This allows:
- Kicking other sessions off the network.
- Destroying their inbox and in-flight messages.
- Forcing them to re-register (triggering message loss per CODE-REVIEW.md finding #2).

**Risk:** Denial of service against specific sessions. Message loss.

**Suggested fix:**
- If session tokens are implemented (see finding #1), require the session's own token to unregister it.
- At minimum, verify that the request includes a registered `from` name.

### 7. WALKIE_TALKIE_BROKER env var allows SSRF

**server.ts:15**

The broker URL is configurable via `WALKIE_TALKIE_BROKER`. If a user sets this to a non-localhost URL (intentionally or via env pollution), the server will send registration data, session names, roles, and message content to that remote endpoint. The `brokerFetch` function (server.ts:38-43) does not validate that the URL points to localhost.

Within the localhost trust model this is an edge case, but environment variable pollution is a realistic attack vector in CI/CD environments or when running inside containers with shared env.

**Risk:** Session metadata and message content exfiltrated to a remote server.

**Suggested fix:**
- Validate that the broker URL hostname resolves to `127.0.0.1` or `::1` before making any requests.
- Or at minimum, log a warning when the broker URL is not localhost.

### 8. Marketplace manifest exposes author email

**.claude-plugin/marketplace.json:7**

The `owner.email` field contains `fraserbrown@live.com`. This is a personal email address that will be published to the plugin marketplace and included in the npm tarball (since there is no `files` allowlist -- see CODE-REVIEW.md finding #5).

**Risk:** PII exposure. The email becomes permanently available in npm registry metadata and plugin marketplace listings.

**Suggested fix:**
- Remove the `email` field from `marketplace.json`, or replace it with a non-personal address.
- Add a `files` allowlist to `package.json` to control what ships in the npm tarball.

## Minor

### 9. Broadcast and publish can be used for inbox flooding

**broker.ts:154-172** (POST /broadcast), **broker.ts:295-323** (POST /publish)

A registered session can send unlimited broadcasts and publishes with no rate limiting. Each broadcast creates a copy in every other session's inbox. Combined with the 100-message inbox cap, a burst of 100 broadcasts will evict all legitimate messages from every session's inbox.

**Risk:** Denial of service. Legitimate messages lost due to inbox overflow.

**Suggested fix:**
- Add per-session rate limiting on `/broadcast` and `/publish` (e.g., max 10 per minute).
- Consider a separate rate limit for `/send` as well, though targeted sends are less impactful.

### 10. No rate limiting on poll endpoint

**broker.ts:175-204** (GET /poll/:name)

The poll endpoint has no rate limiting. A script can poll thousands of times per second, creating unnecessary load on the broker. While the poll is lightweight (Map lookup + array copy), the in-flight timeout logic (lines 183-190) and prepend operation (creating a new array) add allocation overhead.

**Risk:** CPU and GC pressure on the broker under aggressive polling.

**Suggested fix:**
- Add a minimum poll interval (e.g., reject polls more frequent than once per second per session).
- Or rely on the client-side `POLL_INTERVAL` and accept that non-MCP clients may poll more aggressively.

### 11. Error messages leak internal state

**broker.ts:138-139**

Error responses include the sender and target names:
```json
{ "error": "sender \"frontend\" not registered" }
{ "error": "target \"backend\" not found" }
```

This confirms to any caller whether a specific session name exists. The `/registry` endpoint already exposes all sessions openly, so this is not an additional information leak in the current design, but it would matter if registry access were ever restricted.

**Risk:** Low. Session enumeration is already possible via `/registry`.

**Suggested fix:**
- If `/registry` is ever gated, also genericize error messages to avoid confirming session existence.

### 12. `force: true` is always sent by the MCP server

**server.ts:57**

`registerWithBroker` always passes `force: true`. This means the MCP server will always overwrite any existing registration with the same name, destroying that session's inbox and in-flight messages without warning.

While this is intentional for crash recovery, it means that if two users independently choose the same session name (e.g., "frontend"), the second to register silently hijacks the name and the first loses all queued messages with no notification.

**Risk:** Accidental message loss and session disruption in multi-developer setups.

**Suggested fix:**
- Only use `force: true` on retry after a 409 response, rather than unconditionally.
- Or warn in the join tool response when a force re-register displaced an active session (one with recent `last_seen`).

### 13. Skills instruct agents to use curl and bash for broker operations

**skills/start/SKILL.md:11-12, 19-20**

The start skill includes `curl` and `bun ... &` commands for checking broker health and starting the broker. While this is necessary for the start skill (the broker runs outside Claude Code), it contrasts with CLAUDE.md's rule to "ALWAYS use MCP tools for all operations. Never use curl or Bash to interact with the messaging system."

An agent following the start skill could learn to use curl for other broker operations, bypassing the MCP server's registration state and poll loop.

**Risk:** Low. The start skill is a bootstrap step. But an agent that generalizes "I can curl the broker" could bypass the `registered` check in the MCP server.

**Suggested fix:**
- Add an explicit note in the start skill: "Use curl ONLY for broker health checks and startup. All messaging operations MUST go through MCP tools."

## Verified Secure

- **Broker binds to 127.0.0.1** (broker.ts:77). Confirmed in `Bun.serve({ hostname: '127.0.0.1' })`. Not `0.0.0.0`, not configurable via env var. Correctly prevents remote access.
- **Session name validation** (broker.ts:98). Names are validated against `/^[\w\-]{1,64}$/` at registration time. No injection via session names.
- **JSON parsing with error handling** (broker.ts:86-92). Malformed JSON bodies return a clean 400 error, no crash.
- **Sender registration check** (broker.ts:138, 159, 301). `/send`, `/broadcast`, and `/publish` all verify the sender is registered before routing messages. Unregistered senders get 403.
- **Inbox overflow protection** (broker.ts:53-54). Inbox is capped at 100 messages with FIFO eviction. Prevents unbounded inbox growth by message count.
- **Message IDs use crypto.randomUUID()** (broker.ts:142, 162, 307). UUIDs are cryptographically random, not predictable.
- **Stale session cleanup** (broker.ts:65-73). 30-second interval reaps sessions that have not polled in 5 minutes. Prevents permanent accumulation of dead sessions (assuming stdin EOF is fixed).
- **URI encoding on path parameters** (server.ts:52, 237, 298, 329, 340). Session names are `encodeURIComponent`-wrapped before being placed in URL paths. No path traversal via session names.
- **Graceful degradation when broker is offline** (server.ts:247-258). Server logs a warning and waits for the user to call `join` rather than crashing.
- **In-flight message recovery** (broker.ts:182-190). Timed-out in-flight messages are returned to the inbox, preventing permanent message loss during transient delivery failures.
- **No eval(), no dynamic code execution, no shell commands** in either broker.ts or server.ts. Message content is treated as opaque strings throughout.

## Summary

- Critical: 2
- Important: 6
- Minor: 5
- Verified Secure: 11

The most impactful issues are session impersonation (#1) and the zombie polling loop (#2). Both are straightforward to fix. The input validation gaps (#3, #4) and resource exhaustion vectors (#5, #9, #10) are worth addressing before any public release, especially since the broker runs with no memory limits. The SSRF risk (#7) and email exposure (#8) are environment-dependent but easy wins.
