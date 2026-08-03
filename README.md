<h1 align="center">
  <img src="assets/coral-wordmark.png" alt="Coral" width="640">
</h1>

Coral is a framework where Agents evolve the same way software does: by
changing code and committing it.

Each Agent can rewrite its own workspace to improve its context, memory,
skills, code, and behavior. Agents can also propose code and topology changes
that evolve the entire Swarm. Every code change is preserved as an exact Git
commit, and every evolution step is recorded in the Ledger so the full history
can be audited and reconstructed.

The name comes from a coral colony: each polyp grows its own structure, the
colony grows as a whole, and its skeleton preserves the layers of that growth.
In Coral, Agents evolve through workspace commits, the Swarm evolves through
Revisions, and Git plus the Ledger preserve the history.

It follows three principles:

1. An Agent evolves itself by changing and committing its own workspace.
2. A Swarm evolves as a complete, human-approved Revision.
3. Every evolution is reconstructable from an append-only Event Ledger and
   exact Git commits.

Coral is currently an experimental `0.1` project for trusted local use. It has
no npm runtime dependencies, but it executes Agent-owned workspace code,
approved Plugin code, and external Harness CLIs with the current user's local
authority. Read [Security](SECURITY.md) before running an untrusted Snapshot.

## Quick start

Requirements:

- Node.js 22.18 or newer
- Git
- at least one installed and authenticated Harness CLI: Codex, Claude Code, or
  Pi
- the installed and authenticated Composio CLI for Personal Agent external
  tools
- macOS for the bundled Screen Plugin

After cloning the repository:

```bash
npm ci
npm run check
npm run coral -- create ./snapshots/personal-agent ./instances/personal-agent
```

Coral prints the local Default View URL. Stop it with `Ctrl-C`; Coral closes
external ingress, drains every Agent mailbox, and then releases the Instance.

Resume the same local Instance later:

```bash
npm run coral -- start ./instances/personal-agent
```

Use `--no-view` for headless operation or `--view-port <port>` to choose the
View port. An Instance is a durable local directory; do not run two Coral
processes against the same Instance.

## The model

```text
Harness
  └── Agent + Git workspace
        └── Swarm + append-only Ledger
              ├── human-gated Revisions and Forks
              ├── pinned Git-backed Plugins
              └── Ledger-derived View projections
```

An Agent's role, context, memory layout, skills, code, tests, and context
composer live in its ordinary Git workspace. A committed workspace change
affects only that Agent's next turn; it never creates a Swarm Proposal
implicitly.

A Swarm Revision is a snapshot of the complete Definition and exact Agent and
Plugin heads. A Proposal may be forked into an isolated temporary evaluation
state from any prior Revision or Proposal. If a Human approves an exact Fork
frontier, it becomes the new Main state atomically. Agents added or removed,
routes, Harnesses, models, effort levels, tests, and active Plugin pins all
change through this same Revision boundary.

Plugins are Git workspaces with a runtime, an Agent-facing shell CLI, an
Agent-facing prompt, and an optional View extension. Agents may commit draft
Plugin changes, but only a human-approved Swarm Revision activates a new Plugin
commit. External input enters the Ledger as `communication.sent`; outbound
effects happen through a Plugin CLI rather than pretending to be inbound
Events.

The Default View is only a projection and control surface. It reads the Ledger
to show Swarm evolution, Agent and Plugin commit timelines, topology, routing,
and Plugin extensions; it does not change Core or Plugin semantics.

The exact invariants and Event model are specified in
[Design](docs/DESIGN.md).

## Snapshots and Instances

A Snapshot is a reusable blueprint:

```text
snapshot.json          complete Swarm Definition
agents/<agent-id>/     seed workspace for each Agent
plugins/<plugin>.bundle exact Git history for pinned Plugin commits
```

Deploying a Snapshot creates a new Instance. The Instance then owns its
Ledger, Agent and Plugin Git repositories, and Plugin state. Stopping Coral
does not export or replace that state; starting the same Instance simply opens
its Ledger and continues appending.

See [Snapshots](snapshots/README.md) for the format and authoring boundary.

## Examples

### Personal Agent

The [Personal Agent Snapshot](snapshots/personal-agent/README.md) is the main
end-to-end Coral example: a persistent personal Swarm that learns about its
user, improves its own organization, anticipates useful next steps, and audits
its behavior. It composes four independently evolving Agents:

- [Chat Agent](snapshots/personal-agent/agents/chat-agent/AGENTS.md) is the only
  direct conversational interface. It learns how to understand and answer the
  user, then routes useful feedback to the rest of the Swarm.
