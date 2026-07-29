import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentRuntime, GitWorkspaceStore, Ledger, PluginWorkspaceRuntime, SnapshotStore, Swarm } from "../src/index.ts"
import { createFixture } from "../test-support/fixture.ts"

test("a Snapshot round-trips the complete Definition and Agent workspace seeds", async (t) => {
  const { root, swarm, workspaces, pluginGit } = await createFixture(t)
  const revision = swarm.activeRevision()
  const snapshots = new SnapshotStore(join(root, "snapshots"))
  const agentHeads = revision.agentHeads

  await snapshots.export("baseline", {
    definition: revision.definition,
    agentHeads,
    workspaces,
    pluginWorkspaces: pluginGit,
    sourceRevisionId: revision.id,
    description: "portable baseline",
  })
  const importedWorkspaces = new GitWorkspaceStore(join(root, "imported"))
  const importedPluginGit = new GitWorkspaceStore(join(root, "imported-plugins"))
  const importedLedger = new Ledger()
  const importedPlugins = new PluginWorkspaceRuntime({ ledger: importedLedger, workspaces: importedPluginGit })
  const importedRuntime = new AgentRuntime({
    ledger: importedLedger,
    workspaces: importedWorkspaces,
    adapters: [],
    pluginWorkspaces: importedPlugins,
  })
  const imported = await snapshots.instantiate("baseline", importedRuntime, importedPlugins)

  assert.deepEqual(imported.definition, revision.definition)
  assert.equal(imported.manifest.source.revisionId, revision.id)
  assert.equal(
    await importedWorkspaces.read("builder", imported.agentHeads.builder!, "AGENTS.md"),
    await workspaces.read("builder", agentHeads.builder!, "AGENTS.md"),
  )
  const chatCommit = revision.definition.plugins.find((plugin) => plugin.id === "chat")!.commit
  assert.equal(imported.pluginHeads.chat, chatCommit)
  assert.equal(
    await importedPluginGit.read("chat", chatCommit, "runtime.ts"),
    await pluginGit.read("chat", chatCommit, "runtime.ts"),
  )
  assert.equal(
    await importedWorkspaces.read("builder", imported.agentHeads.builder!, "context/initial.md"),
    await workspaces.read("builder", agentHeads.builder!, "context/initial.md"),
  )
})

test("the bundled Continual Harness snapshot is a bootstrappable Actor-Refiner Swarm", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "corallum-snapshot-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const snapshots = new SnapshotStore(join(process.cwd(), "snapshots"))
  const workspaces = new GitWorkspaceStore(join(root, "workspaces"))
  const agentRuntime = new AgentRuntime({ ledger: new Ledger(), workspaces, adapters: [] })
  const imported = await snapshots.instantiate("continual-harness", agentRuntime)

  assert.deepEqual(
    imported.definition.agents.map((agent) => agent.id),
    ["actor", "refiner"],
  )
  assert.equal(Object.keys(imported.agentHeads).length, 2)
  assert.match(
    await workspaces.read("refiner", imported.agentHeads.refiner!, "AGENTS.md"),
    /author a complete proposed `SwarmDefinition`/,
  )
  assert.match(
    await workspaces.read("refiner", imported.agentHeads.refiner!, "context/initial.md"),
    /refinement window/,
  )
  assert.match(
    await workspaces.read("refiner", imported.agentHeads.refiner!, "context.ts"),
    /export default async function compose/,
  )
})

test("the bundled Personal Agent snapshot owns four evolvable Agent workspaces", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "corallum-personal-snapshot-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const snapshots = new SnapshotStore(join(process.cwd(), "snapshots"))
  const workspaces = new GitWorkspaceStore(join(root, "workspaces"))
  const pluginGit = new GitWorkspaceStore(join(root, "plugins"))
  const ledger = new Ledger()
  const pluginWorkspaces = new PluginWorkspaceRuntime({ ledger, workspaces: pluginGit })
  const agentRuntime = new AgentRuntime({ ledger, workspaces, adapters: [], pluginWorkspaces })
  const imported = await snapshots.instantiate("personal-agent", agentRuntime, pluginWorkspaces)
  const swarm = new Swarm({ ledger, agentRuntime })
  const revision = await swarm.bootstrap({ definition: imported.definition, agentHeads: imported.agentHeads, human: "owner" })

  assert.deepEqual(imported.definition.agents.map((agent) => agent.id), [
    "chat-agent",
    "memory-builder",
    "proactivity",
    "auditor",
  ])
  assert.deepEqual(
    imported.definition.pluginIngress.filter((edge) => edge.plugin === "scheduler").map((edge) => edge.ingressTo),
    ["chat-agent", "memory-builder", "proactivity", "auditor"],
  )
  assert.deepEqual(Object.keys(imported.pluginHeads).sort(), ["chat", "scheduler", "screen"])
  assert.deepEqual(revision.definition.plugins.map((plugin) => plugin.commit), Object.values(imported.pluginHeads))
  assert.deepEqual(
    imported.definition.plugins.find((plugin) => plugin.id === "chat")?.exposedTo,
    ["chat-agent"],
  )
  assert.match(
    await workspaces.read("memory-builder", imported.agentHeads["memory-builder"]!, "AGENTS.md"),
    /improve how memory is selected, organized, connected, compressed/,
  )
  assert.match(
    await workspaces.read("auditor", imported.agentHeads.auditor!, "context.ts"),
    /export default async function compose/,
  )
})
