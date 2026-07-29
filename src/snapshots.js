import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import { immutable } from "./canonical.js"
import { validateDefinition } from "./swarm.js"

export class SnapshotStore {
  constructor(root) {
    this.root = resolve(root)
  }

  async export(name, { definition, agentHeads, workspaces, sourceRevisionId = null, description = "" }) {
    assertName(name)
    const checkedDefinition = validateDefinition(definition)
    assertSnapshotHeads(checkedDefinition, agentHeads)
    await mkdir(this.root, { recursive: true })
    const destination = join(this.root, name)
    await mkdir(destination)

    const workspacePaths = {}
    for (const agent of checkedDefinition.agents) {
      const workspacePath = `agents/${agent.id}`
      workspacePaths[agent.id] = workspacePath
      await workspaces.exportTree(agent.id, agentHeads[agent.id], join(destination, workspacePath))
    }

    const manifest = immutable({
      formatVersion: 1,
      name,
      description,
      definition: checkedDefinition,
      workspaces: workspacePaths,
      source: {
        revisionId: sourceRevisionId,
        agentHeads: { ...agentHeads },
      },
    })
    await writeFile(join(destination, "snapshot.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
    return manifest
  }

  async load(name) {
    assertName(name)
    const manifest = JSON.parse(await readFile(join(this.root, name, "snapshot.json"), "utf8"))
    if (manifest.formatVersion !== 1 || manifest.name !== name) throw new Error("Invalid Snapshot manifest")
    const definition = validateDefinition(manifest.definition)
    assertSnapshotPaths(definition, manifest.workspaces)
    return immutable({ ...manifest, definition })
  }

  async instantiate(name, workspaces) {
    const manifest = await this.load(name)
    const agentHeads = {}
    for (const agent of manifest.definition.agents) {
      const root = safeSnapshotPath(this.root, name, manifest.workspaces[agent.id])
      const files = await readFiles(root)
      agentHeads[agent.id] = (await workspaces.initialize(agent.id, files)).commit
    }
    return immutable({ manifest, definition: manifest.definition, agentHeads })
  }
}

async function readFiles(root, current = root, output = {}) {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name)
    if (entry.isDirectory()) await readFiles(root, path, output)
    else if (entry.isFile()) output[relative(root, path)] = await readFile(path)
    else throw new Error(`Snapshot workspace contains unsupported entry: ${path}`)
  }
  return output
}

function safeSnapshotPath(root, name, path) {
  const snapshotRoot = join(root, name)
  const target = resolve(snapshotRoot, path)
  if (relative(snapshotRoot, target).startsWith("..")) throw new Error("Snapshot workspace path escapes root")
  return target
}

function assertSnapshotHeads(definition, heads) {
  const expected = definition.agents.map((agent) => agent.id).sort()
  const actual = Object.keys(heads).sort()
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error("Snapshot Agent heads must exactly match the Definition")
  }
}

function assertSnapshotPaths(definition, paths) {
  const expected = definition.agents.map((agent) => agent.id).sort()
  const actual = Object.keys(paths ?? {}).sort()
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error("Snapshot workspace paths must exactly match the Definition")
  }
}

function assertName(name) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`Invalid Snapshot name: ${name}`)
}
