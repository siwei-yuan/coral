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

The Ledger is a high-level causal spine. It records Communication, one Event per
logical Agent turn, workspace commits, and Swarm evolution. Native tool calls,
reasoning, file reads, model tokens, queue state, and Plugin transport details
remain in their native operational stores.

## Workspace ownership

An Agent writes its own workspace. It may read an explicit snapshot of another
Agent's released workspace and suggest changes through Communication Events.
The Workspace store only knows Git commits and worktrees; it has no Swarm Fork
abstraction. A workspace commit advances development history and never creates
a Swarm Proposal implicitly.

## Proposal-rooted Forks

A Proposal pins one base revision, the complete proposed Definition, every
initial Agent head, Plugin bindings, causal Events, and the test suite with its
input Events. Every Fork is a complete Swarm environment created from that
Proposal. All Forks begin with the same Definition and test inputs. Independent
execution and subsequent Agent changes may make their Events and commits
diverge.

Events remain in one physical hash chain. Active and Fork scopes control
visibility. A Fork sees active history through the Proposal frontier plus its
own scoped Events; it cannot see another Fork's Events.

One selected Fork is frozen into an immutable, globally closed Candidate
Revision. A Human Decision targets that exact Candidate. Only approval may move
the active revision pointer, and only if the expected base is still active.

An Agent may author a modified complete `SwarmDefinition`, including Agent
composition, Harness bindings, routes, tests, and Plugin bindings. This is
proposal authority, never authority to mutate the active Definition in place.

An Agent changes its own responsibility or context by editing its workspace.
That produces a workspace commit, not a Definition mutation. The commit becomes
active only when a later Swarm Revision pins and activates it.

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
