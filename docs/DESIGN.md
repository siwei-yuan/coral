# Design Contract

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

The Ledger is a high-level causal spine. It records Communication, one Event per
logical Agent turn, workspace commits, and Swarm evolution. Native tool calls,
reasoning, file reads, model tokens, queue state, and Plugin transport details
remain in their native operational stores.

## Workspace ownership

An Agent writes its own workspace. A commit immediately becomes that Agent
instance's next state, including changes to `context.ts`; no Proposal, Human
Decision, or activation is involved. It may read an explicit snapshot of
another Agent's workspace and suggest changes through Communication Events.
The Workspace store only knows Git commits and worktrees. It has no Swarm,
Revision, Proposal, or Fork abstraction.

## Swarm revisions and Forks

A Swarm Revision is an immutable aggregate of one complete Definition and the
workspace commits produced by multiple Agents since its parent Revision. It
also records the resulting head for every Agent. The Revision references those
commits; it does not turn ordinary workspace commits into gated changes.

A Proposal pins one base Revision, the complete proposed Definition, every
Agent head, the workspace commits accumulated since the base, Plugin bindings,
causal Events, and the test suite with its input Events.

A complete Swarm Fork may start from any stored Revision or any Proposal. A
Revision Fork reproduces that historical Swarm state. A Proposal Fork evaluates
the proposed state and may be selected for a Candidate Revision. Forks from the
same source begin with the same Definition, Agent heads, Plugins, tests, and
test inputs; their subsequent Events and commits may diverge.

Events remain in one physical hash chain. Active and Fork scopes control
visibility. A Fork sees active history through its source Revision or Proposal
frontier plus its own scoped Events; it cannot see another Fork's Events.

One selected Fork is frozen into an immutable, globally closed Candidate
Revision. A Human Decision targets that exact Candidate. Only approval may move
the active revision pointer, and only if the expected base is still active.

An Agent may author a modified complete `SwarmDefinition`, including Agent
composition, Harness bindings, routes, tests, and Plugin bindings. This is
proposal authority, never authority to mutate the active Definition in place.

An Agent changes its own responsibility, context, memory, skills, or context
composition by editing its workspace. The resulting commit affects its next
turn immediately. A later Swarm Revision may aggregate that commit alongside
commits from other Agents; this does not change the commit's workspace meaning.

## Plugins

A Plugin adapts an external protocol to Event ingress, Event egress, and/or
Harness tools. Chat reuses `communication.sent`; it does not invent another
message lifecycle. Genuine domain facts may use Plugin-owned namespaced Event
schemas. Plugin operations are not Ledger Events merely because they occurred.

Only the active Swarm may use live external egress. Forks use disabled,
read-only, sandbox, or mock bindings.

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
