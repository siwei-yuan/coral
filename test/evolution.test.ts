import assert from "node:assert/strict"
import test from "node:test"
import { projectLedger } from "../src/index.ts"
import { contextText, createFixture } from "../test-support/fixture.ts"

test("a workspace commit immediately changes the Agent's next turn without a Swarm Proposal", async (t) => {
  const { swarm, ledger, workspaces, adapter, revision, initial } = await createFixture(t)
  const improvement = swarm.appendInput({
    type: "agent.workspace.improvement.requested",
    actor: "external/user",
    data: { request: "improve your workspace" },
  })

  const first = await swarm.runAgentTurn({ agentId: "builder", inputEventId: improvement.id })
  const followup = swarm.appendInput({
    type: "agent.workspace.followup.requested",
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

test("a Revision snapshots Agent commits and Forks can start from any Revision or Proposal", async (t) => {
  const { swarm, ledger, definition, revision } = await createFixture(t)
  for (const request of ["improve context", "improve memory"]) {
    const input = swarm.appendInput({
      type: "agent.workspace.improvement.requested",
      actor: "external/user",
      data: { request },
    })
    await swarm.runAgentTurn({ agentId: "builder", inputEventId: input.id })
  }
  const reviewInput = swarm.appendInput({
    type: "agent.workspace.improvement.requested",
    actor: "external/user",
    data: { request: "improve review procedure" },
  })
  await swarm.runAgentTurn({ agentId: "reviewer", inputEventId: reviewInput.id })
  const reason = swarm.appendInput({
    type: "swarm.evolution.requested",
    actor: "external/user",
    data: { goal: "find the best independently evolved Swarm" },
  })
  const proposedDefinition = structuredClone(definition)
  proposedDefinition.routes.push({ from: "reviewer", to: "builder" })
  const proposal = await swarm.propose({
    authoredBy: "builder",
    definition: proposedDefinition,
    reasonEventIds: [reason.id],
  })
  const first = swarm.createFork(proposal.id, "owner")
  const second = swarm.createFork(proposal.id, "owner")

  assert.equal(proposal.workspaceCommits.builder?.length, 2)
  assert.equal(proposal.workspaceCommits.reviewer?.length, 1)
  assert.equal(proposal.agentHeads.builder, swarm.agentHead("builder"))
  assert.equal(first.sourceKind, "proposal")
  assert.deepEqual(first.definition.tests, second.definition.tests)
  assert.equal(proposal.definition.routes.some((route) => route.from === "reviewer" && route.to === "builder"), true)
  assert.equal(swarm.activeRevision().definition.routes.some((route) => route.from === "reviewer"), false)
  assert.deepEqual(first.agentHeads, second.agentHeads)
  assert.equal(first.pluginBindings[0]?.mode, "mock")
  assert.equal(second.pluginBindings[0]?.mode, "mock")

  const [firstResult, secondResult] = await swarm.runForks([first.id, second.id])
  const firstInput = ledger.inScope(first.scope).find((event) => event.actor === "test/core-behavior")
  const secondInput = ledger.inScope(second.scope).find((event) => event.actor === "test/core-behavior")
  assert.deepEqual(firstInput?.data, secondInput?.data)
  assert.notEqual(firstResult?.agentHeads.builder, secondResult?.agentHeads.builder)
  const projected = projectLedger(ledger.all())
  assert.deepEqual(projected.proposals[0]?.definition, proposedDefinition)
  assert.equal(projected.forks.find((fork) => fork.id === first.id)?.tests[0]?.passed, true)
  assert.equal(
    swarm.eventsVisibleToFork(first.id).some(
      (event) => event.scope.kind === "fork" && event.scope.forkId === second.id,
    ),
    false,
  )

  assert.equal(swarm.activeRevision().id, revision.id)
  await assert.rejects(swarm.approve(first.id, firstResult!.frontier, "agent/builder"), /Human principal/)
  const promoted = await swarm.approve(first.id, firstResult!.frontier, "reviewer")
  assert.equal(promoted.sourceForkId, first.id)
  assert.equal(promoted.agentHeads.builder, firstResult?.agentHeads.builder)
  assert.equal(promoted.workspaceCommits.builder?.length, 3)
  assert.equal(promoted.workspaceCommits.reviewer?.length, 1)
  assert.equal(promoted.definition.plugins[0]?.mode, "live")
  assert.equal(swarm.fork(first.id).status, "approved")
  await swarm.deny(second.id, secondResult!.frontier, "reviewer", "The first fork was clearer")
  assert.equal(swarm.fork(second.id).status, "denied")
  const promotedFork = swarm.createFork(promoted.id, "owner")
  assert.equal(promotedFork.sourceKind, "revision")
  await swarm.runFork(promotedFork.id)
  const historical = swarm.createFork(revision.id, "owner")
  const oldProposal = swarm.createFork(proposal.id, "owner")
  assert.equal(historical.agentHeads.builder, revision.agentHeads.builder)
  await swarm.runForks([historical.id, oldProposal.id])
  assert.equal(ledger.verify(), true)
})

test("the selected Fork becomes Main and later Main workspace commits continue after its Revision snapshot", async (t) => {
  const { swarm, ledger, workspaces, revision } = await createFixture(t)
  const reason = swarm.appendInput({
    type: "swarm.evolution.requested",
    actor: "external/user",
    data: { goal: "evaluate a new Swarm snapshot" },
  })
  const proposal = await swarm.propose({ authoredBy: "builder", reasonEventIds: [reason.id] })
  const fork = swarm.createFork(proposal.id, "owner")
  const forkResult = await swarm.runFork(fork.id)

  const continued = swarm.appendInput({
    type: "agent.workspace.continuation.requested",
    actor: "external/user",
    data: { request: "continue evolving while the Proposal is evaluated" },
  })
  const tail = await swarm.runAgentTurn({ agentId: "builder", inputEventId: continued.id })
  const oldMainHead = tail.revision.commit

  const promoted = await swarm.approve(fork.id, forkResult.frontier, "owner")

  const newMainHead = swarm.agentHead("builder")
  assert.equal(swarm.activeRevision().id, promoted.id)
  assert.equal(promoted.agentHeads.builder, forkResult.agentHeads.builder)
  assert.notEqual(newMainHead, promoted.agentHeads.builder)
  assert.notEqual(newMainHead, oldMainHead)
  assert.match(await workspaces.read("builder", newMainHead, "memory/last-run.txt"), new RegExp(fork.id))
  assert.match(await workspaces.read("builder", newMainHead, "memory/main-tail.txt"), /continued on Main/)
  assert.equal(swarm.fork(fork.id).status, "approved")

  const activation = ledger.all().find(
    (event) => event.type === "swarm.revision.activated" && event.swarmRevision === promoted.id,
  )
  assert.ok(activation)
  const activationData = activation.data as { revision: { sourceForkId: string }; workspaceHeads: Record<string, string> }
  assert.equal(activationData.revision.sourceForkId, fork.id)
  assert.equal(activationData.workspaceHeads.builder, newMainHead)
  const reapplied = ledger.all().find(
    (event) =>
      event.type === "agent.workspace.reapplied" &&
      (event.data as { sourceCommit?: string }).sourceCommit === oldMainHead,
  )
  assert.equal((reapplied?.data as { commit?: string }).commit, newMainHead)
  assert.equal(promoted.parentRevision, revision.id)

  const nextReason = swarm.appendInput({
    type: "swarm.evolution.requested",
    actor: "external/user",
    data: { goal: "snapshot the continued Main" },
  })
  const nextProposal = await swarm.propose({ authoredBy: "builder", reasonEventIds: [nextReason.id] })
  assert.equal(nextProposal.agentHeads.builder, newMainHead)
  assert.equal(nextProposal.workspaceCommits.builder?.at(-1)?.commit, newMainHead)
})

test("a workspace conflict leaves the old Main intact", async (t) => {
  const { swarm, ledger, revision } = await createFixture(t)
  const reason = swarm.appendInput({
    type: "swarm.evolution.requested",
    actor: "external/user",
    data: { goal: "evaluate a conflicting Swarm snapshot" },
  })
  const proposal = await swarm.propose({ authoredBy: "builder", reasonEventIds: [reason.id] })
  const fork = swarm.createFork(proposal.id, "owner")
  const forkResult = await swarm.runFork(fork.id)

  const continued = swarm.appendInput({
    type: "agent.workspace.improvement.requested",
    actor: "external/user",
    data: { request: "write the same Main workspace file differently" },
  })
  const tail = await swarm.runAgentTurn({ agentId: "builder", inputEventId: continued.id })

  await assert.rejects(swarm.approve(fork.id, forkResult.frontier, "owner"), /Cannot reapply workspace commit/)
  assert.equal(swarm.activeRevision().id, revision.id)
  assert.equal(swarm.agentHead("builder"), tail.revision.commit)
  assert.equal(swarm.fork(fork.id).status, "open")
  assert.equal(
    ledger.all().some(
      (event) =>
        event.type === "swarm.decision.recorded" &&
        (event.data as { forkId?: string }).forkId === fork.id,
    ),
    false,
  )
})
