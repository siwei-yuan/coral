# Design Contract

## First principles

1. An Agent evolves itself by changing and committing its own workspace.
2. A Swarm evolves as a whole through immutable Revision snapshots.
3. Every workspace and Swarm evolution remains traceable through Git and the Ledger.

Only Main and Forks are running states. A Revision is a point-in-time snapshot.

## Center and layers

The native Harness is the execution center. A thin Adapter drives it. Each
Agent owns a Git workspace through which it controls context, instructions,
memory, skills, code, and tests. Swarm composes Agents, routing, pinned tests,
Plugins, Proposals, Forks, evaluation, Human Decisions, and activation.

An Agent entry in `SwarmDefinition` declares only Swarm-level binding such as
identity and Harness. The Agent's responsibility, instructions, and initial
context live in its seed workspace, normally in `AGENTS.md` and `context/`.
This keeps every part of the Agent's editable self in the same Git history.

The workspace is deliberately plain:

```text
AGENTS.md
context.ts
context/initial.md
memory/
skills/
src/       # optional
test/      # optional
```

`context.ts` is an Agent-owned function that returns ordered role/content
messages. The Workspace Bridge supplies the current turn facts and a helper for
reading workspace files, then passes the result to the Harness Adapter. The
Bridge owns only this stable mechanism; the Agent owns the composition policy.

The Ledger is a high-level causal spine. Ordinary collaboration is represented
only by `communication.sent`; the other Core Events record logical Agent turns,
workspace changes, and Swarm evolution. Native tool calls,
reasoning, file reads, model tokens, queue state, and Plugin transport details
remain in their native operational stores.

## Code boundaries

```text
core/ledger
core/workspace
core/agent       -> Ledger + Workspace + Harness contract
core/swarm       -> Agent + Ledger + commit IDs
harness
plugins
snapshots
```

Workspace never imports Swarm. Agent Runtime knows no Proposal, Revision, or
Fork state machine. Swarm never performs Git operations directly. Harness
Adapters receive already-composed context plus a read-only function for exact
Agent workspace snapshots; context composition remains owned by the Agent.

## Workspace ownership

An Agent writes its own workspace. A commit immediately becomes that Agent
instance's next state, including changes to `context.ts`; no Proposal, Human
Decision, or activation is involved. During a turn it may read an exact,
read-only head of another current Agent's workspace and send suggestions using
`communication.sent`; it cannot write that workspace.
The Workspace store only knows Git commits and worktrees. It has no Swarm,
Revision, Proposal, or Fork abstraction.

Every workspace starts from exactly one root commit created by the Framework.
That commit contains the initial Agent files and is recorded as
`agent.workspace.initialized`; it is not attributed to an Agent turn. Bootstrap
Agents and Agents added by a Proposal must reference such an initial commit.

## Main, Revision snapshots, and Forks

Main is the one live Swarm. Its Agent workspace heads may advance after its
latest Revision. A Swarm Revision is only an immutable snapshot: one complete
Definition, the exact workspace head of every Agent at that point, Plugin
bindings, and audit references. `workspaceCommits` records the Git/Ledger
evidence represented by the snapshot; it does not gate ordinary workspace
changes or own later commits.

`SwarmDefinition` is the Agent graph; there is no second `GraphRevision` type.
Each Route is an allowed directed communication edge between two Agents. An
Agent emits `communication.sent` with recipients; Swarm validates each internal
recipient against the active edge and performs delivery. Main and Forks use the
same rule. Arbitrary application Event types are not part of this Core graph.

Adding or removing an Agent means proposing another complete Definition:

- A new Agent must have an independently initialized workspace commit and an
  entry in the Proposal's exact `agentHeads` set.
- A removed Agent must have no remaining Route or External Channel references.
- Removal never deletes its workspace repository, commits, or Ledger Events.
- Workspace commits made by an Agent before its removal remain in the new
  Revision's `workspaceCommits`, even though it is absent from final
  `agentHeads`.
- Rename is remove plus add.

A Proposal pins one base Revision, the complete proposed Definition, every
Agent head, the workspace commits accumulated since the base, Plugin bindings,
causal Events, and the test suite with its input Events.

A complete Swarm Fork may start from any stored Revision or any Proposal. It is
the Swarm equivalent of a Git worktree: an isolated, mutable whole-Swarm state.
A Revision Fork reproduces that historical snapshot. A Proposal Fork evaluates
the proposed state and may be selected. Forks from the same source begin with
the same Definition, Agent heads, Plugins, tests, and test inputs; their
subsequent Events and commits may diverge.

