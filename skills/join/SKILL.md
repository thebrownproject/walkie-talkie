---
name: join
description: "Join the Walkie-Talkie network with a name and role. Use when the user wants to register this session, set a session name, or connect to the broker."
---

# Join Network

Register this Claude Code session with the Walkie-Talkie broker.

## Arguments

- First argument: session name (e.g. "frontend", "backend", "tests")
- Second argument (optional): role description (e.g. "building React components")

## Steps

1. Set the session name from the argument provided
2. Register with the broker by calling the MCP send tool or via:

```bash
curl -X POST http://127.0.0.1:9900/register \
  -H "Content-Type: application/json" \
  -d '{"name":"SESSION_NAME","role":"ROLE","runtime":"claude-code","force":true}'
```

3. Fetch the registry to show who else is online:

```bash
curl -s http://127.0.0.1:9900/registry
```

4. Display confirmation: "Joined as SESSION_NAME. N other sessions online."
