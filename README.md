# Corallum

A small, zero-dependency implementation of a Harness-centered, Git-backed,
human-gated Agent Swarm.

The name comes from the complete skeleton built by a coral colony: individual
polyps grow their own corallites, the colony grows as one structure, and its
layers preserve the history of that growth.

The runtime has eight concepts:

1. `Ledger` records high-level causal Events in one hash chain.
2. `GitWorkspaceStore` gives each Agent a plain writable Git workspace.
3. `WorkspaceBridge` runs the Agent-owned `context.ts` from that workspace.
4. `HarnessAdapter` drives a native Agent Harness.
5. `AgentRuntime` records one logical turn and any resulting workspace commit.
6. `Swarm` implements Revision/Proposal-rooted parallel Forks, evaluation, Candidate
   freeze, Human Decision, and atomic activation.
7. Plugins adapt external protocols to Event ingress, Event egress, or Harness
   tools. `ChatPlugin` is the first reference boundary.
8. `SnapshotStore` exports and imports complete reusable Swarm blueprints under
   `snapshots/`.

There is deliberately no workflow engine, generic ChangeSet system, extension
registry, database layer, CLI framework, or test framework.

This first implementation keeps the Ledger and Swarm runtime in process while
using real Git repositories and worktrees. Persistence and native Harness
Adapters can be added behind the existing boundaries without changing the core
evolution protocol.

## Core lifecycle

```text
Active Swarm
  -> Revision Proposal, including tests, inputs, and Agent workspace commits
  -> complete Swarm Forks from that Proposal or any past Revision
  -> same Definition and inputs run independently in every Fork
  -> evaluate and select one Fork
  -> freeze immutable Candidate Revision
  -> Human Decision
  -> activate atomically
```

A workspace commit immediately becomes that Agent instance's next state. It
never creates a Proposal implicitly. Workspace storage does not know about
Swarm Forks; a Fork merely starts with a set of Agent commit IDs.

See [docs/DESIGN.md](docs/DESIGN.md).

## Snapshots

A Snapshot contains the complete Swarm Definition plus the seed workspace tree
for every Agent. Agent responsibilities, instructions, and initial context live
inside that Agent's workspace, where the Agent can change them through ordinary
Git commits. The workspace-owned `context.ts` decides how those files and the
current input Events are assembled for the Harness. An Agent may separately
propose a modified complete Swarm Definition through the human-gated revision
lifecycle.

`snapshots/continual-harness/` is a small Actor–Refiner example inspired by the
Continual Harness pattern. It is a Corallum blueprint, not a vendored copy or a
claim of compatibility with another project.

## Run

```bash
npm test
```
