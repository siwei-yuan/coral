import assert from "node:assert/strict"
import test from "node:test"
import { createFixture, userMessage } from "../test-support/fixture.ts"

test("Main routes Agent Communication through the active Swarm Definition", async (t) => {
  const { swarm, adapter } = await createFixture(t)
  const input = swarm.appendInput(userMessage("builder", "coordinate this work", { forwardTo: "reviewer" }))

  const turns = await swarm.dispatch(input.id)

  assert.deepEqual(
    turns.map((turn) => (turn.turnEvent.data as { agentId: string }).agentId),
    ["builder", "reviewer"],
  )
  assert.deepEqual(
    adapter.runs.slice(-2).map((run) => run.agentId),
    ["builder", "reviewer"],
  )
  const builderPlugin = adapter.runs.at(-2)?.commands.find((command) => command.id === "chat")
  assert.ok(builderPlugin)
  assert.equal(builderPlugin.env?.CORALLUM_AGENT_ID, "builder")
  assert.equal(builderPlugin.env?.CORALLUM_PLUGIN_MODE, "live")
  assert.equal(adapter.runs.at(-1)?.commands.some((command) => command.id === "chat"), false)
})

test("an Agent may propose a Swarm Revision from its turn", async (t) => {
  const { swarm, ledger, definition, revision } = await createFixture(t)
  const proposed = structuredClone(definition)
  proposed.routes.push({ from: "reviewer", to: "builder" })
  const input = swarm.appendInput(userMessage("builder", "propose bidirectional review", {
    proposalDefinition: proposed,
  }))

  await swarm.dispatch(input.id)

  assert.equal(ledger.all().some((event) => event.type.endsWith(".requested")), false)
  const created = ledger.all().find((event) => event.type === "swarm.revision.proposed")
  assert.ok(created)
  const turn = ledger.all().find((event) => event.type === "agent.turn.recorded" &&
    (event.data as { agentId?: string }).agentId === "builder")
  assert.deepEqual(created.causation, [turn?.id])
  assert.equal(swarm.activeRevision().id, revision.id)
  assert.deepEqual((created.data as { definition: typeof proposed }).definition, proposed)
})

test("an Agent may read a peer workspace snapshot and communicate a suggestion", async (t) => {
  const { swarm, ledger, adapter } = await createFixture(t)
  const input = swarm.appendInput(userMessage("builder", "review the reviewer instructions", {
    readPeer: "reviewer",
    readPath: "AGENTS.md",
    forwardTo: "reviewer",
  }))

  await swarm.dispatch(input.id)

  const reply = ledger.all().find(
    (event) => event.type === "communication.sent" && event.actor === "agent/builder",
  )
  const text = (reply?.data as { content: Array<{ text: string }> }).content[0]?.text
  assert.match(text ?? "", /Own this workspace/)
  assert.deepEqual(
    adapter.runs.slice(-2).map((run) => run.agentId),
    ["builder", "reviewer"],
  )
})
