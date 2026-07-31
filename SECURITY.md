# Security

Coral is currently designed for trusted local use. A Snapshot is executable
code, not a passive data file.

## Trust boundary

Coral runs all of the following with the authority of the local user:

- Agent-owned `context.ts` inside the Core process
- Human-approved Plugin `runtime.mjs` inside the Core process
- Plugin shell CLIs invoked by a Harness
- Codex, Claude Code, or Pi as external Harness processes

Coral scopes each Plugin CLI's environment to that command, but it does not
provide an OS sandbox, filesystem isolation, or network isolation. Inspect a
Snapshot and every pinned Plugin commit before deploying it. Do not run
untrusted Agent workspaces or Plugin revisions.

## Local services

The Default View listens on `127.0.0.1` and has no authentication. Do not bind,
proxy, or tunnel it to an untrusted network.

Each Instance uses `runtime.lock` to prevent concurrent writers. After an
unclean process exit, confirm that no Coral process still owns the Instance
before removing a stale lock.

## Data

The Instance directory may contain private conversations, Agent memory,
Plugin state, OCR, screenshots, and local paths. `instances/` is Git-ignored;
keep it out of source control and protect backups accordingly.

The bundled Screen Plugin is macOS-only. It captures the foreground window,
runs local Apple Vision OCR, and retains a full PNG plus a compressed preview.
Its default retention limits are seven days and 2 GiB. macOS may request Screen
Recording and accessibility-related permissions. See
[Screen Plugin](plugins/screen/README.md) before enabling it.

Snapshots intentionally exclude Plugin state, secrets, runtime queues, and
native Harness session storage. Do not place credentials in a Snapshot or
Agent workspace.

## Integrity limits

The Ledger is append-only, hash-chained, and flushed to disk. This detects
local inconsistency; it does not sign Events or prove them to an external
verifier. Native Harness trajectories remain in each Harness's own storage and
are referenced by checkpoints in the Ledger.

## Reporting a vulnerability

Do not disclose a vulnerability in a public issue. Once this repository has a
public GitHub home, use GitHub private vulnerability reporting. Until then,
contact the maintainer privately through the channel from which you received
the source.
