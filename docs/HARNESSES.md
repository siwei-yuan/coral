# Harnesses

A Harness executes an Agent turn. Coral supplies the assembled context,
workspace directory, authorized Plugin commands, readable peer workspaces, and
an optional native session checkpoint. The Harness returns only an outcome and
the next checkpoint; Coral itself records the authoritative turn and workspace
Events.

Coral does not install or authenticate a Harness. Each Agent Definition pins
the Harness, model, and optional effort used for its turns:

```json
{
  "id": "builder",
  "harness": "codex",
  "model": "gpt-5.6-terra",
  "effort": "high",
  "turnPolicy": "batch-events"
}
```

`model` is required. `effort` is omitted only when the selected model has no
corresponding control. Coral passes both values through the chosen Adapter and
does not maintain a separate model registry.

## Built-in adapters

### Codex

- Definition ID: `codex`
- Executable: `codex`
- Transport: one shared `codex app-server --stdio` process per deployment
- Model mapping: App Server `model`; effort mapping: App Server `effort`
- Continuation: thread resume for an unchanged workspace; thread fork from the
  recorded turn at a workspace or Swarm boundary

### Claude Code

- Definition ID: `claude-code`
- Executable: `claude`
- Transport: print mode with streaming JSON
- Model mapping: `--model`; effort mapping: `--effort`
- Continuation: `--resume <session>`; boundaries add `--fork-session`
- Peer and Plugin workspaces are passed as additional readable directories

### Pi

- Definition ID: `pi`
- Executable: `pi`
- Transport: RPC mode
- Model mapping: `--model`; effort mapping: `--thinking`
- Continuation: `--session <session>` or `--fork <session>`
- A custom Pi session directory may be supplied to the adapter constructor

The included Snapshots select Codex with an explicit model and effort. Change
`harness`, `model`, or `effort` only through a complete Swarm Definition
Proposal. Pi model values may include the provider, such as
`anthropic/claude-sonnet-4-6`.

## Session semantics

An Agent workspace commit is the boundary of an Agent's context identity.
Turns with the same workspace head resume the native session. The first turn
after a workspace commit, Revision snapshot, or Proposal Fork forks the last
checkpoint instead. This preserves provider-side cache and history while an
exact workspace head plus `agent.turn.recorded` identifies the corresponding
trajectory segment.

Coral stores the Harness ID, model, optional effort, session ID, and turn ID in
the Ledger. It does not copy the native session history. `coral review --turn
<turn-event-id>` uses that checkpoint to read the exact native turn when the
Harness still retains it; otherwise it reports the trajectory as unavailable.

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
