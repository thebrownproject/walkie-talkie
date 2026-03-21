# Documentation Review

Reviewed on 2026-03-22.

Scope: README.md, CLAUDE.md, skills/*.md, docs/SPEC.md. Cross-referenced against broker.ts and server.ts.

## Critical

### 1. README.md lines 131, 146: Event Bus curl examples use `"topic"` but broker expects `"channel"`

The broker's `/publish` endpoint (broker.ts:297) reads `body.channel`, not `body.topic`. Both Event Bus curl examples will produce a 400 error (`"from, channel, content required"`) because the JSON payload sends `"topic"` instead of `"channel"`.

**README.md:131:**
```json
{"from":"git","topic":"commits","content":"New commit: $MSG"}
```

**README.md:146:**
```json
{"from":"deploy-bot","topic":"deploys","content":"v2.3.1 deployed to staging"}
```

**Fix:** Replace `"topic"` with `"channel"` in both payloads.

### 2. README.md lines 128-132, 136-139, 143-147: Event Bus examples send from unregistered sessions

All three Event Bus examples (`git`, `test-runner`, `deploy-bot`) call `/publish` or `/broadcast` without first calling `/register`. The broker validates that `from` is a registered session (broker.ts:159, 301) and rejects with 403. Every example will fail as written.

**Fix:** Either add a `/register` curl call before each example, or add a note that the sender must be registered first.

### 3. SPEC.md: Entire file still uses "topic" terminology instead of "channel"

The code (broker.ts, server.ts) has been fully renamed to use `channel` in all API fields, variable names, and MCP tool schemas. SPEC.md still uses `topic` throughout:

- Line 26: "listen to topic-based channels"
- Line 66: `topics/` in architecture diagram
- Line 104: "Topic subscriptions (map of topic -> subscriber names)"
- Lines 116-118: Endpoint descriptions say "topic"
- Lines 139, 141: `Message` interface has `topic?: string` instead of `channel?: string`
- Line 164: "/publish routes to topic subscribers' inboxes"
- Line 166: "Note on broadcast vs topics"
- Lines 255: Notification meta uses `msg.topic`
- Lines 307-323: MCP tool schemas use `topic` parameter name instead of `channel`
- Lines 396-401: Example 3 uses "deploy topic"
- Lines 482-500: Task T4 describes "topic pub/sub"

**Fix:** Global rename of `topic` to `channel` throughout SPEC.md. This is not just cosmetic; anyone copying the SPEC's data structures or curl examples will get runtime failures.

### 4. SPEC.md lines 274-326: MCP tools list is missing the `join` tool

The "Exposed MCP Tools" section in SPEC.md lists five tools: send, broadcast, list_sessions, subscribe, publish. The actual code (server.ts:71-87) also exposes a `join` tool, which is the primary way sessions register. The SPEC's pseudocode at line 218 also omits `join` from the comment: "tool handlers (send, broadcast, list_sessions, subscribe, publish)".

Additionally, SPEC.md line 202 declares `NAME` as `const` but the actual code (server.ts:16) uses `let` because `join` mutates it.

**Fix:** Add the `join` tool to the tools list in SPEC.md. Update the `const NAME` to `let NAME` in the pseudocode.

### 5. SPEC.md line 222: Auto-register retry count is wrong

SPEC.md says "Register with broker (retry up to 10 times on failure)" and the pseudocode loops 10 times. The actual code (server.ts:247) only retries 3 times, and only when `WALKIE_TALKIE_NAME` is explicitly set. When not set, it does not auto-register at all and waits for the `join` tool.

**Fix:** Update SPEC pseudocode to match the actual registration logic: conditional on env var, 3 retries.

## Important

### 6. SPEC.md line 612: Known Limitation #4 is now false

Limitation 4 states: "No message acknowledgment -- messages are cleared from inbox on poll." This was true in v1 but is no longer accurate. The broker now implements a full ack/nack protocol (broker.ts:206-259) with in-flight tracking, partial ack/nack, and a 10-second safety timeout. The server uses it too (server.ts:327-346).

**Fix:** Remove or rewrite limitation #4. The README already documents the ack/nack protocol (line 149-156), so the SPEC contradicts it.

### 7. SPEC.md lines 109-119: Endpoint list is missing `/ack/:name` and `/nack/:name`

The broker exposes two additional endpoints that are not in the SPEC:

- `POST /ack/:name` (broker.ts:207) -- acknowledge successful delivery
- `POST /nack/:name` (broker.ts:234) -- return failed messages to inbox

These are actively used by the plugin's poll loop.

**Fix:** Add both endpoints to the SPEC's endpoint table.

### 8. SPEC.md lines 148-153: Health response is missing `total_in_flight_messages`

The SPEC's `Health` interface shows three fields. The actual broker (broker.ts:331-337) returns four:

```typescript
{
  status: 'ok',
  uptime_seconds: number,
  session_count: number,
  total_queued_messages: number,
  total_in_flight_messages: number  // MISSING from SPEC
}
```

**Fix:** Add `total_in_flight_messages` to the Health interface in SPEC.md.

### 9. SPEC.md lines 430-456: File structure diagram does not match actual layout

The SPEC describes a two-directory structure (`broker/` and `plugin/`) but the actual repo is flat:

| SPEC says | Actual |
|-----------|--------|
| `broker/server.ts` | `broker.ts` |
| `broker/package.json` | (one shared `package.json`) |
| `plugin/server.ts` | `server.ts` |
| `plugin/.claude-plugin/` | `.claude-plugin/` |
| `plugin/.mcp.json` | `.mcp.json` |
| `plugin/package.json` | (one shared `package.json`) |
| `plugin/skills/` | `skills/` |
| `examples/` | (does not exist) |

**Fix:** Update the file structure diagram to reflect the flat layout.

### 10. SPEC.md line 97: Component path is wrong

The SPEC refers to the broker as `broker/server.ts`. The actual file is `broker.ts` in the project root.

**Fix:** Update to `broker.ts`.

### 11. CLAUDE.md: Missing `unsubscribe` MCP tool documentation

CLAUDE.md lists six MCP tools in its reference table (join, send, broadcast, list_sessions, subscribe, publish). The broker exposes `DELETE /subscribe` for unsubscribing (broker.ts:279-291), but there is no corresponding MCP tool in server.ts. This creates a gap: a Claude session can subscribe to a channel but has no MCP tool to unsubscribe.

The README (line 96) also advertises `unsubscribe` as a feature: "subscribe / unsubscribe to tune in or out of channels."

**Fix:** Either add an `unsubscribe` MCP tool to server.ts (and document it in CLAUDE.md), or remove the unsubscribe claim from README.md line 96.

### 12. README.md lines 29-33: Quick Start installation commands may not match current Claude Code CLI

The Quick Start uses three commands:
1. `bunx walkie-talk` -- starts the broker (correct, matches package.json bin field)
2. `/plugin marketplace add thebrownproject/walkie-talkie` -- installs from marketplace
3. `/plugin install walkie-talkie@walkie-talkie` -- activates the plugin

These commands assume the plugin is published to the Claude Code plugin marketplace. If it is not yet published (per CODE-REVIEW.md finding #4 about the marketplace.json validation failure), these commands will fail for new users.

Additionally, the flag `--dangerously-load-development-channels` on line 33 is a long, specific flag name. If the Claude Code CLI has changed this flag name (e.g., to `--plugin` or `--load-plugin`), the Quick Start will break silently.

**Fix:** Verify these commands work with the current Claude Code CLI version. Add a "Local Development" alternative path for users who clone the repo.

### 13. README.md line 60: "MCP channel server" terminology

Line 60 calls the plugin an "MCP channel server." The start SKILL.md (lines 36-39) uses both "channel" and "server" variants of the `--dangerously-load-development-channels` flag with different prefixes (`server:walkie-talkie` vs `plugin:walkie-talkie@walkie-talkie`). This could confuse users about the distinction.

**Fix:** Clarify in README that "channel" refers to the Claude Code channels feature (the notification mechanism), not to Walkie-Talkie channels (the pub/sub feature). These are two different concepts sharing the same word.

## Minor

### 14. SPEC.md lines 31-33: Line count claims are outdated

SPEC.md claims "broker is ~150 lines, channel plugin is ~80 lines." Actual counts:
- broker.ts: 345 lines
- server.ts: 353 lines

These grew when ack/nack, the join tool, retry logic, and staggered delivery were added.

**Fix:** Remove specific line counts or update them.

### 15. SPEC.md lines 459-606: Task checklist is entirely unchecked

All tasks in Phases 1-5 are marked `[ ]` (incomplete), but essentially all of Phase 1-4 has been implemented. This is misleading for anyone reading the SPEC to understand project status.

**Fix:** Mark completed tasks as `[x]` or move the task list to a separate tracking file.

### 16. SPEC.md line 158: Broker configurable via `--port`

SPEC line 158 says the port is "configurable via `--port`." The actual code (broker.ts:7) reads from `WALKIE_TALKIE_PORT` env var, not a `--port` CLI flag. There is no argument parsing in broker.ts.

**Fix:** Change "configurable via `--port`" to "configurable via `WALKIE_TALKIE_PORT` env var."

### 17. SPEC.md line 161: `POST /register` description says "evicts the stale session"

The wording "evict stale" implies it only works when the existing session is stale. The actual code (broker.ts:103) unconditionally unregisters the existing session when `force: true`, regardless of whether it is stale.

**Fix:** Clarify that `force: true` unconditionally replaces the existing registration.

### 18. README.md line 52: Polling interval claimed as 2s

Line 52 says "polling every 2s". This matches server.ts:18 (`POLL_INTERVAL = 2000`). Accurate, no fix needed. Noting for completeness.

### 19. README.md line 198: Session auto-expire timeout

Line 198 says "Sessions auto-expire after 5 minutes of no polling." This matches broker.ts:8 (`STALE_TIMEOUT = 5 * 60 * 1000`). Accurate.

### 20. skills/start/SKILL.md line 19: Broker start command path

The start skill tells Claude to run `bun <path-to-plugin>/broker.ts &`. This is reasonable as a template but could be more explicit. The `package.json` defines `"broker": "bun broker.ts"` so `bun run broker` would also work from the project root.

Additionally, line 25 suggests `cd walkie-talkie && bun run broker &` which assumes the repo is cloned as `walkie-talkie/` in the current directory.

**Fix:** Consider referencing `bunx walkie-talk` (the npm bin command) as the primary start method, consistent with README Quick Start.

### 21. skills/list/SKILL.md: Does not mention channel subscriptions

The list skill says to display "Session name, Runtime, Role, Last seen timestamp." The actual `list_sessions` tool output (server.ts:195) also includes channel subscriptions when present. The skill should mention this.

**Fix:** Add "Subscribed channels (if any)" to the display list.

### 22. CLAUDE.md line 19: Receiving messages tag format

CLAUDE.md says messages arrive as `<channel source="walkie-talkie" from="...">` tags. The actual notification (server.ts:268-278) also includes `message_id`, and optionally `channel` and `reply_to` in the meta. The CLAUDE.md description is simplified but not wrong.

**Fix:** Consider listing the full set of meta attributes so Claude knows it can reference `message_id` and `reply_to` for threading.

### 23. No skill files for subscribe, publish, or unsubscribe

There are skills for start, join, list, send, and broadcast. There are no skills for:
- `/walkie-talkie:subscribe` -- subscribe to a channel
- `/walkie-talkie:publish` -- publish to a channel
- `/walkie-talkie:unsubscribe` -- unsubscribe from a channel (if the MCP tool is added)

These operations are available as MCP tools (documented in CLAUDE.md), so Claude can use them without skills. However, users have no slash-command entry point for channel pub/sub operations.

**Fix:** Either create skill files for subscribe and publish, or document in CLAUDE.md that these are tool-only operations without slash commands.

### 24. SPEC.md: Prior Art table entry for "Postal MCP" says "no topics"

Line 47: "No discovery, no topics, no registry." Should say "no channels" to match current terminology.

**Fix:** Replace "no topics" with "no channels."

## Summary

| Priority | Count | Key theme |
|----------|-------|-----------|
| Critical | 5 | Stale "topic" references cause runtime failures; SPEC MCP tools list missing `join`; Event Bus examples broken |
| Important | 8 | Missing ack/nack endpoint docs; wrong file structure; missing `unsubscribe` tool; SPEC contradicts implemented features |
| Minor | 11 | Outdated line counts; unchecked task list; terminology polish |

The most impactful fix is a global `topic` to `channel` rename across SPEC.md and the two README Event Bus examples. Everything a user would copy-paste from those sections will fail against the current broker.
