import assert from "node:assert/strict"
import test from "node:test"
import { createFixture } from "../test-support/fixture.ts"

test("Main routes Agent Communication through the active Swarm Definition", async (t) => {
  const { swarm, adapter } = await createFixture(t)
  const input = swarm.appendInput({
    type: "communication.sent",
    actor: "external/user",
    data: {
      from: "external/user",
      to: ["agent/builder"],
      content: [{ type: "text", text: "coordinate this work" }],
      forwardTo: "agent/reviewer",
    },
  })

  const turns = await swarm.dispatch(input.id)

  assert.deepEqual(
    turns.map((turn) => (turn.turnEvent.data as { agentId: string }).agentId),
    ["builder", "reviewer"],
  )
  assert.deepEqual(
    adapter.runs.slice(-2).map((run) => run.agentId),
    ["builder", "reviewer"],
  )
})

test("an Agent may request a Swarm Revision Proposal from its turn", async (t) => {
  const { swarm, ledger, definition, revision } = await createFixture(t)
  const proposed = structuredClone(definition)
  proposed.routes.push({ from: "reviewer", to: "builder" })
  const input = swarm.appendInput({
    type: "communication.sent",
    actor: "external/user",
    data: {
      from: "external/user",
      to: ["agent/builder"],
      content: [{ type: "text", text: "propose bidirectional review" }],
      proposalDefinition: proposed,
    },
  })

  await swarm.dispatch(input.id)

  const requested = ledger.all().find((event) => event.type === "swarm.revision.requested")
  assert.ok(requested)
  const created = ledger.all().find(
    (event) => event.type === "swarm.revision.proposed" && event.causation.includes(requested.id),
  )
  assert.ok(created)
  assert.equal(swarm.activeRevision().id, revision.id)
  assert.equal((created.data as { definitionDigest: string }).definitionDigest.length > 0, true)
})

test("an Agent may read a peer workspace snapshot and communicate a suggestion", async (t) => {
  const { swarm, ledger, adapter } = await createFixture(t)
  const input = swarm.appendInput({
    type: "communication.sent",
    actor: "external/user",
    data: {
      from: "external/user",
      to: ["agent/builder"],
      content: [{ type: "text", text: "review the reviewer instructions" }],
      readPeer: "reviewer",
      readPath: "AGENTS.md",
      forwardTo: "agent/reviewer",
    },
  })

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
