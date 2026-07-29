# Corallum

A small, zero-runtime-dependency implementation of a Harness-centered, Git-backed,
human-gated Agent Swarm.

The name comes from the complete skeleton built by a coral colony: individual
polyps grow their own corallites, the colony grows as one structure, and its
layers preserve the history of that growth.

The runtime has nine concepts:

1. `Ledger` records high-level causal Events in one hash chain.
2. `GitWorkspaceStore` gives each Agent a plain writable Git workspace.
3. `WorkspaceBridge` runs the Agent-owned `context.ts` from that workspace.
4. `HarnessAdapter` drives a native Agent Harness.
5. `AgentRuntime` records one logical turn and any resulting workspace commit.
6. `Swarm` snapshots Main as Revisions, creates isolated whole-Swarm Forks,
   and atomically promotes an exact Fork frontier after Human approval.
7. Plugins own external runtimes and expose shell CLIs to authorized Agents.
   Chat and Screen are the first concrete bundles.
8. `SnapshotStore` exports and imports complete reusable Swarm blueprints under
   `snapshots/`.
9. `DefaultView` projects the Ledger into a local Human control surface for
   topology, evolution, Fork comparison, approval, and denial.

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
├── snapshots/
└── view/
    └── default/
plugins/
├── chat/
└── screen/
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
  -> normal Communication, Agent turn, and workspace Events inside each Fork
  -> View derives test evidence and compares Forks
  -> Human approves or denies one exact Fork frontier
  -> approval snapshots and promotes that Fork atomically as the only Main
  -> continue Proposal-later Main workspace commits on top
```

A workspace commit immediately becomes that Agent instance's next state. It
never creates a Proposal implicitly. Workspace storage does not know about
Swarm Forks; a Fork merely starts with a set of Agent commit IDs.

Ordinary Agent collaboration uses only `communication.sent`. The active
Definition declares allowed Agent-to-Agent edges; Main and Forks validate those
edges and deliver each message to its recipients. Agents see the current Agent
set and communication graph in their runtime Swarm view.

Each Plugin binding names one shell command and the Agents allowed to see it.
The Harness receives only those command descriptors; no Plugin file is copied
into an Agent workspace. Plugin CLI calls remain Harness operations. Chat user
input and new Screen activities enter the Swarm as `communication.sent`.
Agent output goes directly through a Plugin CLI and its runtime; it is not an
outbound Ledger Event.

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
Proposal that enters the normal Fork and Human-gated lifecycle. Evaluation is a
View projection over recorded facts, not a Core Event.

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

Once a `Swarm` is running, its built-in Human surface is one object:

```ts
const view = new DefaultView({ swarm, human: "owner" })
const { url } = await view.listen({ port: 3000 })
```

Other Views may read the same Ledger and call the same Human-gated Swarm
commands without inheriting the default renderer or server.

The default View renders every Plugin generically from its Definition and
inbound Communication Events: ingress destination, CLI exposure, and Event
flow. A Plugin may optionally provide a View-only extension. `ChatView` adds a
conversation surface backed by Chat's own sent-message store; `ScreenView`
renders Screen's raw image, OCR, and foreground App session. Extensions add UI
only and receive no Revision decision authority.
