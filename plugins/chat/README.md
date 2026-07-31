# Chat Plugin

Chat provides local user ingress and Agent replies. Its optional View extension
is the bundled conversation UI.

## Flow

1. The View submits a user ID, conversation ID, and message.
2. The runtime stores the raw input under `<instance>/state/chat/inbox`.
3. The runtime emits one inbound `communication.sent` Event.
4. Swarm routes that Event according to `pluginIngress` in the active
   Definition.
5. An authorized Agent replies with the `chat` CLI.
6. The CLI writes the reply under `<instance>/state/chat/outbox`; the View
   renders it directly.

An Agent reply is an external Plugin effect, not an outbound Ledger Event.

## Agent command

```bash
chat reply \
  --conversation <id> \
  --to <external/user/id> \
  --caused-by <ledger-event-id> < message.txt
```

The body is read from standard input and preserves multiline text. The causal
Event ID prevents the reply from losing its connection to the user input even
though the reply itself is not a Ledger Event.

## State and scope

Chat state persists with the Instance but is excluded from Snapshots. The
current runtime is a local View-backed conversation surface; it does not
connect to a hosted chat service or deliver messages over a network.
