import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"
import { PluginRuntimeHost } from "../src/deployment/plugin-runtime.ts"
import { contextText, createFixture, proposeFromAgent, userMessage } from "../test-support/fixture.ts"

test("a workspace commit immediately changes the Agent's next turn without a Swarm Proposal", async (t) => {
  const { swarm, ledger, workspaces, adapter, revision, initial } = await createFixture(t)
  const improvement = swarm.appendInput(userMessage("builder", "improve your workspace", {
    command: "improve-agent",
  }))

  const first = await swarm.runAgentTurn({ agentId: "builder", inputEventIds: [improvement.id] })
  const followup = swarm.appendInput(userMessage("builder", "use your improved workspace"))
  const second = await swarm.runAgentTurn({ agentId: "builder", inputEventIds: [followup.id] })

  assert.notEqual(first.workspaceCommit.commit, initial.commit)
  assert.equal(swarm.agentHead("builder"), second.workspaceCommit.commit)
  assert.equal(swarm.activeRevision().id, revision.id)
  assert.equal(swarm.activeRevision().agentHeads.builder, initial.commit)
  assert.equal(first.workspaceEvents[0]?.type, "agent.workspace.committed")
  assert.equal(first.turnEvent.type, "agent.turn.recorded")
  const turnData = first.turnEvent.data as { inputWorkspaceCommit: string; workspaceCommit: string }
  assert.equal(turnData.inputWorkspaceCommit, initial.commit)
  assert.equal(turnData.workspaceCommit, first.workspaceCommit.commit)
  assert.match(contextText(adapter.runs[0]!), /composer:v1/)
  assert.match(contextText(adapter.runs[0]!), /reviewer/)
  assert.match(contextText(adapter.runs[0]!), /Use this capability deliberately/)
  assert.match(contextText(adapter.runs[0]!), /plugin-workspaces/)
  assert.match(contextText(adapter.runs[1]!), /Evolved responsibility/)
  assert.match(contextText(adapter.runs[1]!), /prior Events/)
  assert.match(contextText(adapter.runs[1]!), /composer:v2/)
  assert.match(await workspaces.read("builder", first.workspaceCommit.commit, "AGENTS.md"), /Evolved responsibility/)
  assert.match(await workspaces.read("builder", first.workspaceCommit.commit, "context.ts"), /composer:v2/)
  assert.doesNotMatch(await workspaces.read("builder", initial.commit, "AGENTS.md"), /Evolved responsibility/)
  assert.equal(ledger.all().some((event) => event.type === "swarm.revision.proposed"), false)
  assert.equal(ledger.verify(), true)
})

test("a turn records Agent-authored commits and restores uncommitted changes", async (t) => {
  const { swarm, ledger, initial } = await createFixture(t)
  const committed = swarm.appendInput(userMessage("builder", "record two durable learnings", {
    command: "two-agent-commits",
  }))
  const result = await swarm.runAgentTurn({ agentId: "builder", inputEventIds: [committed.id] })

  assert.equal(result.workspaceEvents.length, 2)
  assert.deepEqual(
    result.workspaceEvents.map((event) => (event.data as { message: string }).message),
    ["Record the first learning", "Record the second learning"],
  )
  assert.equal(
    (result.workspaceEvents[1]!.data as { parentCommit: string }).parentCommit,
    (result.workspaceEvents[0]!.data as { commit: string }).commit,
  )
  assert.equal(swarm.agentHead("builder"), result.workspaceCommit.commit)

  const dirty = swarm.appendInput(userMessage("builder", "leave this uncommitted", { command: "leave-dirty" }))
  const restored = await swarm.runAgentTurn({ agentId: "builder", inputEventIds: [dirty.id] })
  const turn = restored.turnEvent.data as { outcome: string; failure?: string }
  assert.deepEqual(restored.workspaceEvents.map((event) => event.type), ["agent.workspace.restored"])
  assert.equal(restored.workspaceCommit.commit, result.workspaceCommit.commit)
  assert.equal(swarm.agentHead("builder"), result.workspaceCommit.commit)
  assert.equal(turn.outcome, "completed")
  assert.equal(turn.failure, undefined)
  assert.equal(ledger.verify(), true)
  assert.notEqual(result.workspaceCommit.commit, initial.commit)
})

