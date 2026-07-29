# Continual Harness-inspired Snapshot

This is a deliberately small Corallum Actor–Refiner blueprint:

- Actor receives `task.requested` and emits `task.completed`.
- Refiner reviews the high-level outcome and proposes improvements.
- Actor and Refiner own separate workspaces.
- Their responsibilities and initial context live in those workspaces.
- Each workspace owns a `context.ts` that assembles its Harness messages.
- Refiner communicates suggestions rather than editing Actor files directly.
- Role/context changes are ordinary owner workspace commits and affect that
  Agent's next turn immediately. Route, test,
  Harness, Plugin, or topology changes use a complete `SwarmDefinition`
  Proposal and remain Human-gated.

It borrows the Actor–Refiner idea. It is not a copy of, runtime integration
with, or compatibility claim for the upstream Continual Harness project.
