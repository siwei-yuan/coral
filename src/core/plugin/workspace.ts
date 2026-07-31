import type { Ledger, LedgerEvent } from "../ledger/ledger.ts"
import { activeScope } from "../ledger/ledger.ts"
import type {
  GitWorkspaceStore,
  WorkspaceCheckout,
  WorkspaceFiles,
  WorkspaceCommit,
  WorkspaceCheckoutResult,
} from "../workspace/git-workspace.ts"

const DRAFT_REF = "refs/corallum/draft"

export class PluginWorkspaceRuntime {
  readonly ledger: Ledger
  readonly workspaces: GitWorkspaceStore

  constructor({ ledger, workspaces }: { ledger: Ledger; workspaces: GitWorkspaceStore }) {
    this.ledger = ledger
    this.workspaces = workspaces
  }

  async initialize(pluginId: string, files: WorkspaceFiles): Promise<WorkspaceCommit> {
    const workspaceCommit = await this.workspaces.initialize(pluginId, files)
    await this.workspaces.setRef(pluginId, DRAFT_REF, workspaceCommit.commit)
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
    await this.workspaces.setRef(pluginId, DRAFT_REF, pinned.commit)
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

  async assertRuntime(pluginId: string, commit: string): Promise<void> {
    try {
      await this.workspaces.read(pluginId, commit, "runtime.mjs")
    } catch {
      throw new Error(`Plugin runtime is missing at pinned commit: ${pluginId}`)
    }
  }

  async prompt(pluginId: string, commit: string): Promise<string> {
    try {
      const prompt = await this.workspaces.read(pluginId, commit, "prompt.md")
      if (!prompt.trim()) throw new Error("empty prompt")
      return prompt
    } catch {
      throw new Error(`Plugin prompt is missing at pinned commit: ${pluginId}`)
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

  async draftHead(pluginId: string): Promise<WorkspaceCommit> {
    return this.workspaces.resolveCommit(pluginId, DRAFT_REF)
  }

  async openDraft(pluginId: string, operationId: string): Promise<WorkspaceCheckout> {
    return this.open(pluginId, (await this.draftHead(pluginId)).commit, operationId)
  }

  finalizeCheckout(checkout: WorkspaceCheckout): Promise<WorkspaceCheckoutResult> {
    return this.workspaces.finalizeCheckout(checkout)
  }

  async recordCheckoutResult(
    checkout: WorkspaceCheckout,
    result: WorkspaceCheckoutResult,
    agentId: string,
    turnId: string,
    causation: string[],
  ): Promise<{ workspaceCommit: WorkspaceCommit; events: LedgerEvent[] }> {
    const events: LedgerEvent[] = []
    if (result.commits.length > 0 && !await this.workspaces.compareAndSwapRef(
      checkout.workspaceId,
      DRAFT_REF,
      result.head.commit,
      checkout.baseCommit,
    )) {
      throw new Error(`Plugin draft changed during Agent turn: ${checkout.workspaceId}`)
    }
    for (const change of result.commits) {
      await this.workspaces.retain(checkout.workspaceId, `draft/${change.commit}`, change.commit)
      events.push(this.ledger.append({
        type: "plugin.workspace.committed",
        actor: `agent/${agentId}`,
        scope: activeScope(),
        causation,
        data: {
          pluginId: checkout.workspaceId,
          parentCommit: change.parentCommit,
          commit: change.commit,
          tree: change.tree,
          message: change.message,
          turnId,
        },
      }))
    }
    if (result.restored) {
      events.push(this.ledger.append({
        type: "plugin.workspace.restored",
        actor: "workspace/runtime",
        scope: activeScope(),
        causation,
        data: {
          pluginId: checkout.workspaceId,
          commit: result.head.commit,
          tree: result.head.tree,
          agentId,
          turnId,
        },
      }))
    }
    return { workspaceCommit: result.head, events }
  }

  close(checkout: WorkspaceCheckout): Promise<void> {
    return this.workspaces.close(checkout)
  }
}
