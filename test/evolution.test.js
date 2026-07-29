import assert from "node:assert/strict"
import test from "node:test"
import { createFixture } from "../test-support/fixture.js"

test("Agent workspace commits remain draft history until an explicit Proposal", async (t) => {
  const { swarm, ledger, workspaces, adapter, revision, initial } = await createFixture(t)
  const input = swarm.appendInput({
    type: "improvement.requested",
    actor: "external/user",
    data: { request: "improve your workspace" },
  })

  const turn = await swarm.runDevelopmentTurn({ agentId: "builder", inputEventId: input.id })

  assert.notEqual(turn.revision.commit, initial.commit)
  assert.equal(swarm.activeRevision().id, revision.id)
  assert.equal(swarm.activeRevision().agents.builder.workspaceCommit, initial.commit)
  assert.equal(swarm.draftHead("builder"), turn.revision.commit)
  assert.equal(turn.workspaceEvent.type, "agent.workspace.committed")
  assert.equal(turn.turnEvent.type, "agent.turn.recorded")
  assert.match(adapter.runs[0].instructions, /Own this workspace/)
  assert.match(adapter.runs[0].initialContext, /Build and improve/)
  assert.match(await workspaces.read("builder", turn.revision.commit, "AGENTS.md"), /Evolved responsibility/)
  assert.match(await workspaces.read("builder", turn.revision.commit, "context/initial.md"), /prior Events/)
  assert.doesNotMatch(await workspaces.read("builder", initial.commit, "AGENTS.md"), /Evolved responsibility/)
  assert.equal(ledger.all().some((event) => event.type === "swarm.revision.proposed"), false)
  assert.equal(ledger.verify(), true)
})

test("one Proposal creates isolated complete Forks with the same tests and inputs", async (t) => {
  const { swarm, ledger, definition, revision } = await createFixture(t)
  const reason = swarm.appendInput({
    type: "evolution.requested",
    actor: "external/user",
    data: { goal: "find the best independently evolved Swarm" },
  })
  const proposedDefinition = structuredClone(definition)
  proposedDefinition.routes.push({ on: "review.requested", to: "builder" })
  const proposal = swarm.propose({
    authoredBy: "builder",
    definition: proposedDefinition,
    reasonEventIds: [reason.id],
  })
  const first = swarm.createFork(proposal.id)
  const second = swarm.createFork(proposal.id)

  assert.deepEqual(first.definition.tests, second.definition.tests)
  assert.equal(proposal.definition.routes.some((route) => route.on === "review.requested"), true)
  assert.equal(swarm.activeRevision().definition.routes.some((route) => route.on === "review.requested"), false)
  assert.deepEqual(first.agentHeads, second.agentHeads)
  assert.equal(first.pluginBindings[0].mode, "mock")
  assert.equal(second.pluginBindings[0].mode, "mock")

  const [firstResult, secondResult] = await swarm.runForks([first.id, second.id])
  const firstInput = ledger.inScope(first.scope).find((event) => event.type === "test.requested")
  const secondInput = ledger.inScope(second.scope).find((event) => event.type === "test.requested")

  assert.deepEqual(firstInput.data, secondInput.data)
  assert.equal(firstResult.results[0].passed, true)
  assert.equal(secondResult.results[0].passed, true)
  assert.notEqual(firstResult.agentHeads.builder, secondResult.agentHeads.builder)
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
  assert.equal(candidate.agents.builder.workspaceCommit, firstResult.agentHeads.builder)
  assert.equal(candidate.pluginBindings[0].mode, "live")
  assert.throws(() => swarm.approveAndActivate(candidate.id, "agent/builder"), /Human principal/)
  assert.equal(swarm.activeRevision().id, revision.id)

  swarm.approveAndActivate(candidate.id, "reviewer")
  assert.equal(swarm.activeRevision().id, candidate.id)
  assert.equal(ledger.verify(), true)
})
