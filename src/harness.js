import { randomUUID } from "node:crypto"

export class AgentRuntime {
  constructor({ ledger, workspaces, adapters }) {
    this.ledger = ledger
    this.workspaces = workspaces
    this.adapters = new Map(adapters.map((adapter) => [adapter.id, adapter]))
  }

  async runTurn({ agent, baseCommit, scope, inputEvents }) {
    const adapter = this.adapters.get(agent.harness)
    if (!adapter) throw new Error(`Harness Adapter is not registered: ${agent.harness}`)
    if (inputEvents.length === 0) throw new Error("Agent turn requires at least one input Event")

    const turnId = randomUUID()
    const checkout = await this.workspaces.open(agent.id, baseCommit, turnId)
    try {
      let outcome = "failed"
      let emissions = []
      let trajectory = null
      let failure

      try {
        const result = await adapter.run({
          turnId,
          agentId: agent.id,
          role: agent.role,
          context: agent.context,
          scope,
          workingDirectory: checkout.worktree,
          inputEvents,
        })
        outcome = result.outcome ?? "completed"
        emissions = result.events ?? []
        trajectory = result.trajectory ?? null
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error)
      }

      const revision = await this.workspaces.commit(checkout, `Agent turn ${turnId}`)
      await this.workspaces.retain(agent.id, `turn/${turnId}`, revision.commit)

      const outputEvents = emissions.map((emission) =>
        this.ledger.append({
          type: emission.type,
          schema: emission.schema,
          actor: `agent/${agent.id}`,
          scope,
          causation: inputEvents.map((event) => event.id),
          data: emission.data ?? null,
          evidence: emission.evidence,
        }),
      )

      let workspaceEvent = null
      if (revision.commit !== baseCommit) {
        workspaceEvent = this.ledger.append({
          type: "agent.workspace.committed",
          actor: `agent/${agent.id}`,
          scope,
          causation: inputEvents.map((event) => event.id),
          data: {
            agentId: agent.id,
            parentCommit: baseCommit,
            commit: revision.commit,
            tree: revision.tree,
            turnId,
          },
        })
      }

      const turnEvent = this.ledger.append({
        type: "agent.turn.recorded",
        actor: `agent/${agent.id}`,
        scope,
        causation: inputEvents.map((event) => event.id),
        data: {
          agentId: agent.id,
          inputEventIds: inputEvents.map((event) => event.id),
          outputEventIds: outputEvents.map((event) => event.id),
          workspaceCommit: revision.commit,
          outcome,
          ...(trajectory ? { trajectory } : {}),
          ...(failure ? { failure } : {}),
        },
      })

      return { revision, outputEvents, workspaceEvent, turnEvent }
    } finally {
      await this.workspaces.close(checkout)
    }
  }
}
