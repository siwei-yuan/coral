# Corallum

A small, zero-runtime-dependency implementation of a Harness-centered, Git-backed,
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
6. `Swarm` snapshots Main as Revisions, creates isolated whole-Swarm Forks,
   evaluates them, and promotes one selected Fork as the new Main after Human approval.
7. Plugins adapt external protocols to Event ingress, Event egress, or Harness
   tools. `ChatPlugin` is the first reference boundary.
8. `SnapshotStore` exports and imports complete reusable Swarm blueprints under
   `snapshots/`.

There is deliberately no workflow engine, generic ChangeSet system, extension
registry, database layer, CLI framework, or test framework.

## Source layers

```text
src/
├── core/
│   ├── ledger/
│   ├── workspace/
│   ├── agent/
│   └── swarm/
├── harness/
├── plugins/
└── snapshots/
```

Workspace knows only Git. Agent combines Workspace and a Harness. Swarm
combines Agents and commit IDs. Plugins and Snapshots remain outside Core.
The code is strict TypeScript executed directly by Node.js.

This first implementation keeps the Ledger and Swarm runtime in process while
using real Git repositories and worktrees. Persistence and native Harness
Adapters can be added behind the existing boundaries without changing the core
evolution protocol.

## Core lifecycle

```text
Main Swarm
  -> Revision Proposal, including tests, inputs, and Agent workspace heads
  -> isolated whole-Swarm Forks from that Proposal or any past Revision
  -> evaluate and select one Fork
  -> freeze that Fork as an immutable Revision snapshot
  -> Human Decision
  -> promote it atomically as the only Main
  -> continue Proposal-later Main workspace commits on top
```

A workspace commit immediately becomes that Agent instance's next state. It
never creates a Proposal implicitly. Workspace storage does not know about
Swarm Forks; a Fork merely starts with a set of Agent commit IDs.

Ordinary Agent collaboration uses only `communication.sent`. The active
Definition declares allowed Agent-to-Agent edges; Main and Forks validate those
edges and deliver each message to its recipients. Agents see the current Agent
set and communication graph in their runtime Swarm view.

A Revision is a point-in-time snapshot, not a second running Swarm and not a
barrier around later workspace work. Main and Forks run; Revisions only record
state. If Main Agents commit after a Proposal was created, those commits are
reapplied after the selected Fork's snapshot when it becomes the new Main.

Adding or removing an Agent is a complete `SwarmDefinition` Proposal. Every
workspace begins with a Framework-created, Ledger-backed root commit, and a new
Agent must provide that initial commit. Removing an Agent removes it
from the new Definition and heads but never deletes its Git or Ledger history.

An Agent may emit `swarm.revision.requested` with a complete Definition. After
that turn's workspace commit is recorded, Main turns it into the immutable
Proposal that enters the normal Fork, evaluation, and Human-gated lifecycle.

See [docs/DESIGN.md](docs/DESIGN.md).

## Snapshots

A Snapshot contains the complete Swarm Definition plus the seed workspace tree
for every Agent. Agent responsibilities, instructions, and initial context live
inside that Agent's workspace, where the Agent can change them through ordinary
Git commits. The workspace-owned `context.ts` decides how those files, current
input Events, and a runtime-generated compact Swarm view are assembled for the
Harness. An Agent may separately propose a modified complete Swarm Definition
through the human-gated revision lifecycle.

`snapshots/continual-harness/` is a small Actor–Refiner example inspired by the
Continual Harness pattern. It is a Corallum blueprint, not a vendored copy or a
claim of compatibility with another project.

## Run

```bash
npm run check
```
