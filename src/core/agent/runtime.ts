import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  HarnessAdapter,
  HarnessCheckpoint,
  HarnessCommand,
  HarnessPeerWorkspace,
  HarnessPluginWorkspace,
} from "../../harness/adapter.ts"
import { coreCommand, readActions, type AgentAction } from "./actions.ts"
import type { AgentDefinition } from "./definition.ts"
import type { PluginWorkspaceRuntime } from "../plugin/workspace.ts"
import { WorkspaceBridge } from "../workspace/context-bridge.ts"
import type {
  GitWorkspaceStore,
  WorkspaceCheckout,
  WorkspaceFiles,
  WorkspaceReapplyResult,
  WorkspaceCommit,
  WorkspaceCheckoutResult,
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
  checkpoint?: HarnessCheckpoint
  forkSession?: boolean
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
  actions: AgentAction[]
  checkpoint: HarnessCheckpoint | null
  workspaceEvents: LedgerEvent[]
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
    checkpoint,
    forkSession = false,
  }: AgentTurnInput): Promise<AgentTurnResult> {
    const adapter = this.adapters.get(agent.harness)
    if (!adapter) throw new Error(`Harness Adapter is not registered: ${agent.harness}`)
    if (inputEvents.length === 0) throw new Error("Agent turn requires at least one input Event")
    if (!baseCommit) throw new Error("Agent turn requires a workspace commit")

    const turnId = randomUUID()
    const checkout = await this.workspaces.open(agent.id, baseCommit, turnId)
    const openedPlugins = await this.#openPlugins(pluginAccess, agent.id, turnId)
    const openedPeers = await this.#openPeers(workspaceHeads, agent.id, turnId)
    const actionRoot = await mkdtemp(join(tmpdir(), "corallum-turn-"))
    const actionsFile = join(actionRoot, "actions.jsonl")
    try {
      let outcome = "failed"
      let nextCheckpoint: HarnessCheckpoint | null = null
      let failure: string | undefined

      try {
        const context = await this.workspaceBridge.compose(checkout.worktree, {
          ...runtimeContext,
          turnId,
          agentId: agent.id,
          scope,
          inputEvents,
          plugins: openedPlugins.flatMap((plugin) => plugin.context ? [plugin.context] : []),
        })
        const result = await adapter.run({
          turnId,
          workingDirectory: checkout.worktree,
          context,
          commands: [
            coreCommand(actionsFile, agent.id),
            ...openedPlugins.flatMap((plugin) => plugin.command ? [plugin.command] : []),
          ],
          pluginWorkspaces: openedPlugins.map((plugin) => plugin.workspace),
          peerWorkspaces: openedPeers.map((peer) => peer.workspace),
          ...(checkpoint ? { checkpoint } : {}),
          forkSession,
        })
        outcome = result.outcome
        nextCheckpoint = result.checkpoint
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error)
      }

      let actions: AgentAction[] = []
      try {
        actions = await readActions(actionsFile)
      } catch (error) {
        outcome = "failed"
        failure = error instanceof Error ? error.message : String(error)
      }

      let workspaceResult: WorkspaceCheckoutResult
      const pluginResults = new Map<string, WorkspaceCheckoutResult>()
      try {
        workspaceResult = await this.workspaces.finalizeCheckout(checkout)
        for (const plugin of openedPlugins) {
          if (!plugin.draftCheckout) continue
          pluginResults.set(
            plugin.workspace.id,
            await this.pluginWorkspaces!.finalizeCheckout(plugin.draftCheckout),
          )
        }
      } catch (error) {
        outcome = "failed"
        failure = error instanceof Error ? error.message : String(error)
        workspaceResult = {
          head: await this.workspaces.resolveCommit(agent.id, baseCommit),
          commits: [],
          restored: false,
        }
        pluginResults.clear()
      }

      for (const change of workspaceResult.commits) {
        await this.workspaces.retain(agent.id, `turn/${turnId}/${change.commit}`, change.commit)
      }
      const workspaceCommit = workspaceResult.head

      const pluginWorkspaceCommits: Record<string, WorkspaceCommit> = {}
      const pluginWorkspaceEvents: LedgerEvent[] = []
      for (const plugin of openedPlugins) {
        if (!plugin.draftCheckout) continue
        const result = pluginResults.get(plugin.workspace.id)
        if (!result) continue
        const recorded = await this.pluginWorkspaces!.recordCheckoutResult(
          plugin.draftCheckout,
          result,
          agent.id,
          turnId,
          inputEvents.map((event) => event.id),
        )
        if (result.commits.length > 0) {
          pluginWorkspaceCommits[plugin.workspace.id] = recorded.workspaceCommit
        }
        pluginWorkspaceEvents.push(...recorded.events)
      }

      const workspaceEvents = workspaceResult.commits.map((change) =>
        this.ledger.append({
          type: "agent.workspace.committed",
          actor: `agent/${agent.id}`,
          scope,
          causation: inputEvents.map((event) => event.id),
          data: {
            agentId: agent.id,
            parentCommit: change.parentCommit,
            commit: change.commit,
            tree: change.tree,
            message: change.message,
            turnId,
          },
        })
      )
      if (workspaceResult.restored) {
        workspaceEvents.push(this.ledger.append({
          type: "agent.workspace.restored",
          actor: "workspace/runtime",
          scope,
          causation: inputEvents.map((event) => event.id),
          data: {
            agentId: agent.id,
            commit: workspaceResult.head.commit,
            tree: workspaceResult.head.tree,
            turnId,
          },
        }))
      }

      const turnEvent = this.ledger.append({
        type: "agent.turn.recorded",
        actor: "agent/runtime",
        scope,
        causation: inputEvents.map((event) => event.id),
        data: {
          turnId,
          agentId: agent.id,
          inputEventIds: inputEvents.map((event) => event.id),
          inputWorkspaceCommit: baseCommit,
          workspaceCommit: workspaceCommit.commit,
          outcome,
          ...(nextCheckpoint ? { trajectory: nextCheckpoint } : {}),
          ...(failure ? { failure } : {}),
        },
      })

      return {
        workspaceCommit,
        pluginWorkspaceCommits,
        actions,
        checkpoint: nextCheckpoint,
        workspaceEvents,
        pluginWorkspaceEvents,
        turnEvent,
      }
    } finally {
      await Promise.all([
        this.#closePlugins(openedPlugins),
        this.#closePeers(openedPeers),
        this.workspaces.close(checkout),
        rm(actionRoot, { recursive: true, force: true }),
      ])
    }
  }

  async #openPlugins(access: AgentPluginAccess[], agentId: string, turnId: string): Promise<OpenedPlugin[]> {
    if (access.length > 0 && !this.pluginWorkspaces) throw new Error("Plugin workspaces are not configured")
    const opened: OpenedPlugin[] = []
    try {
      for (const plugin of access) {
        let activeCheckout: WorkspaceCheckout | undefined
        let draftCheckout: WorkspaceCheckout | undefined
        let instructions: string | undefined
        try {
          activeCheckout = await this.pluginWorkspaces!.open(
            plugin.id,
            plugin.activeCommit,
            `${turnId}/${plugin.id}/active`,
          )
          draftCheckout = plugin.draftCommit
            ? await this.pluginWorkspaces!.open(plugin.id, plugin.draftCommit, `${turnId}/${plugin.id}/draft`)
            : undefined
          instructions = plugin.command
            ? await this.pluginWorkspaces!.prompt(plugin.id, plugin.activeCommit)
            : undefined
        } catch (error) {
          await Promise.all([
            ...(activeCheckout ? [this.pluginWorkspaces!.close(activeCheckout)] : []),
            ...(draftCheckout ? [this.pluginWorkspaces!.close(draftCheckout)] : []),
          ])
          throw error
        }
        const directory = draftCheckout?.worktree ?? activeCheckout.worktree
        const workspace = {
          id: plugin.id,
          directory,
          activeCommit: plugin.activeCommit,
          draftCommit: plugin.draftCommit ?? plugin.activeCommit,
          writable: Boolean(draftCheckout),
        }
        opened.push({
          activeCheckout,
          ...(draftCheckout ? { draftCheckout } : {}),
          ...(plugin.command ? {
            context: {
              id: plugin.id,
              command: plugin.command,
              mode: plugin.mode,
              instructions: instructions!,
              workspace,
            },
          } : {}),
          ...(plugin.command ? {
            command: {
              id: plugin.id,
              executable: join(activeCheckout.worktree, "bin", `${plugin.command}.mjs`),
              usage: plugin.command,
              env: {
                ...plugin.env,
                CORALLUM_AGENT_ID: agentId,
                CORALLUM_PLUGIN_MODE: plugin.mode,
              },
            },
          } : {}),
          workspace,
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

  async #openPeers(heads: Record<string, string>, self: string, turnId: string): Promise<OpenedPeer[]> {
    const opened: OpenedPeer[] = []
    try {
      for (const [agentId, commit] of Object.entries(heads)) {
        if (agentId === self) continue
        const checkout = await this.workspaces.open(agentId, commit, `${turnId}/peer/${agentId}`)
        opened.push({
          checkout,
          workspace: { agentId, commit, directory: checkout.worktree },
        })
      }
      return opened
    } catch (error) {
      await this.#closePeers(opened)
      throw error
    }
  }

  async #closePeers(opened: OpenedPeer[]): Promise<void> {
    await Promise.all(opened.map((peer) => this.workspaces.close(peer.checkout)))
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
  command?: HarnessCommand
  context?: {
    id: string
    command: string
    mode: string
    instructions: string
    workspace: HarnessPluginWorkspace
  }
  workspace: HarnessPluginWorkspace
}

interface OpenedPeer {
  checkout: WorkspaceCheckout
  workspace: HarnessPeerWorkspace
}
