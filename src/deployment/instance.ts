import { closeSync, fsyncSync, mkdirSync, openSync, unlinkSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { AgentRuntime } from "../core/agent/runtime.ts"
import { Ledger } from "../core/ledger/ledger.ts"
import { PluginWorkspaceRuntime } from "../core/plugin/workspace.ts"
import { Swarm } from "../core/swarm/runtime.ts"
import { projectSwarmState } from "../core/swarm/state.ts"
import { GitWorkspaceStore } from "../core/workspace/git-workspace.ts"
import { ClaudeCodeHarnessAdapter } from "../harness/claude-code.ts"
import { CodexHarnessAdapter } from "../harness/codex.ts"
import type { HarnessAdapter } from "../harness/adapter.ts"
import { PiHarnessAdapter } from "../harness/pi.ts"
import type { SnapshotManifest, SnapshotStore } from "../snapshots/store.ts"
import { DefaultView } from "../view/default/index.ts"
import { PluginRuntimeHost } from "./plugin-runtime.ts"

export interface Deployment {
  ledger: Ledger
  swarm: Swarm
  view: DefaultView
  settled(): Promise<void>
  stop(): Promise<void>
}

export interface SnapshotDeployment extends Deployment {
  manifest: SnapshotManifest
}

interface RuntimeParts {
  agentRuntime: AgentRuntime
  pluginWorkspaces: PluginWorkspaceRuntime
  pluginEnvironment(pluginId: string): Record<string, string>
}

interface DeploymentInput {
  instanceRoot: string
  human: string
  adapters?: HarnessAdapter[]
  pluginEnvironments?: Record<string, Record<string, string>>
}

export async function deploySnapshot({
  snapshots,
  name,
  ...input
}: DeploymentInput & { snapshots: SnapshotStore; name: string }): Promise<SnapshotDeployment> {
  const instance = openInstance(input.instanceRoot, true)
  const adapters = input.adapters ?? defaultAdapters()
  const parts = runtimeParts(instance.root, instance.ledger, adapters, input.pluginEnvironments ?? {})
  const installed = await snapshots.install(name, parts.agentRuntime, parts.pluginWorkspaces).catch(async (error) => {
    await closeFailedInstance(instance, adapters)
    throw error
  })
  const swarm = new Swarm({
    ledger: instance.ledger,
    agentRuntime: parts.agentRuntime,
    pluginEnvironment: parts.pluginEnvironment,
  })
  await swarm.bootstrap({ definition: installed.definition, agentHeads: installed.agentHeads, human: input.human })
    .catch(async (error) => {
      await closeFailedInstance(instance, adapters)
      throw error
    })
  const deployment = await startDeployment(
    instance,
    swarm,
    parts.pluginWorkspaces,
    parts.pluginEnvironment,
    adapters,
    input.human,
  )
  return { manifest: installed.manifest, ...deployment }
}

export async function openDeployment(input: DeploymentInput): Promise<Deployment> {
  const instance = openInstance(input.instanceRoot, false)
  const adapters = input.adapters ?? defaultAdapters()
  const parts = runtimeParts(instance.root, instance.ledger, adapters, input.pluginEnvironments ?? {})
  let swarm: Swarm
  try {
    swarm = new Swarm({
      ledger: instance.ledger,
      agentRuntime: parts.agentRuntime,
      pluginEnvironment: parts.pluginEnvironment,
      state: projectSwarmState(instance.ledger.all()),
    })
  } catch (error) {
    await closeFailedInstance(instance, adapters)
    throw error
  }
  return startDeployment(instance, swarm, parts.pluginWorkspaces, parts.pluginEnvironment, adapters, input.human)
}

function runtimeParts(
  root: string,
  ledger: Ledger,
  adapters: HarnessAdapter[],
  environments: Record<string, Record<string, string>>,
): RuntimeParts {
  const pluginWorkspaces = new PluginWorkspaceRuntime({
    ledger,
    workspaces: new GitWorkspaceStore(join(root, "plugins")),
  })
  return {
    agentRuntime: new AgentRuntime({
      ledger,
      workspaces: new GitWorkspaceStore(join(root, "agents")),
      adapters,
      pluginWorkspaces,
    }),
    pluginWorkspaces,
    pluginEnvironment: (pluginId) => ({
      ...(environments[pluginId] ?? {}),
      CORALLUM_PLUGIN_STATE: join(root, "state", pluginId),
    }),
  }
}

async function startDeployment(
  instance: Instance,
  swarm: Swarm,
  workspaces: PluginWorkspaceRuntime,
  environment: RuntimeParts["pluginEnvironment"],
  adapters: HarnessAdapter[],
  human: string,
): Promise<Deployment> {
  const plugins = new PluginRuntimeHost({
    swarm,
    workspaces,
    stateRoot: join(instance.root, "state"),
    environment,
  })
  try {
    await plugins.start()
  } catch (error) {
    await stopDeployment(instance, swarm, plugins, adapters)
    throw error
  }
  const view = new DefaultView({ swarm, human, extensions: () => plugins.extensions() })
  let stopped = false
  return {
    ledger: instance.ledger,
    swarm,
    view,
    settled: () => plugins.settled(),
    stop: async () => {
      if (stopped) return
      stopped = true
      await stopDeployment(instance, swarm, plugins, adapters)
    },
  }
}

interface Instance {
  root: string
  ledger: Ledger
  lock: InstanceLock
}

function openInstance(instanceRoot: string, create: boolean): Instance {
  const root = resolve(instanceRoot)
  const lock = InstanceLock.acquire(root)
  try {
    const path = join(root, "ledger.jsonl")
    return { root, lock, ledger: create ? Ledger.create(path) : Ledger.open(path) }
  } catch (error) {
    lock.release()
    throw error
  }
}

class InstanceLock {
  readonly path: string
  #file: number | null

  private constructor(path: string, file: number) {
    this.path = path
    this.#file = file
  }

  static acquire(root: string): InstanceLock {
    mkdirSync(root, { recursive: true })
    const path = join(root, "runtime.lock")
    try {
      const file = openSync(path, "wx")
      writeFileSync(file, `${process.pid}\n`)
      fsyncSync(file)
      return new InstanceLock(path, file)
    } catch (error) {
      throw new Error(`Instance is already running: ${root}`, { cause: error })
    }
  }

  release(): void {
    if (this.#file === null) return
    closeSync(this.#file)
    this.#file = null
    unlinkSync(this.path)
  }
}

async function closeFailedInstance(instance: Instance, adapters: HarnessAdapter[]): Promise<void> {
  await Promise.all(adapters.map((adapter) => adapter.stop?.())).catch(() => undefined)
  instance.ledger.close()
  instance.lock.release()
}

async function stopDeployment(
  instance: Instance,
  swarm: Swarm,
  plugins: PluginRuntimeHost,
  adapters: HarnessAdapter[],
): Promise<void> {
  let failure: unknown
  try {
    await plugins.stop()
  } catch (error) {
    failure = error
  }
  try {
    await swarm.settled()
  } catch (error) {
    failure ??= error
  }
  try {
    await Promise.all(adapters.map((adapter) => adapter.stop?.()))
  } catch (error) {
    failure ??= error
  }
  instance.ledger.close()
  instance.lock.release()
  if (failure) throw failure
}

function defaultAdapters(): HarnessAdapter[] {
  return [new CodexHarnessAdapter(), new ClaudeCodeHarnessAdapter(), new PiHarnessAdapter()]
}
