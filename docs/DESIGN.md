# Design Contract

## First principles

1. An Agent evolves itself by changing and committing its own workspace.
2. A Swarm evolves as a whole through immutable Revision snapshots.
3. Every evolution is reconstructable from Git and the Event Ledger.

Only Main and Forks are running states. A Revision is a point-in-time snapshot.
These principles meet at an Agent checkpoint: a workspace commit identifies the
Agent's editable self, while `agent.turn.recorded` identifies its resumable
Harness session, checkpoint, and exact Corallum turn marker. A Revision or
Proposal frontier therefore locates both without copying native trajectories
into the Ledger.

## Center and layers

The native Harness is the execution center. A thin Adapter drives it. Each
Agent owns a Git workspace through which it controls context, instructions,
memory, skills, code, and tests. Swarm composes Agents, routing, pinned tests,
Plugins, Proposals, Forks, Human Decisions, and activation.

An Agent entry in `SwarmDefinition` declares only Swarm-level binding: identity,
Harness, and turn policy. The Agent's responsibility, instructions, and initial
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
core/plugin      -> Plugin Git workspace + commit Events
core/agent       -> Ledger + Workspace + Harness contract
core/swarm       -> Agent + Ledger + commit IDs
harness
plugins
snapshots
view/default     -> Ledger projection + Human commands
```

Workspace never imports Swarm. Agent Runtime knows no Proposal, Revision, or
Fork state machine. Swarm never performs Git operations directly. Harness
Adapters receive already-composed context plus concrete checkouts for exact
peer workspace heads; context composition remains owned by the Agent.

## Workspace ownership

An Agent writes its own workspace. A commit immediately becomes that Agent
instance's next state, including changes to `context.ts`; no Proposal, Human
Decision, or activation is involved. During a turn it may read an exact,
read-only head of another current Agent's workspace and send suggestions using
`communication.sent`; it cannot write that workspace.
The Workspace store only knows Git commits and worktrees. It has no Swarm,
Revision, Proposal, or Fork abstraction.

The Agent owns edits, review, commits, and commit messages. The Driver owns the
checkout, validates that the worktree is clean and that HEAD is a linear
descendant of the turn's base, retains accepted commits, advances the Agent
head, and records one `agent.workspace.committed` Event per commit. It never
invents a commit on the Agent's behalf. A dirty worktree is restored to its
current HEAD and records `agent.workspace.restored` without failing the turn;
uncommitted changes never affect the Agent head. Writable Plugin draft
workspaces use the same contract and `plugin.workspace.restored`; their accepted
commits advance only the draft head until a Swarm Revision pins and activates
one.

Every workspace starts from exactly one root commit created by the Framework.
That commit contains the initial Agent files and is recorded as
`agent.workspace.initialized`; it is not attributed to an Agent turn. Bootstrap
Agents and Agents added by a Proposal must reference such an initial commit.

## Harness sessions and checkpoints

Each Agent workspace lineage has a corresponding native Harness session
lineage. A normal turn resumes the current session. When the Agent produces a
new workspace commit, the next turn forks the completed Harness checkpoint and
binds the new branch to that commit. An unchanged workspace does not create a
new session branch.

Every `agent.turn.recorded` contains the Corallum turn ID and a `trajectory`
reference with the Harness, resumable session ID, and trajectory turn marker.
Codex supplies a native turn ID; Claude Code and Pi use the Corallum turn marker
embedded in their native session history. The Event also records the input and
output workspace commits. The pair is sufficient to project Agent state:

```text
Agent state = workspace commit + Harness checkpoint
```

A session also advances on turns that do not change the workspace. Therefore a
workspace commit alone is not a historical checkpoint. A Revision or Proposal
uses its Ledger frontier to select the last visible `agent.turn.recorded` for
each Agent. Before Main continues beyond such a frontier, its next turn lazily
forks that checkpoint. This freezes the source without making an empty model
call or rebuilding context from scratch.

A Swarm Fork starts each Agent from the source workspace commit and source
Harness checkpoint. F1/F2/F3 fork those same checkpoints into independent
native sessions. The selected Fork's sessions and workspaces become Main;
activation never cold-starts them. Harness sessions are operational storage,
not Ledger Events or Revision fields. Their exact checkpoints are recoverable
through the turn Events and snapshot frontier.

The Adapter is the complete Harness driver; there is no separate Core session
history or capability graph. When a Harness exposes a daemon, its lifetime
belongs to deployment rather than to an Agent turn. One Codex App Server serves
the deployment while each Agent keeps an independent resumable or forked
thread. Claude Code uses resumable/forked sessions, and Pi uses its RPC/session
tree. Native tools, compaction, token usage, and internal messages remain owned
by those Harnesses.

## Main, Revision snapshots, and Forks

Main is the one live Swarm. Its Agent workspace heads may advance after its
latest Revision. A Swarm Revision is only an immutable snapshot: one complete
Definition, the exact workspace head of every Agent at that point, Plugin
bindings, and audit references. `workspaceCommits` records the Git/Ledger
evidence represented by the snapshot; it does not gate ordinary workspace
changes or own later commits.

`SwarmDefinition` is the Agent graph; there is no second `GraphRevision` type.
Each Route is an allowed directed communication edge between two Agents. An
Agent invokes `corallum send`; Swarm validates each internal recipient against
the active edge, records `communication.sent`, and performs delivery. Main and
Forks use the same rule. Arbitrary application Event types are not part of this
Core graph.

Each Agent has one in-memory Event queue and at most one running turn. Routing
to one Agent never waits for another Agent. `single-event` consumes one queued
Event per turn; `batch-events` consumes every Event waiting when the next turn
starts. Queue operations are runtime state, not Ledger Events. The resulting
`agent.turn.recorded` Event references every input Event consumed by that turn.

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

A complete Swarm Fork may start from any stored Revision or any Proposal. A
Human creates it through a View. It is
the Swarm equivalent of a Git worktree: an isolated, mutable whole-Swarm state.
A Revision Fork reproduces that historical snapshot. A Proposal Fork evaluates
the proposed state and may be selected. Forks from the same source begin with
the same Definition, Agent heads, Plugins, tests, and test inputs; their
subsequent Events and commits may diverge.

Events remain in one physical hash chain. Active and Fork scopes control
visibility. A Fork sees active history through its source Revision or Proposal
frontier plus its own scoped Events; it cannot see another Fork's Events.

Fork execution records only its normal test inputs, Communications, Agent turns,
and workspace commits. Test results are a View projection over those facts;
there is no evaluation Event or Candidate state. A Human approves or denies an
exact Fork frontier. Approval atomically snapshots that Fork as a new Revision
and promotes it as the only Main. Denial records the Decision and preserves the
Fork as audit history without creating a Revision.

Activation briefly stops new Main turns and waits only for turns already in
progress. It does not drain pending queues. Queued Events for retained Agents
continue against the activated Main; activation refuses to remove an Agent
while that Agent still has pending Events. A Proposal alone neither pauses Main
nor captures operational queues.

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
It invokes the native `corallum propose` command. After the Harness turn and
workspace commits finish, Swarm validates the complete Definition, heads,
Plugin pins, and tests, then creates `swarm.revision.proposed` with the turn
Event as its cause. There is no intermediate request Event. Only Human approval
creates and activates a new Revision.

The complete Core Event model and its only writers are:

- `communication.sent`: Plugin/user ingress through Swarm, or an Agent `send`
  action materialized by Swarm after its turn.
- `agent.workspace.initialized`, `agent.workspace.committed`,
  `agent.workspace.restored`, and `agent.workspace.reapplied`: Workspace
  initialization, accepted Agent commits, discarded uncommitted changes, and
  activation reapplication, respectively.
- `plugin.workspace.initialized`, `plugin.workspace.committed`, and
  `plugin.workspace.restored`: Plugin Git evolution and discarded uncommitted
  changes recorded by Plugin Workspace Runtime.
- `agent.turn.recorded`: one Core-recorded logical Harness turn and its exact
  trajectory checkpoint; it is never emitted by the Agent or Harness.
- `swarm.revision.proposed`: Swarm materializes a validated complete Proposal
  from an Agent `propose` action.
- `swarm.fork.created`: a Human-created isolated state from a Revision or
  Proposal, recorded by Swarm.
- `swarm.decision.recorded`: Swarm records a Human approval or denial of an
  exact Fork frontier.
- `swarm.revision.activated`: the complete immutable Revision snapshot after a
  successful approval, recorded by Swarm.

Screen activity and Scheduler firings are typed content inside
`communication.sent`, not new top-level Event types. Arbitrary
`*.requested` application Events are not Core primitives. There is deliberately
no `swarm.revision.requested`, `swarm.fork.evaluated`,
`swarm.fork.selected`, or pre-approval `swarm.revision.frozen` Event.

An Agent changes its own responsibility, context, memory, skills, or context
composition by editing its workspace. The resulting commit affects its next
turn immediately. A later Swarm Revision may snapshot that head and reference
its commits alongside other Agents' commits; this does not change the commit's
workspace meaning.

## Agent Swarm view

Before every turn, Swarm projects the source Definition into an
`AgentSwarmView` containing the Agent's own ID, all Agent IDs, their routed
senders and recipients, incoming Plugin names, authorized Plugin commands and
modes, source Revision/Proposal, and active/Fork scope. Proposal Forks
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

A Plugin is one Git-backed, deployable code unit:

```text
runtime.mjs          external world -> Swarm
bin/<command>.mjs    Agent -> Plugin or external world
prompt.md            Plugin-owned context input for this capability
view.mjs             optional Plugin-owned View extension
```

Mutable runtime data remains outside both Plugin and Agent workspaces.
`SwarmDefinition` pins the exact code commit and declares the command, mode,
and Agents that may call it. Deployment starts `runtime.mjs` from that checkout
and the Harness receives `bin/<command>.mjs` from the same checkout. The
optional View is returned by the runtime and has no control-plane authority.
The current implementation does not claim OS-level isolation.

`prompt.md` explains the capability, when and how to use it, and the effects of
using it. Core reads it from the active pin and gives it, plus the editable
Plugin workspace binding, to the Agent's `context.ts`. The Agent owns whether
and how it enters context. The prompt is never copied into the Agent workspace,
stored in an Event, returned dynamically by the runtime, or versioned
separately. A Swarm Revision activates Plugin code, CLI, runtime, and prompt as
one Git commit.

CLI calls are Harness operations, not Ledger Events. Plugin Events are inbound:
Chat turns user input into a Communication Event, while Screen
announces a new activity and lets the Agent query its raw image, OCR, and
foreground App session through the `screen` CLI. Agent output takes the reverse
path directly through a Plugin CLI and the Plugin-owned runtime. Chat reply
bodies arrive on stdin so multiline text does not depend on shell argument
escaping. Agent output does not
become an outbound Ledger Event. No Plugin copies files into or initializes an
Agent workspace.

Every runtime exports one `start()` function. Deployment gives it its Plugin
ID, binding mode, operational state directory, environment, and one `emit()`
function that accepts only inbound Communication drafts. The runtime owns its
external integrations and loops and returns `stop()` plus an optional View
extension. Deployment contains no Chat-, Screen-, or Scheduler-specific code.

Corallum itself exposes two Harness-neutral shell commands. `corallum send`
records an Agent's request to communicate along a declared Route; `corallum
propose` submits a complete candidate Definition. During the turn these
commands append only to a private turn-scoped action file. After the Harness
returns, Core commits workspace changes, validates each action, and creates the
authoritative Ledger Event. An Agent cannot choose Event IDs, actors, scope,
causation, workspace Events, turn Events, or activation Events. Harness
Adapters therefore return only outcome and trajectory checkpoint; there is no
generic `events[]` output contract.

Each `pluginIngress` entry is one allowed Plugin-to-Agent edge. A Plugin may
have multiple entries. An inbound Event with no recipients is routed to all of
that Plugin's ingress targets; explicit recipients must be a subset of those
targets. This is not a bidirectional channel. `plugins[].exposedTo` separately
says which Agents can see that Plugin's CLI. Each CLI is exposed through a
turn-scoped command wrapper that binds only that Plugin's operational
environment, including the current Agent ID and binding mode. Environments from
different commands never merge into the Harness process. Forks replace live
bindings with mock mode; actual runtime isolation remains part of the deferred
Agent-plus-workspace sandbox.

Scheduler is a normal Plugin, not a Core service. Its CLI lets an Agent set,
remove, and list its own named recurring durations and notes. The Plugin runtime
owns its clock loop and emits due inbound Communications; deployment starts the
Plugin but never polls schedules or configures one for an Agent. Each
firing contains the name, exact duration, scheduled time, and note, and
explicitly targets the schedule owner. Schedule configuration is a CLI operation
rather than a Ledger Event. The current version deliberately has no cron
grammar, calendar recurrence, workflow engine, or Scheduler-specific View.

Screen is also entirely Plugin-owned. Its pinned runtime starts a small macOS
helper that observes activity signals without storing keys or pointer data.
App/window changes and settled input bursts are coalesced into sparse captures;
low-resolution frame comparison drops unchanged candidates before Apple Vision
OCR, and OCR is reused when the detected text crop has not changed. The helper
captures only the foreground window, limits stored images to 1600px-wide JPEG,
and stops capture work while the display sleeps or the user remains inactive.

Several accepted captures form one foreground App activity. The Plugin writes
the images and OCR atomically under its operational state before emitting one
`screen.activity` Communication. That Event contains only the activity ID.
Agents use `screen activity <id>` to load App timestamps, OCR, and local image
paths on demand; image bytes and base64 never enter the Ledger or automatic
Harness context. Raw activities expire independently of Plugin code, by default
after seven days or when their store exceeds 2 GiB. The implementation has no
video recorder, database, search index, or Screen-specific Core service.

## Views

A View is a first-class Human control surface, not a Plugin and not part of a
`SwarmDefinition`. It reads the Ledger, projects topology and evolution, and may
issue only explicit Human commands: create a Fork, approve a Fork frontier, or
deny a Fork frontier. Core validates the command and records its result.

The default implementation lives in `src/view/default`. It has no database or
private lifecycle model. Replaying the Ledger reconstructs active topology,
Revision and Proposal history, Fork heads and evidence, Agent Harness
checkpoints, derived test results, collaboration, and Human Decisions. Its
local HTTP surface renders a pannable and zoomable Git-style evolution tree,
Agent state, causal turns, Fork comparison, and the raw Ledger. Node details
remain collapsed until selected; the canvas never invents evaluation state or
decorative data.

The default View understands Plugins only through their Definition and inbound
Communication Events. It renders ingress routing and CLI exposure without any
Chat- or Screen-specific branches. An active pinned Plugin runtime may return
an optional `ViewExtension`. The extension owns only its page, read-only
resources, its own Plugin-authored Events, and actions. Chat adds a live message
surface backed by its Plugin store. Screen pages retained capture metadata,
lazy-loads previews, and resolves
OCR plus the referenced Ledger Event only when a Human opens a capture. The
extension code evolves with the Plugin commit but is not separately declared in
`SwarmDefinition` and is never given Fork, approve, or deny authority.

The Ledger is the control-plane source of truth, not a container for all raw
bytes. A View follows Ledger references to Git for workspace files, Harness
storage for trajectory excerpts, and Plugin stores for artifacts such as raw
screenshots. Alternative open-source Views can use the same Ledger projection
or build their own without changing Core.

### Git-backed Plugin evolution

Plugin evolution follows the same draft-versus-active separation as Agent
self-evolution, without adding an independent Plugin approval system.

Each Plugin owns one Git-backed code workspace and one authoritative Git draft
ref. An Agent opens the current ref as its turn base. When the turn finishes,
Core advances it with Git's compare-and-swap update: the first concurrent edit
wins, while a stale edit fails its whole turn and produces no Plugin commit
Event or Agent action. There is no merge, retry, or Plugin lock.
An Agent in `exposedTo` may edit the whole draft, including runtime, CLI, and
optional View. An ingress-only Agent sees the active Plugin source read-only;
no second edit-permission field exists. A successful edit creates a Git commit
and a high-level
`plugin.workspace.committed` Event attributed to the Agent. The commit
immediately advances the draft head but never changes the active code.
Initialization is backed by `plugin.workspace.initialized`.

The active `SwarmDefinition` pins an exact Plugin commit. Runtime CLIs and
inbound runtimes execute from an isolated checkout of that pinned commit, never
from the editable draft checkout. For a Main turn, the Harness receives the
pinned CLI plus the editable draft directory as two distinct paths. For a Fork,
it receives only the proposed pin as a read-only workspace and the CLI is in
mock mode. An Agent may therefore advance Chat from `v1 -> v2 -> v3` while the
active Swarm continues to execute `v1`.

When an Agent proposes a complete Swarm Revision, it may change Chat's pin from
`v1` directly to `v3`. Proposal Forks evaluate the exact pinned Plugin code in
mock/isolated mode. Plugin code is read-only inside those evaluation Forks in
the first version: further Plugin edits require another Main draft commit and a
later Proposal. Human approval activates the selected Swarm Revision and all of
its Plugin pins together. After recording the accepted Revision, Swarm
explicitly waits for the runtime host to replace changed pinned runtimes. If
any Plugin fails to stop or start, the entire deployment stops; the accepted
Revision remains in the Ledger, so reopening retries that exact active pin.
There is no rollback, partial-running Swarm, or independent Plugin activation
Event.

A Proposal uses literal commit IDs only. A turn cannot edit a Plugin and pin
that newly created commit in the same Proposal action: the commit does not
become proposal-visible until the turn finishes. The next turn sees the new
draft head and may pin it. This keeps the protocol free of symbolic `latest` or
`draft` references.

Commits skipped by a Proposal, such as `v2`, remain ordinary auditable Git
history. Commits made after a Proposal remain draft candidates for a later
Swarm Revision; approving the earlier Proposal does not discard or implicitly
activate them. The first implementation uses one authoritative Git draft ref
per Plugin rather than per-Agent Plugin branches.

Git commit IDs are the version identity. Semver, dependency solving, package
publishing, migration protocols, and a separate Plugin Revision store are not
part of this design. Mutable operational data such as schedules, screenshots,
OCR output, App sessions, credentials, cursors, and caches is not versioned with
the code.

## Snapshots

A Snapshot is a portable, reusable Swarm blueprint:

```text
snapshot.json
agents/<agent-id>/...
plugins/<plugin-id>.bundle
```

`snapshot.json` contains the complete Definition and source revision evidence;
each Agent directory contains its seed workspace tree, while `pluginBundles`
maps every Plugin ID to a Git bundle containing the exact commit pinned by the
Definition. Import initializes Agent repositories and imports Plugin Git
objects without changing their commit IDs.

The Snapshot as a whole therefore initializes Agent roles and context even
though those fields are not duplicated inside `SwarmDefinition`.

A portable Snapshot intentionally excludes live Harness sessions, runtime
queues, secrets, Plugin connections, and low-level trajectories. An installed
running Swarm can still reconstruct Revision/Proposal checkpoints from its
Ledger and native Harness storage. The portable Snapshot is a reusable starting
state, not a replacement for that Ledger or an exact forensic archive.

`deploySnapshot()` creates one fresh instance, imports its Agent and Plugin Git
objects, bootstraps the initial Revision, starts every pinned Plugin runtime,
and exposes the running Swarm and Default View. Plugin state and secrets are
supplied under the instance root and remain outside the Snapshot. A later
Revision activation replaces only runtimes whose pinned commit or mode changed.
Deployment never resolves a mutable local Plugin folder by name alone.

The instance directory is the durable running Swarm. Its `ledger.jsonl` is
write-through and hash-verified, while `agents/`, `plugins/`, and `state/` retain
their existing local data. Graceful stop first closes Plugin ingress and drains
Agent queues, then closes Harness adapters and the Ledger. `openDeployment()`
locks the same directory, verifies the Ledger, projects its Revisions,
Proposals, Forks, workspace heads, and Harness checkpoints back into runtime
indexes, and continues appending to the same chain. It does not export a
continuation bundle or replay already-settled Communication.

This version supports graceful stop and reopen on the same machine and path. It
does not recover an in-flight turn or queue after process death or power loss.
