import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  activeScope,
  deploySnapshot,
  Ledger,
  openDeployment,
  SnapshotStore,
  Swarm,
} from "../src/index.ts"
import { projectSwarmState } from "../src/core/swarm/state.ts"
import { createFixture, proposeFromAgent, userMessage } from "../test-support/fixture.ts"

test("a file Ledger reopens and continues its verified hash chain", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "coral-ledger-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, "ledger.jsonl")
  const first = Ledger.create(path)
  first.append({ type: "first", actor: "test", scope: activeScope() })
  first.close()

  const second = Ledger.open(path)
  const event = second.append({ type: "second", actor: "test", scope: activeScope() })
  assert.equal(event.seq, 2)
  assert.equal(second.verify(), true)
  second.close()

  const third = Ledger.open(path)
  assert.deepEqual(third.all().map((item) => item.type), ["first", "second"])
  assert.equal(third.verify(), true)
  third.close()

  const source = await readFile(path, "utf8")
  await writeFile(path, source.replace('"actor":"test"', '"actor":"tampered"'))
  assert.throws(() => Ledger.open(path), /verification failed/)
})

test("Swarm state projects workspace heads, checkpoints, Proposals, and Forks", async (t) => {
  const { swarm, ledger, agentRuntime, adapter } = await createFixture(t)
  const input = swarm.appendInput(userMessage("builder", "improve", { command: "improve-agent" }))
  await swarm.runAgentTurn({ agentId: "builder", inputEventIds: [input.id] })
  const proposal = await proposeFromAgent(swarm)
  const fork = swarm.createFork(proposal.id, "owner")
  const evaluated = await swarm.runFork(fork.id)
  await swarm.approve(fork.id, evaluated.frontier, "owner")

  const restored = new Swarm({ ledger, agentRuntime, state: projectSwarmState(ledger.all()) })
  assert.equal(restored.activeRevision().id, swarm.activeRevision().id)
  assert.equal(restored.agentHead("builder"), swarm.agentHead("builder"))
  assert.equal(restored.proposal(proposal.id).id, proposal.id)
  assert.equal(restored.fork(fork.id).status, "approved")

  const followup = restored.appendInput(userMessage("builder", "continue"))
  await restored.runAgentTurn({ agentId: "builder", inputEventIds: [followup.id] })
  assert.equal(adapter.runs.at(-1)?.forkSession, true)
})

test("a stopped deployment reopens the same Instance and rejects concurrent runtimes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "coral-instance-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const options = {
    instanceRoot: root,
    human: "owner",
    adapters: [],
    pluginEnvironments: { screen: { CORAL_SCREEN_DISABLED: "1" } },
  }
  const first = await deploySnapshot({
    ...options,
    snapshots: new SnapshotStore(join(process.cwd(), "snapshots")),
    name: "personal-agent",
  })
  const revisionId = first.swarm.activeRevision().id
  const head = first.swarm.agentHead("chat-agent")
  const frontier = first.ledger.head().seq
  await assert.rejects(openDeployment(options), /already running/)
  await first.stop()
  assert.equal(existsSync(join(root, "runtime.lock")), false)

  const second = await openDeployment(options)
  assert.equal(second.swarm.activeRevision().id, revisionId)
  assert.equal(second.swarm.agentHead("chat-agent"), head)
  assert.equal(second.ledger.head().seq, frontier)
  const next = second.swarm.appendInput(userMessage("chat-agent", "hello again"))
  assert.equal(next.seq, frontier + 1)
  await second.stop()

  const ledger = Ledger.open(join(root, "ledger.jsonl"))
  assert.equal(ledger.head().seq, frontier + 1)
  ledger.close()
})

test("a failed Plugin activation tears down the accepted Revision deployment", async (t) => {
  const fixture = await createFixture(t)
  const snapshots = new SnapshotStore(join(fixture.root, "failure-snapshots"))
  await snapshots.export("failure", {
    definition: fixture.revision.definition,
    agentHeads: fixture.revision.agentHeads,
    workspaces: fixture.workspaces,
    pluginWorkspaces: fixture.pluginGit,
    sourceRevisionId: fixture.revision.id,
  })
  const instanceRoot = join(fixture.root, "failure-instance")
  const deployment = await deploySnapshot({
    snapshots,
    name: "failure",
    instanceRoot,
    human: "owner",
    adapters: [fixture.adapter],
  })
  t.after(() => deployment.stop())

  const edit = deployment.swarm.appendInput(userMessage("builder", "break Chat", {
    command: "improve-plugin",
    pluginId: "chat",
    version: "chat:fail",
  }))
  const failedCommit = (await deployment.swarm.runAgentTurn({
    agentId: "builder",
    inputEventIds: [edit.id],
  })).pluginWorkspaceCommits.chat!.commit
  const definition = structuredClone(deployment.swarm.activeRevision().definition)
  definition.plugins[0]!.commit = failedCommit
  const proposal = await proposeFromAgent(deployment.swarm, { definition })
  const fork = deployment.swarm.createFork(proposal.id, "owner")
  const evaluated = await deployment.swarm.runFork(fork.id)

  await assert.rejects(deployment.swarm.approve(fork.id, evaluated.frontier, "owner"), /Plugin runtime failed/)
  await deployment.closed
  assert.equal(existsSync(join(instanceRoot, "runtime.lock")), false)
  assert.throws(() => deployment.swarm.appendInput(userMessage("builder", "continue")), /Swarm is terminated/)
  const activation = deployment.ledger.all().findLast((event) => event.type === "swarm.revision.activated")
  assert.equal(
    (activation?.data as { revision: { definition: typeof definition } }).revision.definition.plugins[0]!.commit,
    failedCommit,
  )
})