- [Memory Builder](snapshots/personal-agent/agents/memory-builder/AGENTS.md)
  learns from conversations and relevant Screen activities. It evolves how
  user knowledge is selected, organized, connected, compressed, and retrieved.
- [Proactivity](snapshots/personal-agent/agents/proactivity/AGENTS.md) learns
  recurring patterns and likely next steps, while evolving the evidence and
  interruption threshold required before it reaches out through Chat Agent.
- [Auditor](snapshots/personal-agent/agents/auditor/AGENTS.md) periodically
  uses `coral review` to examine Agent, workspace, trajectory, and
  collaboration evidence, then sends concrete improvement advice to the
  responsible Agent.

Four Git-backed Plugins form the external boundary:

- [Chat](plugins/chat/README.md) turns local user input into routed
  Communications and gives Chat Agent a CLI for direct replies.
- [Composio](plugins/composio/README.md) gives only Chat Agent access to the
  user's connected external services through the official local Composio CLI.
  Its optional signed trigger listener routes V3 trigger messages back to Chat
  Agent.
- [Screen](plugins/screen/README.md) records sparse foreground activity, local
  OCR, and image references. Memory Builder and Proactivity query the private
  artifacts only when an activity is relevant.
- [Scheduler](plugins/scheduler/README.md) lets every Agent create and remove
  its own recurring review notes; each firing returns as a routed
  Communication.

The self-iteration loop is deliberately plain:

1. Chat, Screen, Scheduler, or an enabled Composio trigger listener appends an
   external Communication to the durable Ledger; Composio tool calls remain
   outbound Agent commands.
2. Swarm routes it into each target Agent's independent mailbox. Different
   Agents can run concurrently; a busy Agent keeps new input queued for its
   next turn.
3. The Agent assembles context from its own workspace, current input Events, a
   compact current-Swarm view, and the prompts of its authorized Plugins.
4. The Agent may update its role, context composer, memory, skills, or code and
   commit the change. That exact workspace head becomes its next state
   immediately, without changing any other Agent or creating a Revision.
5. Agents share knowledge or advice only through routed Communications. They
   may read peer workspace snapshots, but they never edit a peer workspace.
6. If the learning requires a route, Agent membership, Harness, test, or active
   Plugin change, an Agent proposes a complete Swarm Definition. Temporary
   Forks evaluate that Proposal from an exact frontier while Main continues.
7. Human approval promotes one exact Fork frontier as the next Revision;
   denial keeps its full history without activating it.

Plugin code follows the same controlled boundary. An authorized Agent can
commit successive Chat, Composio, Screen, or Scheduler draft improvements,
while the running Swarm continues using the old pin. A Proposal selects an
exact audited Plugin commit, and approval activates its runtime, CLI, prompt,
and optional View together.

This example shows how several self-improving local loops can share evidence
and advice while the topology and external capability boundary remain
auditable and controlled. Its Instance directory preserves the Ledger,
workspaces, Plugin repositories, and Plugin state across normal stop and
resume. The distributed Snapshot intentionally contains no fabricated learned
user memory; learning begins inside the deployed Instance.

### Executable evolution scenarios

The core tests contain small scripted Harness scenarios that execute the
evolution model without requiring a live model provider:

- [Agent workspace evolution](test/evolution.test.ts): an Agent commits new
  responsibility and context-composition code, and its next turn uses them
  while the active Swarm Revision remains unchanged.
- [Harness checkpoint continuity](test/evolution.test.ts): turns resume one
  native session until a workspace commit or Swarm snapshot boundary forks the
  recorded checkpoint.
- [Plugin evolution](test/plugin.test.ts): Chat moves through multiple draft
  commits while the active pin stays unchanged; a Proposal selects an exact
  commit, a Fork evaluates it in mock mode, and Human approval activates it.
- [Whole-Swarm evolution](test/evolution.test.ts): a Proposal captures multiple
  Agent commits, parallel Forks evolve independently, one frontier is promoted,
  and another is denied without losing its audit history.
- [Agent topology evolution](test/topology.test.ts): Proposals add an Agent only
  with an initialized workspace or remove one without deleting its historical
  workspace and Events.

These are executable business-semantic examples, not additional framework
layers.

## Programmatic use

Coral currently runs directly from this checkout and is marked `private`; it is
not published as an npm package. Import it from `src/index.ts`:

