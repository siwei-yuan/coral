# Plugins

A Coral Plugin owns one external capability. Its code is a Git workspace
pinned by the complete Swarm Definition.

```text
plugins/<id>/
├── runtime.mjs        external ingress and Plugin-owned state
├── bin/<command>.mjs  shell CLI exposed to authorized Agents
├── prompt.md          capability guidance injected into Agent context
├── view.mjs           optional View-only extension
└── README.md          Human-facing operation and privacy notes
```

`runtime.mjs` exports `start({ id, mode, stateRoot, env, emit })`. It returns a
`stop()` function and may return a View extension. Runtime ingress may append a
`communication.sent` Event through `emit`. Agent output and configuration go
through the Plugin CLI and remain Plugin effects unless they later cause new
external ingress.

An authorized Main Agent sees two things from the same Plugin binding:

- the CLI from the active pinned commit;
- a writable draft Git workspace that begins at that commit.

Draft commits do not hot-reload. A complete, Human-approved Swarm Revision must
pin a new commit before runtime, CLI, prompt, and optional View activate
together. Proposal Forks use the proposed pin in isolated mock mode.

Plugin state is stored under `<instance>/state/<plugin-id>` and is not part of
the Git workspace or a Snapshot. Each command receives only its own scoped
environment; Agent Harness processes do not receive a merged Plugin state
environment.

Built-in Plugins:

- [Chat](chat/README.md) — local user input and Agent replies
- [Composio](composio/README.md) — connected external tools through the local
  Composio CLI
- [Screen](screen/README.md) — sparse macOS foreground activity and OCR
- [Scheduler](scheduler/README.md) — Agent-managed recurring wakeups

`prompt.md` is for the Agent and evolves with the implementation. `README.md`
is for the Human operating or reviewing the Plugin; they must not be conflated.
