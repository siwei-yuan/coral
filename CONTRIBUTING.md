# Contributing

Coral favors small changes whose semantics can be explained from its three
principles:

1. Agent self-evolution belongs to its Git workspace.
2. whole-Swarm evolution belongs to a human-approved Revision.
3. evolution is reconstructable from the Ledger and exact commits.

Read [Design](docs/DESIGN.md) before changing Core behavior.

## Development

Requirements are Node.js 22.18 or newer and Git.

```bash
npm ci
npm run check
```

`npm run check` runs TypeScript validation and the Node test suite. Tests should
cover Core business semantics, not framework wrappers or implementation
details.

## Change boundaries

- Keep Workspace, Agent, Swarm, Plugin, Deployment, and View responsibilities
  separate.
- A View remains downstream of Ledger and Swarm semantics.
- Do not add a new Event when existing durable facts already express the state.
- Do not add compatibility layers for unreleased APIs.
- Prefer direct TypeScript and Node primitives over new dependencies or
  abstractions.
- Update `docs/DESIGN.md` when an invariant changes; update operational docs
  when only usage changes.

## Plugin changes

Built-in Plugin source lives under `plugins/<id>/`. The Personal Agent Snapshot
contains pinned Git bundles of that source. If a built-in Plugin changes, its
bundle and exact commit in `snapshots/personal-agent/snapshot.json` must be
updated together. Verify that checking out the bundle's pinned commit produces
the same files as the source directory.

## Pull requests

Keep each change narrow. Describe the user-visible behavior, the invariant it
preserves, and the checks run. Do not commit `instances/`, generated local
state, credentials, or native Harness session data.