```ts
import { deploySnapshot, SnapshotStore } from "./src/index.ts"

const deployment = await deploySnapshot({
  snapshots: new SnapshotStore("./snapshots"),
  name: "personal-agent",
  instanceRoot: "./instances/personal-agent",
  human: "owner",
})

const { url } = await deployment.view.listen({ port: 3000 })
console.log(url)

// Later, after closing external inputs:
await deployment.stop()
```

`openDeployment({ instanceRoot, human })` reopens an existing Instance. Custom
Harness adapters and Plugin environment values can be supplied through the
same deployment functions.

## Documentation

- [Design](docs/DESIGN.md) — canonical semantics and invariants
- [Operations](docs/OPERATIONS.md) — create, run, stop, resume, inspect, and
  back up an Instance
- [Harnesses](docs/HARNESSES.md) — supported Harness CLIs and adapter contract
- [Plugins](plugins/README.md) — Plugin layout, lifecycle, and built-ins
- [Snapshots](snapshots/README.md) — reusable Swarm blueprint format
- [Security](SECURITY.md) — trust boundary, local authority, and data exposure
- [Contributing](CONTRIBUTING.md) — development and contribution workflow

## Source layout

```text
src/
├── core/          Ledger, Git workspaces, Agents, Plugins, and Swarm semantics
├── harness/       Codex, Claude Code, and Pi adapters
├── deployment/    local Instance lifecycle and pinned Plugin runtimes
├── snapshots/     Snapshot import/export
└── view/default/  default Ledger projection and local control surface

plugins/           built-in Plugin source
snapshots/         reusable example Swarms
test/              core business-logic tests
```

There is deliberately no workflow engine, database layer, extension registry,
CLI framework, or test framework.

## Current limits

- Agent `context.ts` and approved Plugin runtimes are not sandboxed.
- The Default View binds to loopback and has no authentication; do not expose
  it through a public proxy.
- Process crashes do not replay an in-flight Harness turn or an in-memory
  mailbox. Normal graceful shutdown drains mailboxes first.
- Ledger hash chaining detects local inconsistency; it is not a signature or
  external attestation system.
- Exact Harness session data remains in the native Harness's own storage.
- The bundled Screen Plugin is macOS-only and may capture sensitive content.

## Future work

The following work extends the current architecture without changing its three
principles.

### Sandbox each Agent and its workspace

Today, Agent-owned `context.ts` runs inside the Coral Core process and the
Harness runs with the local user's authority. The intended boundary is one
sandbox per Agent plus its workspace:

- execute `context.ts` and the Harness inside that boundary;
- expose only that Agent's writable workspace, explicitly readable peer
  workspaces, and its authorized Plugin commands;
- make filesystem, process, environment, and network access explicit policy;
- return only assembled context, Harness checkpoints, private Agent actions,
  and workspace commits to Core;
- keep Core responsible for validation and authoritative Ledger Events.

This must preserve self-evolution: the Agent still changes itself through
ordinary workspace commits. The sandbox limits authority; it does not move
Agent-owned context back into the Swarm Definition.

### Isolate Plugin runtimes

Approved `runtime.mjs` currently executes inside the Core process. Each active
Plugin should instead run in its own process or sandbox with a small transport
contract equivalent to the current `start`, `emit`, `view`, and `stop`
capabilities:

- give it only its pinned code, Plugin state directory, and declared
  environment;
- accept only validated inbound `communication.sent` drafts from runtime
  ingress;
- keep Agent-facing CLI execution separately scoped to the calling Agent;
- stop ingress before Agent mailboxes drain during shutdown;
- tear down the whole deployment if an active Plugin cannot start or activate.

Runtime isolation must not introduce partial activation. A Human-approved
Swarm Revision still changes runtime, CLI, prompt, and optional View at one
exact Plugin commit.

### Complete the Plugin evolution workflow

The Core semantics already exist: authorized Agents edit a shared Plugin draft
workspace, every accepted commit is auditable, concurrent edits use Git
compare-and-swap, and only a Human-approved Swarm Revision activates a pinned
commit. The remaining work is to make that lifecycle complete for operators:

- show the active pin, draft head, commit lineage, and diff clearly in the
  Default View;
- let a Proposal select an exact audited draft commit without hiding the
  complete Swarm Definition change;
- make conflicting concurrent Plugin edits visible and easy to resolve through
  ordinary Git history;
- make Snapshot export and deployment visibly confirm that each Plugin bundle
  contains the exact approved pin;
- keep Plugin state and secrets outside Git, revisions, and Snapshots.

This remains Swarm-bound Plugin versioning. Coral does not need a second semver
system or hot-reload path for Plugin code.

## License

Coral is available under the [MIT License](LICENSE).
