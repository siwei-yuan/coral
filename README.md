# Corallum

A small, zero-runtime-dependency implementation of a Harness-centered, Git-backed,
human-gated Agent Swarm.

The name comes from the complete skeleton built by a coral colony: individual
polyps grow their own corallites, the colony grows as one structure, and its
layers preserve the history of that growth.

The runtime has nine concepts:

1. `Ledger` records high-level causal Events in one hash chain.
2. `GitWorkspaceStore` provides plain Git workspaces for Agent and Plugin code.
3. `WorkspaceBridge` runs the Agent-owned `context.ts` from that workspace.
4. `HarnessAdapter` drives a native Agent Harness.
5. `AgentRuntime` records one logical turn and any resulting workspace commit.
6. `Swarm` snapshots Main as Revisions, creates isolated whole-Swarm Forks,
   and atomically promotes an exact Fork frontier after Human approval.
7. Plugins own external runtimes and Git-backed code, expose shell CLIs to
   authorized Agents, and activate only through exact Swarm Revision pins.
8. `SnapshotStore` exports and imports reusable Swarm blueprints under
   `snapshots/`; `deploySnapshot` starts one as a fresh Swarm instance.
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
│   ├── plugin/
│   ├── agent/
│   └── swarm/
├── harness/
├── deployment/
├── snapshots/
└── view/
    └── default/
plugins/
├── chat/
├── screen/
└── scheduler/
```

Workspace knows only Git. Agent combines Workspace and a Harness. Plugin Core
adds commit Events to Plugin workspaces. Swarm combines Agents and exact commit
IDs. Concrete Plugin runtimes and Snapshots remain outside Core. The code is
strict TypeScript executed directly by Node.js.

This implementation keeps the Ledger and Swarm runtime in process, uses real
Git repositories and worktrees, and includes native Codex, Claude Code, and Pi
Adapters. Durable runtime persistence remains separate from deploying a
Snapshot as a fresh Swarm; neither changes the evolution protocol.

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

Every `agent.turn.recorded` Event identifies the resumable Harness session,
provider checkpoint, and Corallum turn marker. Normal turns resume that session.
A workspace commit or Swarm snapshot boundary makes the next turn fork the
recorded checkpoint, so a Revision or Proposal frontier identifies both the
exact Agent workspace and its trajectory without copying session history into
the Ledger.

Ordinary Agent collaboration uses only `communication.sent`. The active
Definition declares allowed Agent-to-Agent edges; Main and Forks validate those
edges and deliver each message to its recipients. Agents see the current Agent
set and communication graph in their runtime Swarm view.

Each Plugin binding pins one exact Git commit, names one shell command, and
declares the Agents allowed to call it. On Main, an authorized Agent receives
the CLI from the active pin plus its editable Plugin draft workspace. The draft
may accumulate commits without changing active execution. A Proposal Fork sees
only its pinned Plugin code in mock mode; Human approval of the complete Swarm
Revision activates that pin. No Plugin file is copied into an Agent workspace.
Plugin CLI calls remain Harness operations. Chat user input and new Screen
activities enter the Swarm as `communication.sent`.
Agent output goes directly through a Plugin CLI and its runtime; it is not an
outbound Ledger Event. Scheduler configuration also goes through its CLI;
schedule firings enter as inbound Communications carrying the exact recurring
duration and Agent-authored note.

Every Plugin commit also contains `prompt.md`. Core supplies the active prompt
and editable Plugin workspace binding to each authorized Agent's `context.ts`,
so capability instructions evolve with the pinned implementation without being
copied into Agent workspaces.

A Revision is a point-in-time snapshot, not a second running Swarm and not a
barrier around later workspace work. Main and Forks run; Revisions only record
state. If Main Agents commit after a Proposal was created, those commits are
reapplied after the selected Fork's snapshot when it becomes the new Main.

Adding or removing an Agent is a complete `SwarmDefinition` Proposal. Every
workspace begins with a Framework-created, Ledger-backed root commit, and a new
Agent must provide that initial commit. Removing an Agent removes it
from the new Definition and heads but never deletes its Git or Ledger history.

An Agent uses `corallum send` for routed communication and `corallum propose`
for a complete candidate Definition. These commands record private turn
actions; after the Harness returns, Core commits workspace changes, validates
the actions, and appends the authoritative Events. A Harness cannot emit
arbitrary Ledger Events. Evaluation is a View projection over recorded facts,
not a Core Event.

See [docs/DESIGN.md](docs/DESIGN.md).

## Snapshots

A Snapshot contains the complete Swarm Definition, the seed workspace tree for
every Agent, and a Git bundle carrying every exact Plugin commit pinned by the
Definition. Agent responsibilities, instructions, and initial context live
inside that Agent's workspace, where the Agent can change them through ordinary
Git commits. The workspace-owned `context.ts` decides how those files, current
input Events, and a runtime-generated compact Swarm view are assembled for the
Harness. An Agent may separately propose a modified complete Swarm Definition
through the human-gated revision lifecycle.

`snapshots/continual-harness/` is a small Actor–Refiner example inspired by the
Continual Harness pattern. It is a Corallum blueprint, not a vendored copy or a
claim of compatibility with another project.

`snapshots/personal-agent/` defines Chat Agent, Memory Builder, Proactivity, and
Auditor as four independently evolving workspaces. Chat, Screen, and Scheduler
bindings live in its Swarm Definition; live messages, captures, and schedules
remain Plugin-owned runtime state outside the Snapshot.

Every Plugin commit contains `runtime.mjs`, `bin/<command>.mjs`, and optionally
`view.mjs`. An authorized Agent edits all of them through the same Plugin draft
workspace. Only a Human-approved Swarm Revision changes the commit used by the
running runtime, Agent CLI, and optional View together.

## Run

```bash
npm run check
```

Deploy a portable Snapshot as a fresh running Swarm:

```ts
const deployment = await deploySnapshot({
  snapshots: new SnapshotStore("./snapshots"),
  name: "personal-agent",
  instanceRoot: "./instances/personal-agent",
  human: "owner",
})

const { url } = await deployment.view.listen({ port: 3000 })
```

Once a `Swarm` is running, its built-in Human surface is one object:

```ts
const view = new DefaultView({ swarm, human: "owner" })
const { url } = await view.listen({ port: 3000 })
```

Other Views may read the same Ledger and call the same Human-gated Swarm
commands without inheriting the default renderer or server.

The default View projects a pannable, zoomable Git-style evolution tree from
Ledger Events. Revision, Proposal, Fork, Decision, and activation state remain
clickable nodes; Agent cards show the current workspace head and resumable
Harness checkpoint, while turn rows expose causal input and committed effects.
It also renders every Plugin generically from its Definition and inbound
Communications. A Plugin may optionally provide a View-only extension.
The pinned Chat Plugin adds a conversation surface and the pinned Screen Plugin
renders raw image, OCR, and foreground App session. Extensions add UI only and
receive no Revision decision authority.

Screen capture is event-driven and macOS-local. Its Event carries only an
activity ID; authorized Agents call `screen activity <id>` to load OCR and
image paths from Plugin state when needed. Screenshot bytes never enter the
Ledger or automatic Agent context.
