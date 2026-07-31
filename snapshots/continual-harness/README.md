# Continual Harness-inspired Snapshot

This is a deliberately small Coral Actor–Refiner blueprint:

- Actor receives and emits `communication.sent`; the Swarm routes Actor messages
  to Refiner through the Definition.
- Refiner reviews the high-level outcome and proposes improvements.
- Actor and Refiner own separate workspaces.
- Their responsibilities and initial context live in those workspaces.
- Each workspace owns a `context.ts` that assembles its Harness messages.
- The default composer includes a compact runtime view of Agents, Routes, and
  authorized Plugin CLI commands without copying the Swarm Definition or any
  Plugin files into the workspace.
- Refiner communicates suggestions rather than editing Actor files directly.
- Role/context changes are ordinary owner workspace commits and affect that
  Agent's next turn immediately. Route, test,
  Harness, Plugin, or topology changes use a complete `SwarmDefinition`
  Proposal and remain Human-gated.

It borrows the Actor–Refiner idea. It is not a copy of, runtime integration
with, or compatibility claim for the upstream Continual Harness project.
