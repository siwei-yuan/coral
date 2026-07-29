# Verifiable Swarm

A small, zero-dependency implementation of a Harness-centered, Git-backed,
human-gated Agent Swarm.

The runtime has six concepts:

1. `Ledger` records high-level causal Events in one hash chain.
2. `GitWorkspaceStore` gives each Agent one writable Git workspace.
3. `HarnessAdapter` drives a native Agent Harness.
4. `AgentRuntime` records one logical turn and any resulting workspace commit.
5. `Swarm` implements Proposal-rooted parallel Forks, evaluation, Candidate
   freeze, Human Decision, and atomic activation.
6. Plugins adapt external protocols to Event ingress, Event egress, or Harness
   tools. `ChatPlugin` is the first reference boundary.

There is deliberately no workflow engine, generic ChangeSet system, extension
registry, database layer, CLI framework, or test framework.

This first implementation keeps the Ledger and Swarm runtime in process while
using real Git repositories and worktrees. Persistence and native Harness
Adapters can be added behind the existing boundaries without changing the core
evolution protocol.

## Core lifecycle

```text
Active Swarm
  -> Revision Proposal, including tests and test inputs
  -> complete Swarm Forks from that Proposal
  -> same Definition and inputs run independently in every Fork
  -> evaluate and select one Fork
  -> freeze immutable Candidate Revision
  -> Human Decision
  -> activate atomically
```

Workspace commits never create Proposals implicitly. Workspace storage does
not know about Swarm Forks; a Fork merely pins Agent commit IDs.

See [docs/DESIGN.md](docs/DESIGN.md).

## Run

```bash
npm test
```
