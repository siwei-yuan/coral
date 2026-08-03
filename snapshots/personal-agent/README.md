# Personal Agent Snapshot

This Snapshot pins the Codex Harness to `gpt-5.6-terra` with `high` effort,
uses the macOS-only Screen Plugin, and gives Chat Agent external tools through
the local Composio CLI. Install and authenticate both Codex and Composio first,
then read the Screen Plugin's
[privacy and permission notes](../../plugins/screen/README.md) and the
[Composio setup and safety notes](../../plugins/composio/README.md).

This Snapshot defines four independently evolving Agents:

- `chat-agent` knows the user, answers well, and shares user feedback.
- `memory-builder` learns from Screen activities and improves durable memory.
- `proactivity` learns to anticipate next steps and proposes timely outreach.
- `auditor` periodically reviews the other Agents and gives advice.

Chat is the only Agent that speaks directly to the user. Memory Builder and
Proactivity both receive Screen activity Events and can inspect the referenced
raw image, OCR, and foreground App session with the `screen` CLI. All four
Agents can create, remove, and list their own recurring schedules with the
`scheduler` CLI. Only Chat Agent receives the `composio` CLI; it can use the
user's connected external services for requested work without granting the
background Agents direct external write access. Signed Composio trigger
messages also route only to Chat Agent when trigger ingress is explicitly
enabled.

The Screen Plugin captures the foreground macOS window after meaningful,
debounced activity and removes visually unchanged frames. It performs accurate
local Apple Vision OCR on the full-resolution image, stores that image as PNG,
and creates a compressed JPEG preview separately. Each Ledger Event contains
only an activity ID; the receiving Agent explicitly loads its artifacts with
`screen activity <id>`.

Schedule records, Chat queues, and Screen captures are live Plugin state and
are not part of this Snapshot. Composio login, accounts, credentials, caches,
and artifacts are likewise external operational state rather than Snapshot
data. Each Agent creates schedules after it first runs. A Scheduler firing
enters the Swarm as `communication.sent` containing the exact schedule, name,
scheduled time, and Agent-authored note. Composio trigger ingress is enabled
only when `CORAL_COMPOSIO_TRIGGER_INGRESS=1` configures the official local
CLI-forwarded path. The Plugin generates its ephemeral loopback signing secret
at runtime.

Each Plugin bundle pins its external `runtime.mjs`, Agent CLI, and optional
View extension as one Git commit. Agents named in `exposedTo` may evolve that
whole Plugin draft, but it becomes active only through a later approved Swarm
Revision.

Each role, memory layout, skill, and context composer lives in its Agent's
ordinary Git workspace. Routes, Plugin bindings, tests, and Agent composition
belong to the complete Swarm Definition and change only through a Human-gated
Revision Proposal.

Create a fresh local Instance:

```bash
composio dev init -y --no-browser
export CORAL_COMPOSIO_TRIGGER_INGRESS=1
npm run coral -- create ./snapshots/personal-agent ./instances/personal-agent
```

Use the same ingress environment value with `coral start` when resuming the
Instance. Leave it unset when only outbound CLI tools are needed.

See [Snapshots](../README.md) for the reusable blueprint boundary and
[Operations](../../docs/OPERATIONS.md) for stop and resume.
