import { randomUUID } from "node:crypto"
import { join } from "node:path"
import type {
  HarnessAdapter,
  HarnessEmission,
  HarnessPluginCommand,
  HarnessPluginWorkspace,
} from "../../harness/adapter.ts"
import type { AgentDefinition } from "./definition.ts"
import type { PluginWorkspaceRuntime } from "../plugin/workspace.ts"
import { WorkspaceBridge } from "../workspace/context-bridge.ts"
import type {
  GitWorkspaceStore,
  WorkspaceCheckout,
  WorkspaceFiles,
  WorkspaceReapplyResult,
  WorkspaceCommit,
} from "../workspace/git-workspace.ts"
import type { Ledger, LedgerEvent, Scope } from "../ledger/ledger.ts"
import { activeScope } from "../ledger/ledger.ts"

export interface AgentTurnInput {
  agent: AgentDefinition
  baseCommit: string
  scope: Scope
  inputEvents: LedgerEvent[]
  runtimeContext?: Record<string, unknown>
  workspaceHeads?: Record<string, string>
  pluginAccess?: AgentPluginAccess[]
}

export interface AgentPluginAccess {
  id: string
  command?: string
  mode: string
  activeCommit: string
  draftCommit?: string
  env?: Record<string, string>
}

export interface AgentTurnResult {
  workspaceCommit: WorkspaceCommit
  pluginWorkspaceCommits: Record<string, WorkspaceCommit>
  outputEvents: LedgerEvent[]
  workspaceEvent: LedgerEvent | null
  pluginWorkspaceEvents: LedgerEvent[]
  turnEvent: LedgerEvent
}

export class AgentRuntime {
  readonly ledger: Ledger
  readonly workspaces: GitWorkspaceStore
  readonly workspaceBridge: WorkspaceBridge
  readonly adapters: Map<string, HarnessAdapter>
  readonly pluginWorkspaces: PluginWorkspaceRuntime | undefined

  constructor({
    ledger,
    workspaces,
    adapters,
    pluginWorkspaces,
    workspaceBridge = new WorkspaceBridge(),
  }: {
    ledger: Ledger
    workspaces: GitWorkspaceStore
    adapters: HarnessAdapter[]
    pluginWorkspaces?: PluginWorkspaceRuntime
    workspaceBridge?: WorkspaceBridge
  }) {
    this.ledger = ledger
    this.workspaces = workspaces
    this.adapters = new Map(adapters.map((adapter) => [adapter.id, adapter]))
    this.workspaceBridge = workspaceBridge
    this.pluginWorkspaces = pluginWorkspaces
  }

  async initializeWorkspace(agentId: string, files: WorkspaceFiles = {}): Promise<WorkspaceCommit> {
    const workspaceCommit = await this.workspaces.initialize(agentId, files)
    this.ledger.append({
      type: "agent.workspace.initialized",
      actor: "workspace/runtime",
      scope: activeScope(),
      data: { agentId, commit: workspaceCommit.commit, tree: workspaceCommit.tree },
    })
    return workspaceCommit
  }

  async assertWorkspaceCommit(agentId: string, commit: string, initial = false): Promise<WorkspaceCommit> {
    const workspaceCommit = await this.workspaces.verify(agentId, commit)
    if (initial && !(await this.workspaces.isRoot(agentId, commit))) {
      throw new Error(`Agent workspace must start from its initial commit: ${agentId}`)
    }
    if (initial && !this.#initializationEvent(agentId, commit)) {
      throw new Error(`Agent workspace initial commit has no Ledger Event: ${agentId}`)
    }
    return workspaceCommit
  }

  initializationEvent(agentId: string, commit: string): LedgerEvent {
    const event = this.#initializationEvent(agentId, commit)
    if (!event) throw new Error(`unknown Agent workspace initialization: ${agentId}`)
    return event
  }

  async reapplyWorkspaceTail(
    agentId: string,
    baseCommit: string,
    currentHead: string,
    targetHead: string,
    operationId: string,
  ): Promise<WorkspaceReapplyResult> {
    return this.workspaces.reapplyTail(agentId, baseCommit, currentHead, targetHead, operationId)
  }

  async retainWorkspaceHead(agentId: string, key: string, commit: string): Promise<void> {
    await this.workspaces.retain(agentId, key, commit)
  }

