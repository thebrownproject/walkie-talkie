---
name: start
description: "Start or check the Walkie-Talkie broker. Use when the user wants to start the messaging broker, check if it's running, or see broker status."
---

# Start Broker

Check if the Walkie-Talkie broker is running:

```bash
curl -s http://127.0.0.1:9900/health 2>/dev/null
```

**If broker responds:** Display the status (uptime, session count, queued messages).

**If broker is not running:** Tell the user to start it:

```bash
bun <path-to-plugin>/broker.ts &
```

Or if they have the repo cloned:

```bash
cd walkie-talkie && bun run broker &
```

The broker runs in the background and persists across Claude Code sessions.
