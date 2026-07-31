import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { activeScope } from "../core/ledger/ledger.ts"
import type { PluginWorkspaceRuntime } from "../core/plugin/workspace.ts"
import type { PluginBinding, SwarmDefinition } from "../core/swarm/definition.ts"
import type { PluginEnvironment, Swarm } from "../core/swarm/runtime.ts"
import type { WorkspaceCheckout } from "../core/workspace/git-workspace.ts"
import type { ViewExtension } from "../view/extension.ts"

export interface PluginIngressDraft {
  type: "communication.sent"
  actor: string
  schema?: string
  correlation?: string
  data?: unknown
  evidence?: unknown
}

interface PluginRuntimeModule {
  start(input: {
    id: string
    mode: string
    stateRoot: string
    env: Record<string, string>
    emit(draft: PluginIngressDraft): Promise<void>
  }): Promise<PluginRuntimeInstance>
}

interface PluginRuntimeInstance {
  stop(): Promise<void> | void
  view?: ViewExtension
}

interface ActivePlugin {
  binding: PluginBinding
  checkout: WorkspaceCheckout
  instance: PluginRuntimeInstance
}

export class PluginRuntimeHost {
  readonly swarm: Swarm
  readonly workspaces: PluginWorkspaceRuntime
  readonly stateRoot: string
  readonly environment: PluginEnvironment
  #active = new Map<string, ActivePlugin>()

  constructor({
    swarm,
    workspaces,
    stateRoot,
    environment = () => ({}),
  }: {
    swarm: Swarm
    workspaces: PluginWorkspaceRuntime
    stateRoot: string
    environment?: PluginEnvironment
  }) {
    this.swarm = swarm
    this.workspaces = workspaces
    this.stateRoot = stateRoot
    this.environment = environment
  }

  async start(): Promise<void> {
    await this.activate(this.swarm.activeRevision().definition)
  }

  extensions(): ViewExtension[] {
    return [...this.#active.values()].flatMap((plugin) => plugin.instance.view ? [plugin.instance.view] : [])
  }

  async stop(): Promise<void> {
    const active = [...this.#active.values()]
    this.#active.clear()
    await Promise.all(active.map((plugin) => this.#stop(plugin)))
  }

  async activate(definition: SwarmDefinition): Promise<void> {
    try {
      await this.#activate(definition.plugins)
    } catch (error) {
      await this.stop().catch(() => undefined)
      throw error
    }
  }

  async #activate(bindings: PluginBinding[]): Promise<void> {
    const next = new Map(bindings.map((binding) => [binding.id, binding]))
    for (const [id, active] of this.#active) {
      const binding = next.get(id)
      if (binding && binding.commit === active.binding.commit && binding.mode === active.binding.mode) continue
      await this.#stop(active)
      this.#active.delete(id)
    }
    for (const binding of bindings) {
      if (this.#active.has(binding.id)) continue
      this.#active.set(binding.id, await this.#start(binding))
    }
  }

  async #start(binding: PluginBinding): Promise<ActivePlugin> {
    const checkout = await this.workspaces.open(binding.id, binding.commit, `runtime/${binding.commit}`)
    try {
      const module = await import(pathToFileURL(join(checkout.worktree, "runtime.mjs")).href) as Partial<PluginRuntimeModule>
      if (typeof module.start !== "function") throw new Error(`Plugin runtime must export start(): ${binding.id}`)
      const stateRoot = join(this.stateRoot, binding.id)
      await mkdir(stateRoot, { recursive: true })
      const instance = await module.start({
        id: binding.id,
        mode: binding.mode,
        stateRoot,
        env: this.environment(binding.id),
        emit: async (draft) => {
          const active = this.swarm.activeRevision().definition.plugins.find((plugin) => plugin.id === binding.id)
          if (!active || active.commit !== binding.commit || active.mode !== binding.mode) {
            throw new Error(`Plugin runtime is no longer active: ${binding.id}`)
          }
          const event = this.swarm.ingest({ ...draft, scope: activeScope() })
          this.swarm.route(event.id)
        },
      })
      if (!instance || typeof instance.stop !== "function") {
        throw new Error(`Plugin runtime start() must return stop(): ${binding.id}`)
      }
      if (instance.view && instance.view.plugin !== binding.id) {
        throw new Error(`Plugin View extension ID does not match its runtime: ${binding.id}`)
      }
      return { binding, checkout, instance }
    } catch (error) {
      await this.workspaces.close(checkout)
      throw error
    }
  }

  async #stop(plugin: ActivePlugin): Promise<void> {
    try {
      await plugin.instance.stop()
    } finally {
      await this.workspaces.close(plugin.checkout)
    }
  }
}