  async runTurn({
    agent,
    baseCommit,
    scope,
    inputEvents,
    runtimeContext = {},
    workspaceHeads = {},
    pluginAccess = [],
  }: AgentTurnInput): Promise<AgentTurnResult> {
    const adapter = this.adapters.get(agent.harness)
    if (!adapter) throw new Error(`Harness Adapter is not registered: ${agent.harness}`)
    if (inputEvents.length === 0) throw new Error("Agent turn requires at least one input Event")
    if (!baseCommit) throw new Error("Agent turn requires a workspace commit")

    const turnId = randomUUID()
    const checkout = await this.workspaces.open(agent.id, baseCommit, turnId)
    const openedPlugins = await this.#openPlugins(pluginAccess, agent.id, turnId)
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
          pluginCommands: openedPlugins.flatMap((plugin) => plugin.command ? [plugin.command] : []),
          pluginWorkspaces: openedPlugins.map((plugin) => plugin.workspace),
          readWorkspace: (agentId, path) => {
            const commit = workspaceHeads[agentId]
            if (!commit) throw new Error(`Agent workspace is not visible: ${agentId}`)
            return this.workspaces.read(agentId, commit, path)
          },
        })
        outcome = result.outcome ?? "completed"
        const nextEmissions = result.events ?? []
        for (const emission of nextEmissions) assertAgentEmission(emission)
        emissions = nextEmissions
        trajectory = result.trajectory ?? null
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error)
      }

      const workspaceCommit = await this.workspaces.commit(checkout, `Agent turn ${turnId}`, agent.id)
      await this.workspaces.retain(agent.id, `turn/${turnId}`, workspaceCommit.commit)

      const pluginWorkspaceCommits: Record<string, WorkspaceCommit> = {}
      const pluginWorkspaceEvents: LedgerEvent[] = []
      for (const plugin of openedPlugins) {
        if (!plugin.draftCheckout) continue
        const committed = await this.pluginWorkspaces!.commit(
          plugin.draftCheckout,
          agent.id,
          turnId,
          inputEvents.map((event) => event.id),
        )
        if (committed.event) {
          pluginWorkspaceCommits[plugin.workspace.id] = committed.workspaceCommit
          pluginWorkspaceEvents.push(committed.event)
        }
      }

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
      if (workspaceCommit.commit !== baseCommit) {
        workspaceEvent = this.ledger.append({
          type: "agent.workspace.committed",
          actor: `agent/${agent.id}`,
          scope,
          causation: inputEvents.map((event) => event.id),
          data: {
            agentId: agent.id,
            parentCommit: baseCommit,
            commit: workspaceCommit.commit,
            tree: workspaceCommit.tree,
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
          workspaceCommit: workspaceCommit.commit,
          outcome,
          ...(trajectory ? { trajectory } : {}),
          ...(failure ? { failure } : {}),
        },
      })

      return { workspaceCommit, pluginWorkspaceCommits, outputEvents, workspaceEvent, pluginWorkspaceEvents, turnEvent }
    } finally {
      await Promise.all([this.#closePlugins(openedPlugins), this.workspaces.close(checkout)])
    }
  }

  async #openPlugins(access: AgentPluginAccess[], agentId: string, turnId: string): Promise<OpenedPlugin[]> {
    if (access.length > 0 && !this.pluginWorkspaces) throw new Error("Plugin workspaces are not configured")
    const opened: OpenedPlugin[] = []
    try {
      for (const plugin of access) {
        let activeCheckout: WorkspaceCheckout | undefined
        let draftCheckout: WorkspaceCheckout | undefined
        try {
          activeCheckout = await this.pluginWorkspaces!.open(
            plugin.id,
            plugin.activeCommit,
            `${turnId}/${plugin.id}/active`,
          )
          draftCheckout = plugin.draftCommit
            ? await this.pluginWorkspaces!.open(plugin.id, plugin.draftCommit, `${turnId}/${plugin.id}/draft`)
            : undefined
        } catch (error) {
          if (activeCheckout) await this.pluginWorkspaces!.close(activeCheckout)
          throw error
        }
        const directory = draftCheckout?.worktree ?? activeCheckout.worktree
        opened.push({
          activeCheckout,
          ...(draftCheckout ? { draftCheckout } : {}),
          ...(plugin.command ? {
            command: {
              id: plugin.id,
              command: plugin.command,
              executable: join(activeCheckout.worktree, "bin", `${plugin.command}.mjs`),
              mode: plugin.mode,
              commit: plugin.activeCommit,
              env: {
                ...plugin.env,
                CORALLUM_AGENT_ID: agentId,
                CORALLUM_PLUGIN_MODE: plugin.mode,
              },
            },
          } : {}),
          workspace: {
            id: plugin.id,
            directory,
            activeCommit: plugin.activeCommit,
            draftCommit: plugin.draftCommit ?? plugin.activeCommit,
            writable: Boolean(draftCheckout),
          },
        })
      }
      return opened
    } catch (error) {
      await this.#closePlugins(opened)
      throw error
    }
  }

  async #closePlugins(opened: OpenedPlugin[]): Promise<void> {
    await Promise.all(opened.flatMap((plugin) => [
      this.pluginWorkspaces!.close(plugin.activeCheckout),
      ...(plugin.draftCheckout ? [this.pluginWorkspaces!.close(plugin.draftCheckout)] : []),
    ]))
  }

  #initializationEvent(agentId: string, commit: string): LedgerEvent | undefined {
    return this.ledger.all().find((event) => {
      if (event.type !== "agent.workspace.initialized") return false
      const data = event.data as { agentId?: unknown; commit?: unknown }
      return data.agentId === agentId && data.commit === commit
    })
  }
}

interface OpenedPlugin {
  activeCheckout: WorkspaceCheckout
  draftCheckout?: WorkspaceCheckout
  command?: HarnessPluginCommand
  workspace: HarnessPluginWorkspace
}

function assertAgentEmission(emission: HarnessEmission): void {
  if (emission.type !== "communication.sent" && emission.type !== "swarm.revision.requested") {
    throw new Error(`Agent may only emit Communication or Swarm evolution Events: ${emission.type}`)
  }
}