test("Harness checkpoints resume until a workspace or Swarm snapshot boundary forks the session", async (t) => {
  const { swarm, adapter, ledger } = await createFixture(t)
  const run = async (text: string, data: Record<string, unknown> = {}) => {
    const event = swarm.appendInput(userMessage("builder", text, data))
    return swarm.runAgentTurn({ agentId: "builder", inputEventIds: [event.id] })
  }

  const first = await run("observe")
  const second = await run("observe again")
  assert.equal(adapter.runs[1]?.forkSession, false)
  assert.equal(first.checkpoint?.sessionId, second.checkpoint?.sessionId)

  await run("change your context", { command: "improve-agent" })
  const afterCommit = await run("use the new context")
  assert.equal(adapter.runs[3]?.forkSession, true)
  assert.notEqual(second.checkpoint?.sessionId, afterCommit.checkpoint?.sessionId)

  const proposal = await proposeFromAgent(swarm)
  const proposalEvent = ledger.get(proposal.eventId)
  const proposalTurn = ledger.get(proposalEvent.causation[0]!)
  const proposalCheckpoint = (proposalTurn.data as { trajectory: typeof afterCommit.checkpoint }).trajectory
  assert.equal(proposalTurn.actor, "agent/runtime")
  assert.equal(typeof (proposalTurn.data as { turnId?: unknown }).turnId, "string")
  const afterProposal = await run("continue on Main")
  assert.equal(adapter.runs[5]?.forkSession, true)
  assert.notEqual(afterCommit.checkpoint?.sessionId, afterProposal.checkpoint?.sessionId)

  const firstFork = swarm.createFork(proposal.id, "owner")
  const secondFork = swarm.createFork(proposal.id, "owner")
  const start = adapter.runs.length
  await swarm.runForks([firstFork.id, secondFork.id])
  const forkRuns = adapter.runs.slice(start).filter((item) => item.agentId === "builder")
  assert.equal(forkRuns.length, 2)
  assert.equal(forkRuns.every((item) => item.forkSession), true)
  assert.deepEqual(forkRuns[0]?.checkpoint, proposalCheckpoint)
  assert.deepEqual(forkRuns[1]?.checkpoint, proposalCheckpoint)
  const forkTurns = [firstFork, secondFork].flatMap((fork) =>
    swarm.eventsVisibleToFork(fork.id).filter((event) => event.type === "agent.turn.recorded" && event.scope.kind === "fork"),
  )
  assert.equal(new Set(forkTurns.map((event) =>
    ((event.data as { trajectory: { sessionId: string } }).trajectory.sessionId),
  )).size, 2)
})

test("Plugin drafts evolve immediately but only a Human-approved Swarm Revision changes the active pin", async (t) => {
  const { root, swarm, ledger, definition, adapter, pluginGit, pluginWorkspaces } = await createFixture(t)
  const runtimeState = join(root, "plugin-state")
  const runtimes = new PluginRuntimeHost({ swarm, workspaces: pluginWorkspaces, stateRoot: runtimeState })
  await runtimes.start()
  swarm.setRevisionActivator((next) => runtimes.activate(next))
  const v1 = definition.plugins[0]!.commit

  const edit = async (version: string) => {
    const input = swarm.appendInput(userMessage("builder", `update Chat to ${version}`, {
      command: "improve-plugin",
      pluginId: "chat",
      version,
    }))
    return swarm.runAgentTurn({ agentId: "builder", inputEventIds: [input.id] })
  }

  const v2Turn = await edit("chat:v2")
  const v2 = v2Turn.pluginWorkspaceCommits.chat!.commit
  const v3Turn = await edit("chat:v3")
  const v3 = v3Turn.pluginWorkspaceCommits.chat!.commit

  assert.notEqual(v2, v1)
  assert.notEqual(v3, v2)
  assert.equal(swarm.activeRevision().definition.plugins[0]!.commit, v1)
  assert.equal(await swarm.pluginDraftHead("chat"), v3)
  assert.equal(adapter.runs.at(-1)?.pluginWorkspaces[0]?.activeCommit, v1)
  assert.equal(adapter.runs.at(-1)?.pluginWorkspaces[0]?.draftCommit, v2)
  assert.match(await pluginGit.read("chat", v3, "runtime.mjs"), /chat:v3/)

  const proposedDefinition = structuredClone(definition)
  proposedDefinition.plugins[0]!.commit = v3
  const proposal = await proposeFromAgent(swarm, {
    definition: proposedDefinition,
  })
  assert.deepEqual(proposal.pluginCommits.chat?.map((item) => item.commit), [v2, v3])

  const fork = swarm.createFork(proposal.id, "owner")
  const forkRunStart = adapter.runs.length
  const evaluated = await swarm.runFork(fork.id)
  const forkPlugin = adapter.runs.slice(forkRunStart).find((run) =>
    run.pluginWorkspaces.some((plugin) => plugin.id === "chat"),
  )
  assert.equal(forkPlugin?.pluginWorkspaces[0]?.activeCommit, v3)
  assert.equal(forkPlugin?.commands.find((command) => command.id === "chat")?.env?.CORAL_PLUGIN_MODE, "mock")
  assert.equal(forkPlugin?.pluginWorkspaces[0]?.writable, false)

  const v4 = (await edit("chat:v4")).pluginWorkspaceCommits.chat!.commit
  const revision = await swarm.approve(fork.id, evaluated.frontier, "owner")

  assert.equal(revision.definition.plugins[0]!.commit, v3)
  assert.equal(swarm.activeRevision().definition.plugins[0]!.commit, v3)
  assert.equal(await swarm.pluginDraftHead("chat"), v4)
  assert.equal(await readFile(join(runtimeState, "chat", "active-version.txt"), "utf8"), "chat:v3")
  const activation = ledger.all().findLast((event) => event.type === "swarm.revision.activated")
  assert.equal(
    (activation?.data as { revision: { definition: typeof definition } }).revision.definition.plugins[0]!.commit,
    v3,
  )

  const nextDefinition = structuredClone(revision.definition)
  nextDefinition.plugins[0]!.commit = v4
  const nextProposal = await proposeFromAgent(swarm, {
    definition: nextDefinition,
  })
  assert.deepEqual(nextProposal.pluginCommits.chat?.map((item) => item.commit), [v4])

  await edit("chat:v5")
  assert.equal(adapter.runs.at(-1)?.pluginWorkspaces[0]?.activeCommit, v3)
  assert.equal(adapter.runs.at(-1)?.pluginWorkspaces[0]?.draftCommit, v4)
  await runtimes.stop()
})

