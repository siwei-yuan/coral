import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import { immutable } from "../core/canonical.ts"
import type { AgentRuntime } from "../core/agent/runtime.ts"
import type { PluginWorkspaceRuntime } from "../core/plugin/workspace.ts"
import type { SwarmDefinition } from "../core/swarm/definition.ts"
import { validateDefinition } from "../core/swarm/definition.ts"
import type { GitWorkspaceStore, WorkspaceFiles } from "../core/workspace/git-workspace.ts"

export interface SnapshotManifest {
  formatVersion: 1
  name: string
  description: string
  definition: SwarmDefinition
  workspaces: Record<string, string>
  pluginBundles: Record<string, string>
  source: {
    revisionId: string | null
    agentHeads: Record<string, string>
  }
}

interface ExportInput {
  definition: SwarmDefinition
  agentHeads: Record<string, string>
  workspaces: GitWorkspaceStore
  pluginWorkspaces?: GitWorkspaceStore
  sourceRevisionId?: string | null
  description?: string
}

export class SnapshotStore {
  readonly root: string

  constructor(root: string) {
    this.root = resolve(root)
  }

  async export(
    name: string,
    { definition, agentHeads, workspaces, pluginWorkspaces, sourceRevisionId = null, description = "" }: ExportInput,
  ): Promise<SnapshotManifest> {
    assertName(name)
    const checkedDefinition = validateDefinition(definition)
    assertExactAgents(checkedDefinition, agentHeads, "Snapshot Agent heads")
    await mkdir(this.root, { recursive: true })
    const destination = join(this.root, name)
    await mkdir(destination)

    const workspacePaths: Record<string, string> = {}
    for (const agent of checkedDefinition.agents) {
      const workspacePath = `agents/${agent.id}`
      workspacePaths[agent.id] = workspacePath
      await workspaces.exportTree(agent.id, agentHeads[agent.id]!, join(destination, workspacePath))
    }

    if (checkedDefinition.plugins.length > 0 && !pluginWorkspaces) {
      throw new Error("Snapshot export requires Plugin workspaces")
    }
    const pluginBundles: Record<string, string> = {}
    for (const plugin of checkedDefinition.plugins) {
      const bundlePath = `plugins/${plugin.id}.bundle`
      pluginBundles[plugin.id] = bundlePath
      await pluginWorkspaces!.exportBundle(plugin.id, plugin.commit, join(destination, bundlePath))
    }

    const manifest = immutable<SnapshotManifest>({
      formatVersion: 1,
      name,
      description,
      definition: checkedDefinition,
      workspaces: workspacePaths,
      pluginBundles,
      source: { revisionId: sourceRevisionId, agentHeads: { ...agentHeads } },
    })
    await writeFile(join(destination, "snapshot.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
    return manifest
  }

  async load(name: string): Promise<SnapshotManifest> {
    assertName(name)
    const parsed = JSON.parse(await readFile(join(this.root, name, "snapshot.json"), "utf8")) as SnapshotManifest
    if (parsed.formatVersion !== 1 || parsed.name !== name) throw new Error("Invalid Snapshot manifest")
    const definition = validateDefinition(parsed.definition)
    assertExactAgents(definition, parsed.workspaces, "Snapshot workspace paths")
    assertExactPlugins(definition, parsed.pluginBundles, "Snapshot Plugin bundles")
    return immutable({ ...parsed, definition })
  }

  async install(
    name: string,
    agentRuntime: AgentRuntime,
    pluginWorkspaces?: PluginWorkspaceRuntime,
  ): Promise<{
    manifest: SnapshotManifest
    definition: SwarmDefinition
    agentHeads: Record<string, string>
    pluginHeads: Record<string, string>
  }> {
    const manifest = await this.load(name)
    const agentHeads: Record<string, string> = {}
    for (const agent of manifest.definition.agents) {
      const root = safeSnapshotPath(this.root, name, manifest.workspaces[agent.id]!)
      const files = await readFiles(root)
      agentHeads[agent.id] = (await agentRuntime.initializeWorkspace(agent.id, files)).commit
    }
    if (manifest.definition.plugins.length > 0 && !pluginWorkspaces) {
      throw new Error("Snapshot import requires Plugin workspaces")
    }
    const pluginHeads: Record<string, string> = {}
    for (const plugin of manifest.definition.plugins) {
      const bundle = safeSnapshotPath(this.root, name, manifest.pluginBundles[plugin.id]!)
      pluginHeads[plugin.id] = (await pluginWorkspaces!.importBundle(plugin.id, bundle, plugin.commit)).commit
    }
    return immutable({ manifest, definition: manifest.definition, agentHeads, pluginHeads })
  }
}

async function readFiles(root: string, current = root, output: WorkspaceFiles = {}): Promise<WorkspaceFiles> {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name)
    if (entry.isDirectory()) await readFiles(root, path, output)
    else if (entry.isFile()) output[relative(root, path)] = await readFile(path)
    else throw new Error(`Snapshot workspace contains unsupported entry: ${path}`)
  }
  return output
}

function safeSnapshotPath(root: string, name: string, path: string): string {
  const snapshotRoot = join(root, name)
  const target = resolve(snapshotRoot, path)
  if (relative(snapshotRoot, target).startsWith("..")) throw new Error("Snapshot workspace path escapes root")
  return target
}

function assertExactAgents(definition: SwarmDefinition, values: Record<string, unknown>, label: string): void {
  const expected = definition.agents.map((agent) => agent.id).sort()
  const actual = Object.keys(values ?? {}).sort()
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error(`${label} must exactly match the Definition`)
}

function assertExactPlugins(definition: SwarmDefinition, values: Record<string, unknown>, label: string): void {
  const expected = definition.plugins.map((plugin) => plugin.id).sort()
  const actual = Object.keys(values ?? {}).sort()
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error(`${label} must exactly match the Definition`)
}

function assertName(name: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`Invalid Snapshot name: ${name}`)
}
