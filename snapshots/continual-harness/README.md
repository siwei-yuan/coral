# Continual Harness-inspired Snapshot

This is a deliberately small Corallum Actor–Refiner blueprint:

- Actor receives `task.requested` and emits `task.completed`.
- Refiner reviews the high-level outcome and proposes improvements.
- Actor and Refiner own separate workspaces.
- Refiner communicates suggestions rather than editing Actor files directly.
- Any role, context, route, test, or topology change is a complete
  `SwarmDefinition` Proposal and remains Human-gated.

It borrows the Actor–Refiner idea. It is not a copy of, runtime integration
with, or compatibility claim for the upstream Continual Harness project.