test("concurrent Plugin edits accept only the Git CAS winner", async (t) => {
  const { swarm, ledger, adapter } = await createFixture(t, { pluginAgents: ["builder", "reviewer"] })
  const releaseBuilder = adapter.blockNext("builder")
  const releaseReviewer = adapter.blockNext("reviewer")
  const edit = (agentId: string, version: string) => {
    const input = swarm.appendInput(userMessage(agentId, version, {
      command: "improve-plugin",
      pluginId: "chat",
      version,
    }))
    return swarm.runAgentTurn({ agentId, inputEventIds: [input.id] })
  }

  const builder = edit("builder", "chat:builder")
  const reviewer = edit("reviewer", "chat:reviewer")
  await waitFor(() => adapter.runs.length === 2)
  releaseBuilder()
  const accepted = await builder
  releaseReviewer()
  const rejected = await reviewer

  const failure = rejected.turnEvent.data as { outcome: string; failure?: string; trajectory?: unknown }
  assert.equal(await swarm.pluginDraftHead("chat"), accepted.pluginWorkspaceCommits.chat!.commit)
  assert.deepEqual(rejected.pluginWorkspaceCommits, {})
  assert.deepEqual(rejected.actions, [])
  assert.equal(rejected.checkpoint, null)
  assert.equal(failure.outcome, "failed")
  assert.ok(failure.trajectory)
  assert.match(failure.failure ?? "", /Plugin draft changed during Agent turn/)
  assert.equal(ledger.all().filter((event) => event.type === "plugin.workspace.committed").length, 1)
})

test("a Revision snapshots Agent commits and Forks can start from any Revision or Proposal", async (t) => {
  const { swarm, ledger, definition, revision } = await createFixture(t)
  for (const request of ["improve context", "improve memory"]) {
    const input = swarm.appendInput(userMessage("builder", request, { command: "improve-agent" }))
    await swarm.runAgentTurn({ agentId: "builder", inputEventIds: [input.id] })
  }
  const reviewInput = swarm.appendInput(userMessage("reviewer", "improve review procedure", {
    command: "improve-agent",
  }))
  await swarm.runAgentTurn({ agentId: "reviewer", inputEventIds: [reviewInput.id] })
  const proposedDefinition = structuredClone(definition)
  proposedDefinition.routes.push({ from: "reviewer", to: "builder" })
  const proposal = await proposeFromAgent(swarm, {
    definition: proposedDefinition,
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
  const proposal = await proposeFromAgent(swarm)
  const fork = swarm.createFork(proposal.id, "owner")
  const forkResult = await swarm.runFork(fork.id)

  const continued = swarm.appendInput(userMessage("builder", "continue evolving while the Proposal is evaluated", {
    command: "continue-main",
  }))
  const tail = await swarm.runAgentTurn({ agentId: "builder", inputEventIds: [continued.id] })
  const oldMainHead = tail.workspaceCommit.commit

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

  const nextProposal = await proposeFromAgent(swarm)
  assert.equal(nextProposal.agentHeads.builder, newMainHead)
  assert.equal(nextProposal.workspaceCommits.builder?.at(-1)?.commit, newMainHead)
})

test("a workspace conflict leaves the old Main intact", async (t) => {
  const { swarm, ledger, revision } = await createFixture(t)
  const proposal = await proposeFromAgent(swarm)
  const fork = swarm.createFork(proposal.id, "owner")
  const forkResult = await swarm.runFork(fork.id)

  const continued = swarm.appendInput(userMessage("builder", "write the same Main workspace file differently", {
    command: "improve-agent",
  }))
  const tail = await swarm.runAgentTurn({ agentId: "builder", inputEventIds: [continued.id] })

  await assert.rejects(swarm.approve(fork.id, forkResult.frontier, "owner"), /Cannot reapply commit for workspace/)
  assert.equal(swarm.activeRevision().id, revision.id)
  assert.equal(swarm.agentHead("builder"), tail.workspaceCommit.commit)
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

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("Timed out waiting for Agent turns")
}
