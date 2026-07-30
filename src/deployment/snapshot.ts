import { join, resolve } from "node:path"
import { AgentRuntime } from "../core/agent/runtime.ts"
import { Ledger } from "../core/ledger/ledger.ts"
import { PluginWorkspaceRuntime } from "../core/plugin/workspace.ts"
import { Swarm } from "../core/swarm/runtime.ts"
import { GitWorkspaceStore } from "../core/workspace/git-workspace.ts"
import { ClaudeCodeHarnessAdapter } from "../harness/claude-code.ts"
import { CodexHarnessAdapter } from "../harness/codex.ts"
import type { HarnessAdapter } from "../harness/adapter.ts"
import { PiHarnessAdapter } from "../harness/pi.ts"
import type { SnapshotManifest, SnapshotStore } from "../snapshots/store.ts"
import { DefaultView } from "../view/default/index.ts"
import { PluginRuntimeHost } from "./plugin-runtime.ts"

export interface SnapshotDeployment {
  manifest: SnapshotManifest
  ledger: Ledger
  swarm: Swarm
  view: DefaultView
  settled(): Promise<void>
  stop(): Promise<void>
}

export async function deploySnapshot({
  snapshots,
  name,
  instanceRoot,
  human,
  adapters = defaultAdapters(),
  pluginEnvironments = {},
}: {
  snapshots: SnapshotStore
  name: string
  instanceRoot: string
  human: string
  adapters?: HarnessAdapter[]
  pluginEnvironments?: Record<string, Record<string, string>>
}): Promise<SnapshotDeployment> {
  const root = resolve(instanceRoot)
  const ledger = new Ledger()
  const agentWorkspaces = new GitWorkspaceStore(join(root, "agents"))
  const pluginGit = new GitWorkspaceStore(join(root, "plugins"))
  const pluginWorkspaces = new PluginWorkspaceRuntime({ ledger, workspaces: pluginGit })
  const agentRuntime = new AgentRuntime({ ledger, workspaces: agentWorkspaces, adapters, pluginWorkspaces })
  const installed = await snapshots.install(name, agentRuntime, pluginWorkspaces)
  const pluginEnvironment = (pluginId: string) => ({
    ...(pluginEnvironments[pluginId] ?? {}),
    CORALLUM_PLUGIN_STATE: join(root, "state", pluginId),
  })
  const swarm = new Swarm({
    ledger,
    agentRuntime,
    pluginEnvironment,
  })
  const plugins = new PluginRuntimeHost({
    swarm,
    workspaces: pluginWorkspaces,
    stateRoot: join(root, "state"),
    environment: pluginEnvironment,
  })
  try {
    await swarm.bootstrap({ definition: installed.definition, agentHeads: installed.agentHeads, human })
    await plugins.start()
  } catch (error) {
    await plugins.stop()
    throw error
  }
  const view = new DefaultView({ swarm, human, extensions: () => plugins.extensions() })
  return {
    manifest: installed.manifest,
    ledger,
    swarm,
    view,
    settled: () => plugins.settled(),
    stop: () => plugins.stop(),
  }
}

function defaultAdapters(): HarnessAdapter[] {
  return [new CodexHarnessAdapter(), new ClaudeCodeHarnessAdapter(), new PiHarnessAdapter()]
}
