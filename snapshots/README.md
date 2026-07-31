# Snapshots

A Snapshot is a reusable, immutable Swarm blueprint. It is not a paused
Instance and does not replace normal stop and resume.

```text
snapshots/<name>/
├── snapshot.json
├── agents/
│   └── <agent-id>/
│       ├── AGENTS.md
│       ├── context.ts
│       ├── context/initial.md
│       ├── memory/
│       └── skills/
└── plugins/
    └── <plugin-id>.bundle
```

`snapshot.json` contains the complete `SwarmDefinition`: Agent IDs and
Harnesses, routes, Plugin ingress, exact Plugin commit pins, and evaluation
tests. Each Agent directory is its Framework-created initial Git tree. Each
Plugin bundle contains the exact commit history needed by the Definition.

A Snapshot excludes live Plugin state, secrets, mailbox queues, Harness
trajectories, and later Instance commits.

## Deploying

```bash
npm run coral -- create ./snapshots/<name> ./instances/<instance>
```

The target must be a new Instance. To continue an existing one, use:

```bash
npm run coral -- start ./instances/<instance>
```

## Authoring

Keep a Snapshot complete and self-contained:

1. choose a stable lowercase-hyphen name;
2. define every Agent, route, Plugin ingress, Plugin binding, and test in
   `snapshot.json`;
3. give every Agent a plain workspace containing its responsibility, initial
   context, memory and skill structure, and editable `context.ts` composer;
4. bundle every Plugin Git history and pin the exact intended commit;
5. deploy it in a temporary Instance and run the Snapshot tests.

An Agent workspace may change itself after deployment. Topology, Harness,
routes, Agent membership, tests, and active Plugin pins change only through a
complete human-gated Swarm Revision Proposal.

The built-in examples are [Continual Harness](continual-harness/README.md) and
[Personal Agent](personal-agent/README.md).
