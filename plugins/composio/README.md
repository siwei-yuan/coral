# Composio Plugin

Composio gives an authorized Agent the official locally installed Composio CLI
workflow and can turn official signed V3 trigger messages into inbound Coral
Communications.

## Setup

Install the published `composio` CLI, then authenticate it as the local user:

```bash
composio login
composio whoami
```

The wrapper resolves `composio` from `PATH`. Set
`CORAL_COMPOSIO_EXECUTABLE` in the Composio Plugin environment when deployment
needs an explicit executable path.

Connected accounts remain owned by Composio. Connect one interactively when
needed:

```bash
composio link github
```

An additional account should receive an alias. When a toolkit has multiple
active accounts, the Agent must pass `--account <id-or-alias>` instead of
guessing which identity to use.

Trigger commands and the local listener additionally require a developer
project bound to the current working directory:

```bash
composio dev init -y --no-browser
```

## Agent commands

The wrapper does not reimplement or allowlist the CLI. In live mode it delegates
arguments unchanged to the installed `composio` executable, matching the thin
integration used by Composio's official Claude Code and OpenClaw plugins. Use
the CLI's current help and official workflow:

1. `composio search "<task>"` when the tool slug is unknown;
2. `composio execute <slug> --get-schema` or `--dry-run` before guessing;
3. `composio link <toolkit>` when execution reports a missing connection;
4. retry `execute`; use `run` only for a real multi-step workflow.

`composio tools list <toolkit>` is the official fallback for enumerating a
known toolkit. The integration does not invent a separate all-tools catalog.

## Trigger ingress

Composio's official production route is one project webhook whose signed V3
envelopes are verified by the application handler. For local development,
Composio recommends forwarding the realtime stream to that same handler with
the CLI. Coral uses that local route:

```bash
CORAL_COMPOSIO_TRIGGER_INGRESS=1 \
npm run coral -- create ./snapshots/personal-agent ./instances/personal-agent
```

When enabled, the Plugin starts a loopback-only handler and runs the installed
CLI equivalent of:

```bash
composio dev listen --forward http://127.0.0.1:<port>/webhooks/composio
```

The Plugin generates a fresh local signing secret on each start and gives it
only to the CLI listener and loopback handler. The handler verifies the
documented HMAC-SHA256 signature and five-minute timestamp tolerance, ignores
non-trigger project events, and emits one
`communication.sent` whose content is the unchanged
`composio.trigger.message` V3 envelope. Its message `id` becomes the Coral
`externalRef`; `pluginIngress` decides which Agent receives it.

The resulting Coral ingress has this shape:

```json
{
  "type": "communication.sent",
  "schema": "composio.trigger.message",
  "actor": "plugin/composio",
  "data": {
    "from": "plugin/composio",
    "to": [],
    "source": { "plugin": "composio", "externalRef": "msg_abc123" },
    "content": [{
      "id": "msg_abc123",
      "type": "composio.trigger.message",
      "metadata": {
        "trigger_slug": "GMAIL_NEW_GMAIL_MESSAGE",
        "trigger_id": "ti_xyz789",
        "connected_account_id": "ca_def456",
        "auth_config_id": "ac_xyz789",
        "user_id": "user_123"
      },
      "data": {},
      "timestamp": "2026-08-03T12:00:00Z"
    }]
  }
}
```

`to` is deliberately empty when emitted. The active Swarm Definition's
`pluginIngress` entries fill the allowed Agent recipients; the Personal Agent
Snapshot configures `composio -> chat-agent`.

The CLI listener is the official local-development transport, not a production
runtime SLA. A remotely hosted Coral deployment should expose the same handler
through a public HTTPS endpoint registered as the Composio project webhook,
or use the official SDK/API; that deployment surface is not part of this local
Snapshot.

## State and safety

Composio's login, connected accounts, caches, and downloaded artifacts are
external operational state. They are not stored under the Coral Instance,
committed to the Plugin workspace, or included in a Snapshot.

The Plugin passes through the local user's filesystem and network authority;
Coral does not provide an OS sandbox. A Proposal Fork receives the binding in
`mock` mode, so the bundled wrapper and trigger listener refuse to run, but this
is not an OS-level restriction on separately invoking a globally installed
CLI. Trigger instances and connected accounts remain Composio operational
state; the Snapshot contains neither credentials nor trigger configuration.

## Source basis

This integration follows Composio's published examples and contracts:

- [Official Composio CLI workflow](https://docs.composio.dev/docs/cli)
- [Official Claude Code Plugin](https://github.com/ComposioHQ/composio-plugin-cc)
- [Official OpenClaw CLI guidance Plugin](https://github.com/composio-community/openclaw-composio-plugin)
- [Official trigger receiving, forwarding, envelope, and signature contract](https://docs.composio.dev/docs/setting-up-triggers/subscribing-to-events)
