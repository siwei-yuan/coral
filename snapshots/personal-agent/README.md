# Personal Agent Snapshot

This Snapshot defines four independently evolving Agents:

- `chat-agent` knows the user, answers well, and shares user feedback.
- `memory-builder` learns from Screen activities and improves durable memory.
- `proactivity` learns to anticipate next steps and proposes timely outreach.
- `auditor` periodically reviews the other Agents and gives advice.

Chat is the only Agent that speaks directly to the user. Memory Builder and
Proactivity both receive Screen activity Events and can inspect the referenced
raw image, OCR, and foreground App session with the `screen` CLI. All four
Agents can create, remove, and list their own recurring schedules with the
`scheduler` CLI.

Schedule records, Chat queues, and Screen captures are live Plugin state and
are not part of this Snapshot. Each Agent creates schedules after it first
runs. A Scheduler firing enters the Swarm as `communication.sent` containing
the exact schedule, name, scheduled time, and Agent-authored note.

Each Plugin bundle pins its external `runtime.mjs`, Agent CLI, and optional
View extension as one Git commit. Agents named in `exposedTo` may evolve that
whole Plugin draft, but it becomes active only through a later approved Swarm
Revision.

Each role, memory layout, skill, and context composer lives in its Agent's
ordinary Git workspace. Routes, Plugin bindings, tests, and Agent composition
belong to the complete Swarm Definition and change only through a Human-gated
Revision Proposal.
