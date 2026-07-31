# Harnesses

A Harness executes an Agent turn. Coral supplies the assembled context,
workspace directory, authorized Plugin commands, readable peer workspaces, and
an optional native session checkpoint. The Harness returns only an outcome and
the next checkpoint; Coral itself records the authoritative turn and workspace
Events.

Coral does not install, authenticate, or select a model for a Harness. Configure
the chosen CLI independently before starting a Swarm.

## Built-in adapters

### Codex

- Definition ID: `codex`
- Executable: `codex`
- Transport: one shared `codex app-server --stdio` process per deployment
- Continuation: thread resume for an unchanged workspace; thread fork from the
  recorded turn at a workspace or Swarm boundary

### Claude Code

- Definition ID: `claude-code`
- Executable: `claude`
- Transport: print mode with streaming JSON
- Continuation: `--resume <session>`; boundaries add `--fork-session`
- Peer and Plugin workspaces are passed as additional readable directories

### Pi

- Definition ID: `pi`
- Executable: `pi`
- Transport: RPC mode
- Continuation: `--session <session>` or `--fork <session>`
- A custom Pi session directory may be supplied to the adapter constructor

The included Snapshots currently select Codex. Change the `harness` field in a
complete Swarm Definition Proposal to select another registered adapter.

## Session semantics

An Agent workspace commit is the boundary of an Agent's context identity.
Turns with the same workspace head resume the native session. The first turn
after a workspace commit, Revision snapshot, or Proposal Fork forks the last
checkpoint instead. This preserves provider-side cache and history while an
exact workspace head plus `agent.turn.recorded` identifies the corresponding
trajectory segment.

Coral stores only the Harness ID, session ID, and turn ID in the Ledger. It
does not copy the native session history.

## Adapter contract

A custom adapter implements `HarnessAdapter` from `src/harness/adapter.ts`:

```ts
interface HarnessAdapter {
  readonly id: string
  run(input: HarnessInput): Promise<HarnessResult>
  stop?(): Promise<void>
}
```

`run` must execute in `input.workingDirectory`, expose only the supplied
commands and workspace bindings, honor `checkpoint` and `forkSession`, and
return the actual native checkpoint. It must not append Ledger Events. Register
the adapter by passing it in `adapters` to `deploySnapshot` or
`openDeployment`.

Plugin command wrappers are prepared per turn and inject only that command's
environment when invoked. The Harness process does not receive a merged set of
Plugin state variables.
