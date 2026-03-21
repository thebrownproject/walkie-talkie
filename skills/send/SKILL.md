---
name: send
description: "Send a message to another Walkie-Talkie session. Use when the user wants to message another session, communicate with another agent, or relay information."
---

# Send Message

Send a direct message to another connected session.

## Arguments

- First argument: target session name
- Remaining arguments: the message content

## Steps

1. Use the `send` MCP tool with:
   - `to`: target session name from first argument
   - `text`: message content from remaining arguments

2. Display confirmation with the message ID.

3. If the target is not found, suggest running `/walkie-talkie:list` to see who's online.
