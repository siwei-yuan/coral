import assert from "node:assert/strict"
import test from "node:test"
import { contextText, createFixture } from "../test-support/fixture.ts"

test("a workspace commit immediately changes the Agent's next turn without a Swarm Proposal", async (t) => {
  const { swarm, ledger, workspaces, adapter, revision, initial } = await createFixture(t)
  const improvement = swarm.appendInput({
    type: "improvement.requested",
    actor: "external/user",
    data: { request: "improve your workspace" },
  })

  const first = await swarm.runAgentTurn({ agentId: "builder", inputEventId: improvement.id })
  const followup = swarm.appendInput({
    type: "followup.requested",
    actor: "external/user",
    data: { request: "use your improved workspace" },
  })
  const second = await swarm.runAgentTurn({ agentId: "builder", inputEventId: followup.id })

  assert.notEqual(first.revision.commit, initial.commit)
  assert.equal(swarm.agentHead("builder"), second.revision.commit)
  assert.equal(swarm.activeRevision().id, revision.id)
  assert.equal(swarm.activeRevision().agentHeads.builder, initial.commit)
  assert.equal(first.workspaceEvent?.type, "agent.workspace.committed")
  assert.equal(first.turnEvent.type, "agent.turn.recorded")
  const turnData = first.turnEvent.data as { inputWorkspaceCommit: string; workspaceCommit: string }
  assert.equal(turnData.inputWorkspaceCommit, initial.commit)
  assert.equal(turnData.workspaceCommit, first.revision.commit)
  assert.match(contextText(adapter.runs[0]!), /composer:v1/)
  assert.match(contextText(adapter.runs[0]!), /reviewer/)
  assert.match(contextText(adapter.runs[1]!), /Evolved responsibility/)
  assert.match(contextText(adapter.runs[1]!), /prior Events/)
  assert.match(contextText(adapter.runs[1]!), /composer:v2/)
  assert.match(await workspaces.read("builder", first.revision.commit, "AGENTS.md"), /Evolved responsibility/)
  assert.match(await workspaces.read("builder", first.revision.commit, "context.ts"), /composer:v2/)
  assert.doesNotMatch(await workspaces.read("builder", initial.commit, "AGENTS.md"), /Evolved responsibility/)
  assert.equal(ledger.all().some((event) => event.type === "swarm.revision.proposed"), false)
  assert.equal(ledger.verify(), true)
})

test("a Revision aggregates Agent commits and Forks can start from any Revision or Proposal", async (t) => {
  const { swarm, ledger, definition, revision } = await createFixture(t)
  for (const request of ["improve context", "improve memory"]) {
    const input = swarm.appendInput({ type: "improvement.requested", actor: "external/user", data: { request } })
    await swarm.runAgentTurn({ agentId: "builder", inputEventId: input.id })
  }
  const reviewInput = swarm.appendInput({
    type: "improvement.requested",
    actor: "external/user",
    data: { request: "improve review procedure" },
  })
  await swarm.runAgentTurn({ agentId: "reviewer", inputEventId: reviewInput.id })
  const reason = swarm.appendInput({
    type: "evolution.requested",
    actor: "external/user",
    data: { goal: "find the best independently evolved Swarm" },
  })
  const proposedDefinition = structuredClone(definition)
  proposedDefinition.routes.push({ on: "review.completed", to: "builder" })
  const proposal = swarm.propose({ authoredBy: "builder", definition: proposedDefinition, reasonEventIds: [reason.id] })
  const first = swarm.createFork(proposal.id)
  const second = swarm.createFork(proposal.id)

  assert.equal(proposal.workspaceCommits.builder?.length, 2)
  assert.equal(proposal.workspaceCommits.reviewer?.length, 1)
  assert.equal(proposal.agentHeads.builder, swarm.agentHead("builder"))
  assert.equal(first.sourceKind, "proposal")
  assert.deepEqual(first.definition.tests, second.definition.tests)
  assert.equal(proposal.definition.routes.some((route) => route.on === "review.completed"), true)
  assert.equal(swarm.activeRevision().definition.routes.some((route) => route.on === "review.completed"), false)
  assert.deepEqual(first.agentHeads, second.agentHeads)
  assert.equal(first.pluginBindings[0]?.mode, "mock")
  assert.equal(second.pluginBindings[0]?.mode, "mock")

  const [firstResult, secondResult] = await swarm.runForks([first.id, second.id])
  const firstInput = ledger.inScope(first.scope).find((event) => event.type === "test.requested")
  const secondInput = ledger.inScope(second.scope).find((event) => event.type === "test.requested")
  assert.deepEqual(firstInput?.data, secondInput?.data)
  assert.equal(firstResult?.results?.[0]?.passed, true)
  assert.equal(secondResult?.results?.[0]?.passed, true)
  assert.notEqual(firstResult?.agentHeads.builder, secondResult?.agentHeads.builder)
  assert.equal(
    swarm.eventsVisibleToFork(first.id).some(
      (event) => event.scope.kind === "fork" && event.scope.forkId === second.id,
    ),
    false,
  )

  swarm.selectFork({ proposalId: proposal.id, forkId: first.id, selectedBy: "agent/builder" })
  const candidate = swarm.freezeCandidate(proposal.id)
  assert.equal(swarm.activeRevision().id, revision.id)
  assert.equal(candidate.selectedForkId, first.id)
  assert.equal(candidate.agentHeads.builder, firstResult?.agentHeads.builder)
  assert.equal(candidate.workspaceCommits.builder?.length, 3)
  assert.equal(candidate.workspaceCommits.reviewer?.length, 1)
  assert.equal(candidate.pluginBindings[0]?.mode, "live")
  assert.throws(() => swarm.approveAndActivate(candidate.id, "agent/builder"), /Human principal/)
  const candidateFork = swarm.createFork(candidate.id)
  assert.equal(candidateFork.sourceKind, "revision")
  assert.equal((await swarm.runFork(candidateFork.id)).results?.[0]?.passed, true)

  swarm.approveAndActivate(candidate.id, "reviewer")
  const historical = swarm.createFork(revision.id)
  const oldProposal = swarm.createFork(proposal.id)
  assert.equal(historical.agentHeads.builder, revision.agentHeads.builder)
  const [historicalResult, oldProposalResult] = await swarm.runForks([historical.id, oldProposal.id])
  assert.equal(historicalResult?.results?.[0]?.passed, true)
  assert.equal(oldProposalResult?.results?.[0]?.passed, true)
  assert.equal(ledger.verify(), true)
})
