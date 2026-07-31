# Operations

An Instance is one durable local directory containing everything Coral owns
for a running Swarm. Normal stop and resume happen in place; they do not create
a Snapshot.

## Create and start

Create a fresh Instance from any Snapshot:

```bash
npm run coral -- create ./snapshots/personal-agent ./instances/personal-agent
```

Start the same Instance later:

```bash
npm run coral -- start ./instances/personal-agent
```

The Default View starts on an available loopback port and prints its URL. Use
`--no-view` to run without it or `--view-port <port>` to request a port.

Only one process may open an Instance. Coral stores the owning process ID in
`runtime.lock` and removes the lock during a graceful stop.

## Instance contents

```text
<instance>/
├── ledger.jsonl    append-only, hash-chained Event Ledger
├── runtime.lock    single-process ownership while running
├── agents/         one Git repository per Agent workspace
├── plugins/        active and draft Plugin Git workspaces
└── state/          Plugin-owned runtime state
```

Native Harness sessions are not copied into the Instance; the Ledger records
their session and turn checkpoints so the installed Harness can resume them.

## Graceful stop

Press `Ctrl-C` or send `SIGTERM`. The CLI:

1. closes the View so it accepts no new Human input;
2. stops Plugin runtimes so external ingress closes;
3. prints each Agent's running and queued mailbox status while waiting;
4. lets running turns finish and drains every pending mailbox Event;
5. stops Harness adapters, flushes and closes the Ledger, and releases the
   Instance lock.

The final message confirms that all Agent mailboxes are clear. A noisy or
long-running turn may therefore delay shutdown.

An abrupt crash or power loss cannot replay an in-flight Harness turn or an
in-memory mailbox. Durable Events already appended to `ledger.jsonl` remain,
but crash recovery beyond reopening the consistent Ledger is not implemented.

## Resume

`coral start` opens `ledger.jsonl`, verifies and projects the complete Swarm
state, restores the active Plugin pins and runtimes, and continues appending to
the same Ledger. Harness turns resume or fork from checkpoints recorded in
prior `agent.turn.recorded` Events.

If Plugin runtime activation fails, Coral tears down the deployment. The
accepted Revision remains in the Ledger; opening the same Instance retries its
exact active Plugin pin.

## Backup and inspection

Stop the Instance before copying it. Back up the whole Instance directory, not
only `ledger.jsonl`; Agent and Plugin Git repositories plus Plugin state are
part of the live system.

A local backup is not a fully portable forensic archive because native Harness
session histories remain in Harness-owned storage. A Snapshot is a reusable
blueprint and likewise does not include runtime state, queues, secrets, or
Harness trajectories.

If a process was killed and `runtime.lock` remains, first verify that the
recorded process no longer exists and that no Coral process is using the
Instance. Only then remove that one stale lock file.

The Default View is the supported Human inspection surface. It projects the
Ledger, active topology, routing, evolution, and commit history; it does not
own additional Swarm state.
