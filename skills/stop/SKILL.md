---
name: stop
description: "Stop the Walkie-Talkie broker. Use when the user wants to shut down the broker, kill the broker process, or stop messaging."
---

# Stop Broker

Kill the Walkie-Talkie broker process:

```bash
pkill -f "broker.ts" 2>/dev/null || pkill -f "walkie-talk" 2>/dev/null
```

Then verify it stopped:

```bash
curl -s http://127.0.0.1:9900/health 2>/dev/null || echo "Broker stopped"
```

If it's still running, find and kill the process on port 9900:

```bash
lsof -i :9900 -sTCP:LISTEN -t | xargs kill
```
