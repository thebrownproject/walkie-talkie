# Code Review

Reviewed on 2026-03-22.

Compared against:
- The installed Telegram channel plugin at `~/.claude/plugins/cache/claude-plugins-official/telegram/0.0.1/server.ts`
- Claude Code channels documentation (`channels` and `channels-reference`)

## Critical

### 1. `server.ts:233` does not shut the channel process down when Claude closes the MCP connection

The Telegram reference handles stdin EOF explicitly because Claude Code closes channel servers by ending stdio, not by guaranteeing `SIGINT`/`SIGTERM`. Walkie-Talkie only registers `SIGTERM`, `SIGINT`, and `exit` handlers, and none of those handlers actually stop the poll loop or exit the process. That leaves a zombie broker client behind after the Claude session ends.

Why this is severe:
- `pollLoop()` keeps running every 2 seconds, so `last_seen` is refreshed forever
- stale-session cleanup in the broker never reaps the dead session
- the session name stays occupied
- incoming messages for that session get stuck in an endless `poll -> notification fail -> nack -> retry` cycle

The official Telegram plugin handles this at `server.ts:564` by listening to `process.stdin.on('end'|'close')` and forcing shutdown.

Suggested fix:
- add a `shuttingDown` guard
- listen to `process.stdin` `end` and `close`
- stop rescheduling `pollLoop()` once shutdown starts
- unregister from the broker before exiting
- force `process.exit(0)` after a short timeout

### 2. `broker.ts:57` and `server.ts:45` still lose messages on re-register / reconnect

The new ack/nack flow protects messages only while the same broker-side session survives. `unregister()` deletes both the inbox and `inFlight` batch. `POST /register` with `force: true` calls `unregister(name)` when the name already exists, and `registerWithBroker()` deletes the old registration before the new one is confirmed.

Failure cases:
- crash, restart, then re-join with the same name: any undelivered in-flight messages are dropped
- rename while messages are queued: old inbox is dropped
- rename when broker registration fails: old name is already deleted, `NAME` has already been mutated locally, and `registered` remains `true`, so the poll loop starts polling a name that was never registered

This is the main remaining hole in the "reliable delivery" story.

Suggested fix:
- never destroy `inFlight` on force re-register; move it back into the inbox first
- do not mutate `NAME` / `ROLE` locally until the new registration succeeds
- when changing names, register the new name first, then remove the old one only after success

## Important

### 3. `broker.ts:265` and `server.ts:275` forward unsanitized meta values into `<channel>` attributes

The official Telegram plugin sanitizes uploader-controlled values before placing them in channel metadata because delimiter characters can break the `<channel>` tag and forge extra attributes. Walkie-Talkie validates session names, but it does not validate or sanitize:
- `channel`
- `reply_to`

Both are caller-controlled and are copied directly into `mcp.notification({ params.meta })`.

Suggested fix:
- validate `channel` with the same kind of safe regex used for session names
- validate `reply_to` to the message ID format you actually emit, or sanitize all metadata values before sending them to Claude

### 4. `.claude-plugin/marketplace.json:1` is not valid under the current Claude Code validator

On Claude Code `2.1.80`, `claude plugin validate .` fails with:

```text
root: Unrecognized key: "description"
```

`plugin.json` validates cleanly, so the publish blocker is the marketplace manifest, not the plugin manifest.

Suggested fix:
- update `.claude-plugin/marketplace.json` to the schema accepted by the current validator
- treat `claude plugin validate .` as a release gate in CI

### 5. `package.json:1` will publish an unnecessarily large npm tarball

There is no `files` allowlist and no `.npmignore`. `.gitignore` only excludes `node_modules/` and `bun.lock`, so an npm publish will include:
- `docs/SPEC.md`
- `docs/telegram-reference.ts`
- `docs/telegram-readme.md`
- `assets/logo.png` (2.4MB)

That is unnecessary weight for the `walkie-talk` package and ships internal/reference material that is not needed at runtime.

Suggested fix:
- prefer a `files` allowlist in `package.json`
- only include runtime files and intentionally published docs
- either remove the local logo from the package or switch the README image to a remote URL

## Minor

### 6. `README.md:98` and `docs/SPEC.md:26` still have topic/channel and tool-surface drift

The code has already moved to `channel`, but the docs still contain old `topic` terminology and a few broken examples:
- `README.md:98` advertises `unsubscribe`, but there is no `unsubscribe` MCP tool in `server.ts`
- `README.md:133` and `README.md:148` still send `topic`, but the broker expects `channel`
- the event-bus examples send from unregistered names even though `/broadcast` and `/publish` reject unregistered senders
- `docs/SPEC.md` still documents topic-based schemas and examples throughout

These are easy to dismiss as docs issues, but they will produce immediate copy-paste failures for users.

Suggested fix:
- either add an `unsubscribe` tool or remove it from the docs
- replace `topic` with `channel` everywhere user-facing
- update every curl example to show `POST /register` first
