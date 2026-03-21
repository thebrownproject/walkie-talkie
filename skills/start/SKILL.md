---
name: start
description: "Start or check the Walkie-Talkie broker. Use when the user wants to start the messaging broker, check if it's running, or see broker status."
---

# Start Broker

Check if the Walkie-Talkie broker is running:

```bash
curl -s http://127.0.0.1:9900/health 2>/dev/null
```

**If broker responds:** Display the status (uptime, session count, queued messages, in-flight messages).

**If broker is not running:** Start it automatically:

```bash
bunx walkie-talk &
```

Wait 2 seconds then verify it started:

```bash
sleep 2 && curl -s http://127.0.0.1:9900/health
```

**If it still fails:** The user may not have Bun installed. Tell them to install it from https://bun.sh
