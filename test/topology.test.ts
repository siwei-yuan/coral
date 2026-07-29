import assert from "node:assert/strict"
import test from "node:test"
import { contextText, createFixture, workspaceSeed } from "../test-support/fixture.ts"

test("a Proposal may add an Agent only with an initialized workspace", async (t) => {
  const { swarm, agentRuntime, adapter, definition } = await createFixture(t)
  const auditor = await agentRuntime.initializeWorkspace(
    "auditor",
    workspaceSeed("Audit completed work and report evidence."),
  )
  const proposed = structuredClone(definition)
  proposed.agents.push({ id: "auditor", harness: "scripted" })
  proposed.routes.push({ from: "builder", to: "auditor" })
  proposed.tests.push({
    id: "auditor-runs",
    inputEvents: [
      {
        type: "communication.sent",
        data: {
          from: "test/auditor-runs",
          to: ["agent/auditor"],
          content: [{ type: "text", text: "audit this result" }],
        },
      },
    ],
    expect: { eventType: "communication.sent" },
  })
  const reason = swarm.appendInput({
    type: "swarm.evolution.requested",
    actor: "external/user",
    data: { goal: "add an auditor" },
  })

  await assert.rejects(
    swarm.propose({ authoredBy: "builder", definition: proposed, reasonEventIds: [reason.id] }),
    /exactly match the Agents added/,
  )

  const proposal = await swarm.propose({
    authoredBy: "builder",
    definition: proposed,
    addedAgentHeads: { auditor: auditor.commit },
    reasonEventIds: [reason.id],
  })
  assert.equal(proposal.workspaceCommits.auditor?.[0]?.commit, auditor.commit)
  assert.ok(proposal.workspaceCommits.auditor?.[0]?.eventId)

  const fork = swarm.createFork(proposal.id, "owner")
  const runStart = adapter.runs.length
  const result = await swarm.runFork(fork.id)
  const builderRun = adapter.runs.slice(runStart).find((run) => run.agentId === "builder")
  const auditorRun = adapter.runs.slice(runStart).find((run) => run.agentId === "auditor")
  assert.ok(builderRun)
  assert.ok(auditorRun)
  const swarmContext = builderRun.context.find((message) => message.content.startsWith("# Current Swarm"))
  assert.ok(swarmContext)
  assert.match(swarmContext.content, /auditor: receives from builder/)
  assert.doesNotMatch(swarmContext.content, /core-behavior|chat-v1/)
  assert.match(contextText(auditorRun), /auditor \(you\): receives from builder/)
  const promoted = await swarm.approve(fork.id, result.frontier, "owner")
  assert.equal(swarm.activeRevision().definition.agents.some((agent) => agent.id === "auditor"), true)
  assert.equal(swarm.agentHead("auditor"), promoted.agentHeads.auditor)
})

test("a Proposal may remove an Agent without deleting its auditable history", async (t) => {
  const { swarm, adapter, definition, revision } = await createFixture(t)
  const improvement = swarm.appendInput({
    type: "agent.workspace.improvement.requested",
    actor: "external/user",
    data: { request: "improve reviewer before removal" },
  })
  await swarm.runAgentTurn({ agentId: "reviewer", inputEventId: improvement.id })
  const reason = swarm.appendInput({
    type: "swarm.evolution.requested",
    actor: "external/user",
    data: { goal: "remove the reviewer" },
  })

  const invalid = structuredClone(definition)
  invalid.agents = invalid.agents.filter((agent) => agent.id !== "reviewer")
  await assert.rejects(
    swarm.propose({ authoredBy: "builder", definition: invalid, reasonEventIds: [reason.id] }),
    /existing sender and receiver Agents/,
  )

  const proposed = structuredClone(invalid)
  proposed.routes = proposed.routes.filter((route) => route.from !== "reviewer" && route.to !== "reviewer")
  const proposal = await swarm.propose({
    authoredBy: "builder",
    definition: proposed,
    reasonEventIds: [reason.id],
  })
  assert.equal(proposal.agentHeads.reviewer, undefined)
  assert.equal(proposal.workspaceCommits.reviewer?.length, 1)

  const fork = swarm.createFork(proposal.id, "owner")
  const runStart = adapter.runs.length
  const result = await swarm.runFork(fork.id)
  const builderRun = adapter.runs.slice(runStart).find((run) => run.agentId === "builder")
  assert.ok(builderRun)
  assert.doesNotMatch(contextText(builderRun), /reviewer/)

  const promoted = await swarm.approve(fork.id, result.frontier, "owner")
  assert.equal(promoted.agentHeads.reviewer, undefined)
  assert.equal(promoted.workspaceCommits.reviewer?.length, 1)

  const historical = swarm.createFork(revision.id, "owner")
  const historicalStart = adapter.runs.length
  await swarm.runFork(historical.id)
  const historicalBuilder = adapter.runs.slice(historicalStart).find((run) => run.agentId === "builder")
  assert.ok(historicalBuilder)
  assert.match(contextText(historicalBuilder), /builder \(you\): receives from nobody; sends to reviewer/)
  assert.equal(result.status, "open")
})
