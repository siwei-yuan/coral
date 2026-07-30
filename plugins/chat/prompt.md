# Chat

Chat is the direct user-facing conversation capability. Use it when an Agent
must reply to an external user in the conversation that produced the current
Event.

## Command

`chat reply --conversation <id> --to <external recipient> --caused-by <event id>`

Write the reply body to stdin. For a structured or multiline reply, use a
quoted heredoc so paragraphs and line breaks arrive exactly as written:

```bash
chat reply --conversation <id> --to <external recipient> --caused-by <event id> <<'CORALLUM_REPLY'
First paragraph.

Second paragraph.
CORALLUM_REPLY
```

Take the conversation, recipient, and causal Event ID from the inbound
Communication. Use `corallum send` instead when communicating with another
Agent.

## Consequences

A reply is written to the Chat outbox and becomes visible to the external user.
It is an external Plugin effect, not an outbound Ledger Event. Do not send a
reply merely to acknowledge internal work, and do not reply twice to the same
Event.
