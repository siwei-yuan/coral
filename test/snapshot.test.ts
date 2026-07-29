import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentRuntime, GitWorkspaceStore, Ledger, SnapshotStore } from "../src/index.ts"
import { createFixture } from "../test-support/fixture.ts"

test("a Snapshot round-trips the complete Definition and Agent workspace seeds", async (t) => {
  const { root, swarm, workspaces } = await createFixture(t)
  const revision = swarm.activeRevision()
  const snapshots = new SnapshotStore(join(root, "snapshots"))
  const agentHeads = revision.agentHeads

  await snapshots.export("baseline", {
    definition: revision.definition,
    agentHeads,
    workspaces,
    sourceRevisionId: revision.id,
    description: "portable baseline",
  })
  const importedWorkspaces = new GitWorkspaceStore(join(root, "imported"))
  const importedRuntime = new AgentRuntime({ ledger: new Ledger(), workspaces: importedWorkspaces, adapters: [] })
  const imported = await snapshots.instantiate("baseline", importedRuntime)

  assert.deepEqual(imported.definition, revision.definition)
  assert.equal(imported.manifest.source.revisionId, revision.id)
  assert.equal(
    await importedWorkspaces.read("builder", imported.agentHeads.builder!, "AGENTS.md"),
    await workspaces.read("builder", agentHeads.builder!, "AGENTS.md"),
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