Events remain in one physical hash chain. Active and Fork scopes control
visibility. A Fork sees active history through its source Revision or Proposal
frontier plus its own scoped Events; it cannot see another Fork's Events.

One selected Fork is frozen into an immutable Candidate Revision snapshot. A
Human Decision targets that exact snapshot. Approval promotes the selected Fork
as the only new Main and marks its Revision active. Other Forks remain only as
auditable evaluation history.

Main may continue to receive Agent workspace commits after the Proposal was
created. At promotion, those Proposal-later commit tails are continued after
the selected Fork's snapshot. If the Fork did not change a workspace, its Main
head is retained unchanged. If both sides changed it, Main commits are reapplied
onto the Fork head and the old/new commit mapping is recorded in the activation
Event. A conflict leaves the old Main completely intact; activation is never
partial. Commits belonging to an Agent removed by the new Definition remain in
Git and the Ledger but are not part of the new Main.

An Agent may author a modified complete `SwarmDefinition`, including Agent
composition, Harness bindings, routes, tests, and Plugin bindings. This is
proposal authority, never authority to mutate the active Definition in place.
It emits `swarm.revision.requested`; after its turn and workspace commit finish,
Main creates the Proposal with that request Event as its cause.

An Agent changes its own responsibility, context, memory, skills, or context
composition by editing its workspace. The resulting commit affects its next
turn immediately. A later Swarm Revision may snapshot that head and reference
its commits alongside other Agents' commits; this does not change the commit's
workspace meaning.

## Agent Swarm view

Before every turn, Swarm projects the source Definition into an
`AgentSwarmView` containing the Agent's own ID, all Agent IDs, their routed
senders and recipients, Routes, external-facing status, authorized Plugin
commands/modes, source Revision/Proposal, and active/Fork scope. Proposal Forks
therefore see the proposed topology; historical Revision Forks see the
historical topology.

The view intentionally excludes tests and expected results, Plugin executable
paths and environment, secrets, other Agents' workspace contents, and Harness
trajectories. It is a runtime input, not a workspace file, so it cannot become
a stale second copy of the Definition.

The Workspace Bridge passes this structured view to `context.ts`. The default
Snapshot composer renders it as concise Markdown. An Agent may edit
`context.ts` to reorder, reformat, or omit it, preserving Agent ownership of
context composition while Core remains the source of topology facts.

`context.ts` currently executes in the Core process. The intended security
boundary is broader and simpler: the Agent Harness, Agent-owned code, and its
workspace should eventually run together inside one sandbox, while Swarm Core
and the Ledger remain outside. This boundary is recorded here but is not part
of the current implementation.

## Plugins

A Plugin owns an external runtime and exposes one shell command to selected
Agents. Its implementation and runtime data remain outside Agent workspaces.
`SwarmDefinition` declares the command, mode, and exact Agents that may see it;
the Harness receives those command descriptors for the turn. The current
implementation does not claim OS-level command isolation.

CLI calls are Harness operations, not Ledger Events. Semantic ingress and
egress still use `communication.sent`: Chat Runtime turns user input and Agent
CLI replies into Communication Events, while Screen Runtime announces a new
activity and lets the Agent query its raw image, OCR, and foreground App session
through the `screen` CLI. No Plugin copies files into or initializes an Agent
workspace.

Only the active Swarm may use live external egress. Forks replace live bindings
with mock mode.

### Deferred: Plugin-owned evolution

Plugin versioning is intentionally outside the current implementation. A future
Plugin may own an independent Git-backed folder containing its implementation,
Agent-facing contract, and optional executable helpers. Agents may inspect the
pinned folder read-only; a Plugin never initializes or modifies an Agent
workspace.

A future `SwarmDefinition` and Revision may pin the exact Plugin commit alongside
Agent workspace commits. Changing that pin would then be a Swarm-level change
that follows the normal Proposal, Fork evaluation, and Human activation path.
Mutable operational state such as screenshots, OCR output, App sessions,
credentials, cursors, and caches remains Plugin-owned runtime data outside that
Git commit. This is a recorded direction, not a current Core contract.

## Snapshots

A Snapshot is a portable, reusable Swarm blueprint:

```text
snapshot.json
agents/<agent-id>/...
```

`snapshot.json` contains the complete Definition and source revision evidence;
each Agent directory contains its seed workspace tree. Import initializes new
Agent Git repositories and returns the Definition plus their initial heads.

The Snapshot as a whole therefore initializes Agent roles and context even
though those fields are not duplicated inside `SwarmDefinition`.

A Snapshot intentionally excludes live Harness sessions, runtime queues,
secrets, Plugin connections, and low-level trajectories. It is a reusable
starting state, not a replacement for the Ledger or an exact forensic archive
of a running instance.
