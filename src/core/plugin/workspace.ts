import type { Ledger, LedgerEvent } from "../ledger/ledger.ts"
import { activeScope } from "../ledger/ledger.ts"
import type {
  GitWorkspaceStore,
  WorkspaceCheckout,
  WorkspaceFiles,
  WorkspaceCommit,
} from "../workspace/git-workspace.ts"

export class PluginWorkspaceRuntime {
  readonly ledger: Ledger
  readonly workspaces: GitWorkspaceStore

  constructor({ ledger, workspaces }: { ledger: Ledger; workspaces: GitWorkspaceStore }) {
    this.ledger = ledger
    this.workspaces = workspaces
  }

  async initialize(pluginId: string, files: WorkspaceFiles): Promise<WorkspaceCommit> {
    const workspaceCommit = await this.workspaces.initialize(pluginId, files)
    this.ledger.append({
      type: "plugin.workspace.initialized",
      actor: "workspace/runtime",
      scope: activeScope(),
      data: { pluginId, commit: workspaceCommit.commit, tree: workspaceCommit.tree },
    })
    return workspaceCommit
  }

  async importBundle(pluginId: string, bundle: string, pinnedCommit: string): Promise<WorkspaceCommit> {
    await this.workspaces.importBundle(pluginId, bundle)
    const pinned = await this.workspaces.verify(pluginId, pinnedCommit)
    const initial = await this.workspaces.rootCommit(pluginId, pinnedCommit)
    await this.workspaces.retain(pluginId, `import/${pinnedCommit}`, pinnedCommit)
    this.ledger.append({
      type: "plugin.workspace.initialized",
      actor: "snapshot/runtime",
      scope: activeScope(),
      data: {
        pluginId,
        commit: initial.commit,
        tree: initial.tree,
        importedHead: pinned.commit,
      },
    })
    return pinned
  }

  async assertCommit(pluginId: string, commit: string): Promise<WorkspaceCommit> {
    return this.workspaces.verify(pluginId, commit)
  }

  async assertCommand(pluginId: string, commit: string, command: string): Promise<void> {
    try {
      await this.workspaces.read(pluginId, commit, `bin/${command}.mjs`)
    } catch {
      throw new Error(`Plugin command is missing at pinned commit: ${pluginId}/${command}`)
    }
  }

  commitEvent(pluginId: string, commit: string): LedgerEvent {
    const event = this.ledger.all().find((candidate) => {
      if (candidate.type !== "plugin.workspace.initialized" && candidate.type !== "plugin.workspace.committed") {
        return false
      }
      const data = candidate.data as { pluginId?: unknown; commit?: unknown; importedHead?: unknown }
      return data.pluginId === pluginId && (data.commit === commit || data.importedHead === commit)
    })
    if (!event) throw new Error(`Plugin commit has no workspace Event: ${pluginId}`)
    return event
  }

  open(pluginId: string, commit: string, operationId: string): Promise<WorkspaceCheckout> {
    return this.workspaces.open(pluginId, commit, operationId)
  }

  async commit(
    checkout: WorkspaceCheckout,
    agentId: string,
    turnId: string,
    causation: string[],
  ): Promise<{ workspaceCommit: WorkspaceCommit; event: LedgerEvent | null }> {
    const workspaceCommit = await this.workspaces.commit(checkout, `Agent ${agentId} Plugin edit`, agentId)
    if (workspaceCommit.commit === checkout.baseCommit) return { workspaceCommit, event: null }
    await this.workspaces.retain(checkout.workspaceId, `draft/${workspaceCommit.commit}`, workspaceCommit.commit)
    const event = this.ledger.append({
      type: "plugin.workspace.committed",
      actor: `agent/${agentId}`,
      scope: activeScope(),
      causation,
      data: {
        pluginId: checkout.workspaceId,
        parentCommit: checkout.baseCommit,
        commit: workspaceCommit.commit,
        tree: workspaceCommit.tree,
        turnId,
      },
    })
    return { workspaceCommit, event }
  }

  close(checkout: WorkspaceCheckout): Promise<void> {
    return this.workspaces.close(checkout)
  }
}
