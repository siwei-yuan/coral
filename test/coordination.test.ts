import assert from "node:assert/strict"
import test from "node:test"
import { createFixture, proposeFromAgent, userMessage, type RecordedRun } from "../test-support/fixture.ts"

test("Main routes Agent Communication through the active Swarm Definition", async (t) => {
  const { swarm, ledger, adapter } = await createFixture(t)
  const input = swarm.appendInput(userMessage("builder", "coordinate this work", { forwardTo: "reviewer" }))

  swarm.route(input.id)
  await swarm.settled()

  assert.deepEqual(
    ledger.all().filter((event) => event.type === "agent.turn.recorded")
      .map((event) => (event.data as { agentId: string }).agentId),
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

  swarm.route(input.id)
  await swarm.settled()

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

  swarm.route(input.id)
  await swarm.settled()

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

test("Agents run independently and apply their own turn policies", async (t) => {
  const { swarm, adapter } = await createFixture(t)
  const releaseBuilder = adapter.blockNext("builder")
  const builderFirst = swarm.appendInput(userMessage("builder", "builder one"))
  swarm.route(builderFirst.id)
  await waitFor(() => runsFor(adapter.runs, "builder").length === 1)

  const reviewerFirst = swarm.appendInput(userMessage("reviewer", "reviewer one"))
  swarm.route(reviewerFirst.id)
  await waitFor(() => runsFor(adapter.runs, "reviewer").length === 1)

  for (const text of ["builder two", "builder three"]) {
    swarm.route(swarm.appendInput(userMessage("builder", text)).id)
  }
  for (const text of ["reviewer two", "reviewer three"]) {
    swarm.route(swarm.appendInput(userMessage("reviewer", text)).id)
  }
  releaseBuilder()
  await swarm.settled()

  const builderRuns = runsFor(adapter.runs, "builder")
  const reviewerRuns = runsFor(adapter.runs, "reviewer")
  assert.equal(builderRuns.length, 2)
  assert.equal(inputCount(builderRuns[1]!), 2)
  assert.equal(reviewerRuns.length, 3)
  assert.deepEqual(reviewerRuns.map(inputCount), [1, 1, 1])
})

test("activation preserves pending Events and refuses to remove their Agent", async (t) => {
  const { swarm, adapter, definition } = await createFixture(t)
  const releaseReviewer = adapter.blockNext("reviewer")
  swarm.route(swarm.appendInput(userMessage("reviewer", "running")).id)
  await waitFor(() => runsFor(adapter.runs, "reviewer").length === 1)
  swarm.route(swarm.appendInput(userMessage("reviewer", "pending")).id)

  const proposed = structuredClone(definition)
  proposed.agents = proposed.agents.filter((agent) => agent.id !== "reviewer")
  proposed.routes = proposed.routes.filter((route) => route.from !== "reviewer" && route.to !== "reviewer")
  const proposal = await proposeFromAgent(swarm, { definition: proposed })
  const fork = swarm.createFork(proposal.id, "owner")
  const evaluated = await swarm.runFork(fork.id)
  const approval = swarm.approve(fork.id, evaluated.frontier, "owner")

  releaseReviewer()
  await assert.rejects(approval, /Cannot remove Agent with pending Events: reviewer/)
  await swarm.settled()
  const revision = await swarm.approve(fork.id, swarm.fork(fork.id).frontier, "owner")

  assert.deepEqual(revision.definition.agents.map((agent) => agent.id), ["builder"])
  assert.equal(runsFor(adapter.runs, "reviewer").length, 2)
})

function runsFor(runs: RecordedRun[], agentId: string): RecordedRun[] {
  return runs.filter((run) => run.agentId === agentId)
}

function inputCount(run: RecordedRun): number {
  for (const message of run.context.toReversed()) {
    try {
      const value = JSON.parse(message.content)
      if (Array.isArray(value)) return value.length
    } catch {}
  }
  throw new Error("Agent context contains no input Events")
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("Timed out waiting for Agent turn")
}
