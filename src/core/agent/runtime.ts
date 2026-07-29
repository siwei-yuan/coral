import { randomUUID } from "node:crypto"
import type { HarnessAdapter, HarnessEmission } from "../../harness/adapter.ts"
import type { AgentDefinition } from "./definition.ts"
import { WorkspaceBridge } from "../workspace/context-bridge.ts"
import type { GitWorkspaceStore, WorkspaceRevision } from "../workspace/git-workspace.ts"
import type { Ledger, LedgerEvent, Scope } from "../ledger/ledger.ts"

export interface AgentTurnInput {
  agent: AgentDefinition
  baseCommit: string
  scope: Scope
  inputEvents: LedgerEvent[]
  runtimeContext?: Record<string, unknown>
}

export interface AgentTurnResult {
  revision: WorkspaceRevision
  outputEvents: LedgerEvent[]
  workspaceEvent: LedgerEvent | null
  turnEvent: LedgerEvent
}

export class AgentRuntime {
  readonly ledger: Ledger
  readonly workspaces: GitWorkspaceStore
  readonly workspaceBridge: WorkspaceBridge
  readonly adapters: Map<string, HarnessAdapter>

  constructor({
    ledger,
    workspaces,
    adapters,
    workspaceBridge = new WorkspaceBridge(),
  }: {
    ledger: Ledger
    workspaces: GitWorkspaceStore
    adapters: HarnessAdapter[]
    workspaceBridge?: WorkspaceBridge
  }) {
    this.ledger = ledger
    this.workspaces = workspaces
    this.adapters = new Map(adapters.map((adapter) => [adapter.id, adapter]))
    this.workspaceBridge = workspaceBridge
  }

  async runTurn({ agent, baseCommit, scope, inputEvents, runtimeContext = {} }: AgentTurnInput): Promise<AgentTurnResult> {
    const adapter = this.adapters.get(agent.harness)
    if (!adapter) throw new Error(`Harness Adapter is not registered: ${agent.harness}`)
    if (inputEvents.length === 0) throw new Error("Agent turn requires at least one input Event")
    if (!baseCommit) throw new Error("Agent turn requires a workspace commit")

    const turnId = randomUUID()
    const checkout = await this.workspaces.open(agent.id, baseCommit, turnId)
    try {
      let outcome = "failed"
      let emissions: HarnessEmission[] = []
      let trajectory: unknown = null
      let failure: string | undefined

      try {
        const context = await this.workspaceBridge.compose(checkout.worktree, {
          ...runtimeContext,
          turnId,
          agentId: agent.id,
          scope,
          inputEvents,
        })
        const result = await adapter.run({
          turnId,
          agentId: agent.id,
          scope,
          workingDirectory: checkout.worktree,
          inputEvents,
          context,
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
          ...(emission.schema ? { schema: emission.schema } : {}),
          actor: `agent/${agent.id}`,
          scope,
          causation: inputEvents.map((event) => event.id),
          data: emission.data ?? null,
          ...(emission.evidence !== undefined ? { evidence: emission.evidence } : {}),
        }),
      )

      let workspaceEvent: LedgerEvent | null = null
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
          inputWorkspaceCommit: baseCommit,
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
