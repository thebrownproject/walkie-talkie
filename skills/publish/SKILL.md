---
name: publish
description: "Publish a message to a Walkie-Talkie channel. Use when the user wants to send a message to a channel, notify a group, or post to subscribers."
---

# Publish to Channel

Send a message to all subscribers of a channel.

## Arguments

- First argument: channel name
- Remaining arguments: the message content

## Steps

1. Use the `publish` MCP tool with:
   - `channel`: channel name from first argument
   - `text`: message content from remaining arguments

2. Display confirmation with recipient count.
