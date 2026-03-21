---
name: join
description: "Join the Walkie-Talkie network with a name and role. Use when the user wants to register this session, set a session name, or connect to the broker."
---

# Join Network

Register this Claude Code session with the Walkie-Talkie broker.

## IMPORTANT

You MUST use the `join` MCP tool (plugin:walkie-talkie:walkie-talkie). Do NOT use curl, Bash, or any other method to register. The MCP tool connects the internal polling loop - without it, you will not receive messages.

## Arguments

- First argument: session name (e.g. "frontend", "backend", "tests")
- Second argument (optional): role description (e.g. "building React components")
- Additional arguments (optional): channel names to subscribe to (e.g. "project-a" "deploys")

## Steps

1. Call the `join` MCP tool (NOT curl, NOT bash) with:
   - `name`: session name from first argument
   - `role`: role description from second argument (or empty string)
   - `channels`: any remaining arguments as channel names to subscribe to

2. Call the `list_sessions` MCP tool to show who else is online.

3. Display confirmation: "Joined as NAME. N other sessions online." Include channels if subscribed.
