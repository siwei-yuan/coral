import { contentId, digest, immutable } from "./canonical.js"
import { activeScope, forkScope } from "./ledger.js"

export class Swarm {
  #revisions = new Map()
  #proposals = new Map()
  #forks = new Map()
  #candidates = new Map()
  #selections = new Map()
  #draftHeads = new Map()
  #activeRevisionId = null

  constructor({ ledger, agentRuntime, workspaces }) {
    this.ledger = ledger
    this.agentRuntime = agentRuntime
    this.workspaces = workspaces
  }

  bootstrap({ definition, agentHeads, human }) {
    if (this.#activeRevisionId) throw new Error("Swarm is already bootstrapped")
    assertHuman(human)
    const checkedDefinition = validateDefinition(definition)
    assertCompleteHeads(checkedDefinition, agentHeads)

    const body = {
      parentRevision: null,
      proposalId: null,
      selectedForkId: null,
      definition: checkedDefinition,
      definitionDigest: digest(checkedDefinition),
      agents: releaseAgents(checkedDefinition, agentHeads),
      pluginBindings: checkedDefinition.plugins,
      evaluationEventIds: [],
    }
    const revision = immutable({ id: contentId("revision", body), ...body })
    const frozen = this.ledger.append({
      type: "swarm.revision.frozen",
      actor: `human/${human}`,
      scope: activeScope(),
      data: { revisionId: revision.id, bootstrap: true },
    })
    const decision = this.ledger.append({
      type: "swarm.decision.recorded",
      actor: `human/${human}`,
      scope: activeScope(),
      causation: [frozen.id],
      data: { candidateRevisionId: revision.id, verdict: "approved" },
    })
    this.ledger.append({
      type: "swarm.revision.activated",
      actor: "swarm/runtime",
      scope: activeScope(),
      causation: [decision.id],
      swarmRevision: revision.id,
      data: { previousRevisionId: null, revisionId: revision.id },
    })

    this.#revisions.set(revision.id, revision)
    this.#activeRevisionId = revision.id
    for (const [agentId, head] of Object.entries(agentHeads)) this.#draftHeads.set(agentId, head)
    return revision
  }

  activeRevision() {
    if (!this.#activeRevisionId) throw new Error("Swarm is not bootstrapped")
    return this.#revisions.get(this.#activeRevisionId)
  }

  draftHead(agentId) {
    const head = this.#draftHeads.get(agentId)
    if (!head) throw new Error(`unknown Agent draft: ${agentId}`)
    return head
  }

  appendInput({ type, actor, data, schema }) {
    const revision = this.activeRevision()
    return this.ledger.append({
      type,
      schema,
      actor,
      scope: activeScope(),
      swarmRevision: revision.id,
      data,
    })
  }

  ingest(draft) {
    let data = structuredClone(draft.data ?? null)
    if (draft.type === "communication.sent" && data?.source?.plugin) {
      const channel = this.activeRevision().definition.externalChannels.find(
        (binding) => binding.plugin === data.source.plugin,
      )
      if (!channel) throw new Error(`No external channel for Plugin: ${data.source.plugin}`)
      if (!Array.isArray(data.to) || data.to.length === 0) data.to = [`agent/${channel.ingressTo}`]
    }
    return this.appendInput({ ...draft, data })
  }

  pluginBindingForEgress(pluginId, event) {
    if (event.scope.kind !== "active") throw new Error("Fork Events cannot use live external egress")
    const revision = this.activeRevision()
    const plugin = revision.pluginBindings.find((binding) => binding.id === pluginId)
    if (!plugin || plugin.mode !== "live") throw new Error(`Plugin is not live: ${pluginId}`)
    const channel = revision.definition.externalChannels.find((binding) => binding.plugin === pluginId)
    const agentId = event.actor.startsWith("agent/") ? event.actor.slice("agent/".length) : null
    if (!channel || !agentId || !channel.egressFrom.includes(agentId)) {
      throw new Error("Event actor is not an external-facing Agent")
    }
    return plugin
  }

  async runDevelopmentTurn({ agentId, inputEventId }) {
    const revision = this.activeRevision()
    const agent = findAgent(revision.definition, agentId)
    const input = this.ledger.get(inputEventId)
    if (input.scope.kind !== "active") throw new Error("Development turn input must be active-scoped")
    const result = await this.agentRuntime.runTurn({
      agent,
      baseCommit: this.draftHead(agentId),
      scope: activeScope(),
      inputEvents: [input],
    })
    this.#draftHeads.set(agentId, result.revision.commit)
    await this.workspaces.retain(agentId, `draft/${agentId}`, result.revision.commit)
    return result
  }

  propose({ authoredBy, definition = this.activeRevision().definition, agentHeads, reasonEventIds }) {
    const base = this.activeRevision()
    findAgent(base.definition, authoredBy)
    if (!Array.isArray(reasonEventIds) || reasonEventIds.length === 0) {
      throw new Error("Proposal requires at least one committed causal Event")
    }
    const checkedDefinition = validateDefinition(definition)
    if (checkedDefinition.tests.length === 0) throw new Error("Proposal requires pinned tests and test inputs")
    const heads = agentHeads ?? Object.fromEntries(this.#draftHeads)
    assertCompleteHeads(checkedDefinition, heads)
    for (const eventId of reasonEventIds) {
      const event = this.ledger.get(eventId)
      if (event.scope.kind !== "active") throw new Error("Proposal reasons must be active-scoped Events")
    }

    const body = {
      baseRevision: base.id,
      authoredBy,
      reasonEventIds: [...reasonEventIds],
      definition: checkedDefinition,
      initialAgentHeads: { ...heads },
      pluginBindings: checkedDefinition.plugins,
      testDigest: digest(checkedDefinition.tests),
      ledgerFrontier: this.ledger.head().seq + 1,
    }
    const proposal = immutable({ id: contentId("proposal", body), ...body })
    if (this.#proposals.has(proposal.id)) throw new Error(`Proposal already exists: ${proposal.id}`)
    const event = this.ledger.append({
      type: "swarm.revision.proposed",
      actor: `agent/${authoredBy}`,
      scope: activeScope(),
      causation: reasonEventIds,
      swarmRevision: base.id,
      data: {
        proposalId: proposal.id,
        baseRevision: base.id,
        definitionDigest: digest(checkedDefinition),
        testDigest: proposal.testDigest,
        initialAgentHeads: proposal.initialAgentHeads,
      },
    })
    const stored = immutable({ ...proposal, eventId: event.id })
    this.#proposals.set(stored.id, stored)
    return stored
  }

  createFork(proposalId) {
    const proposal = this.proposal(proposalId)
    const ordinal = [...this.#forks.values()].filter((fork) => fork.proposalId === proposalId).length + 1
    const id = contentId("fork", { proposalId, ordinal })
    const scope = forkScope(id)
    const event = this.ledger.append({
      type: "swarm.fork.created",
      actor: "swarm/runtime",
      scope,
      causation: [proposal.eventId],
      swarmRevision: proposal.baseRevision,
      data: { forkId: id, proposalId, testDigest: proposal.testDigest },
    })
    const fork = {
      id,
      proposalId,
      definition: proposal.definition,
      agentHeads: { ...proposal.initialAgentHeads },
      pluginBindings: safeForkBindings(proposal.pluginBindings),
      scope,
      status: "running",
      createdEventId: event.id,
      evaluationEventId: null,
      results: null,
    }
    this.#forks.set(id, fork)
    return snapshotFork(fork)
  }

  async runForks(forkIds) {
    return Promise.all(forkIds.map((forkId) => this.runFork(forkId)))
  }

  async runFork(forkId) {
    const fork = this.#mutableFork(forkId)
    if (fork.status !== "running") throw new Error(`Fork is not runnable: ${forkId}`)
    const proposal = this.proposal(fork.proposalId)
    const results = []

    for (const test of fork.definition.tests) {
      const startSeq = this.ledger.head().seq
      const inputs = test.inputEvents.map((input) =>
        this.ledger.append({
          type: input.type,
          schema: input.schema,
          actor: `test/${test.id}`,
          scope: fork.scope,
          causation: [fork.createdEventId],
          correlation: `${fork.id}/${test.id}`,
          swarmRevision: proposal.baseRevision,
          data: input.data ?? null,
        }),
      )
      await this.#drainFork(fork, inputs)
      const matching = this.ledger
        .inScope(fork.scope)
        .filter((event) => event.seq > startSeq && event.type === test.expect.eventType)
      results.push(
        immutable({
          testId: test.id,
          passed: matching.length > 0,
          evidenceEventIds: matching.map((event) => event.id),
        }),
      )
    }

    const evaluation = this.ledger.append({
      type: "swarm.fork.evaluated",
      actor: "swarm/runtime",
      scope: fork.scope,
      causation: [fork.createdEventId],
      swarmRevision: proposal.baseRevision,
      data: {
        proposalId: proposal.id,
        forkId: fork.id,
        testDigest: proposal.testDigest,
        agentHeads: fork.agentHeads,
        results,
      },
    })
    fork.status = "completed"
    fork.results = results
    fork.evaluationEventId = evaluation.id
    return snapshotFork(fork)
  }

  selectFork({ proposalId, forkId, selectedBy }) {
    const fork = this.#mutableFork(forkId)
    if (fork.proposalId !== proposalId) throw new Error("Fork does not belong to Proposal")
    if (fork.status !== "completed") throw new Error("Fork must be evaluated before selection")
    if (this.#selections.has(proposalId)) throw new Error("Proposal already has a selected Fork")
    const event = this.ledger.append({
      type: "swarm.fork.selected",
      actor: selectedBy,
      scope: activeScope(),
      causation: [fork.evaluationEventId],
      data: { proposalId, forkId },
    })
    const selection = immutable({ proposalId, forkId, eventId: event.id })
    this.#selections.set(proposalId, selection)
    return selection
  }

  freezeCandidate(proposalId) {
    const proposal = this.proposal(proposalId)
    const selection = this.#selections.get(proposalId)
    if (!selection) throw new Error("Select an evaluated Fork before freezing a Candidate")
    const fork = this.#mutableFork(selection.forkId)
    const body = {
      parentRevision: proposal.baseRevision,
      proposalId,
      selectedForkId: fork.id,
      definition: proposal.definition,
      definitionDigest: digest(proposal.definition),
      agents: releaseAgents(proposal.definition, fork.agentHeads),
      pluginBindings: proposal.pluginBindings,
      evaluationEventIds: [fork.evaluationEventId],
      ledgerFrontier: this.ledger.head().seq + 1,
    }
    const candidate = immutable({ id: contentId("revision", body), ...body })
    const event = this.ledger.append({
      type: "swarm.revision.frozen",
      actor: "swarm/runtime",
      scope: activeScope(),
      causation: [selection.eventId],
      swarmRevision: proposal.baseRevision,
      data: {
        candidateRevisionId: candidate.id,
        proposalId,
        selectedForkId: fork.id,
        definitionDigest: candidate.definitionDigest,
        agentHeads: fork.agentHeads,
      },
    })
    const stored = immutable({ ...candidate, frozenEventId: event.id })
    this.#candidates.set(stored.id, stored)
    return stored
  }

  approveAndActivate(candidateId, human) {
    assertHuman(human)
    const candidate = this.#candidates.get(candidateId)
    if (!candidate) throw new Error(`unknown Candidate: ${candidateId}`)
    if (this.#activeRevisionId !== candidate.parentRevision) {
      throw new Error("Candidate is stale: active revision no longer matches its base")
    }
    const decision = this.ledger.append({
      type: "swarm.decision.recorded",
      actor: `human/${human}`,
      scope: activeScope(),
      causation: [candidate.frozenEventId],
      data: { candidateRevisionId: candidate.id, verdict: "approved" },
    })
    this.ledger.append({
      type: "swarm.revision.activated",
      actor: "swarm/runtime",
      scope: activeScope(),
      causation: [decision.id],
      swarmRevision: candidate.id,
      data: { previousRevisionId: candidate.parentRevision, revisionId: candidate.id },
    })
    this.#revisions.set(candidate.id, candidate)
    this.#activeRevisionId = candidate.id
    for (const [agentId, release] of Object.entries(candidate.agents)) {
      this.#draftHeads.set(agentId, release.workspaceCommit)
    }
    return candidate
  }

  proposal(id) {
    const proposal = this.#proposals.get(id)
    if (!proposal) throw new Error(`unknown Proposal: ${id}`)
    return proposal
  }

  fork(id) {
    return snapshotFork(this.#mutableFork(id))
  }

  eventsVisibleToFork(forkId) {
    const fork = this.#mutableFork(forkId)
    const proposal = this.proposal(fork.proposalId)
    return this.ledger.visibleToFork(forkId, proposal.ledgerFrontier)
  }

  async #drainFork(fork, initialEvents) {
    const queue = [...initialEvents]
    let deliveries = 0
    while (queue.length > 0) {
      const event = queue.shift()
      const routes = fork.definition.routes.filter((route) => route.on === event.type)
      for (const route of routes) {
        deliveries += 1
        if (deliveries > 100) throw new Error("Fork exceeded 100 Agent deliveries")
        const agent = findAgent(fork.definition, route.to)
        const result = await this.agentRuntime.runTurn({
          agent,
          baseCommit: fork.agentHeads[agent.id],
          scope: fork.scope,
          inputEvents: [event],
        })
        fork.agentHeads[agent.id] = result.revision.commit
        await this.workspaces.retain(agent.id, `${fork.id}/${agent.id}`, result.revision.commit)
        queue.push(...result.outputEvents)
        if (result.workspaceEvent) queue.push(result.workspaceEvent)
        queue.push(result.turnEvent)
      }
    }
  }

  #mutableFork(id) {
    const fork = this.#forks.get(id)
    if (!fork) throw new Error(`unknown Fork: ${id}`)
    return fork
  }
}

export function validateDefinition(definition) {
  if (!definition || typeof definition !== "object") throw new Error("Swarm Definition is required")
  const copy = structuredClone({
    agents: definition.agents ?? [],
    routes: definition.routes ?? [],
    externalChannels: definition.externalChannels ?? [],
    plugins: definition.plugins ?? [],
    tests: definition.tests ?? [],
  })
  const ids = new Set()
  for (const agent of copy.agents) {
    if (!agent.id || !agent.harness || typeof agent.role !== "string" || agent.role.trim() === "") {
      throw new Error("Every Agent requires id, harness, and role")
    }
    if (!Array.isArray(agent.context) || agent.context.some((item) => typeof item !== "string")) {
      throw new Error("Every Agent context must be an ordered string array")
    }
    if (ids.has(agent.id)) throw new Error(`duplicate Agent: ${agent.id}`)
    ids.add(agent.id)
  }
  for (const route of copy.routes) {
    if (!route.on || !ids.has(route.to)) throw new Error("Every route requires an Event type and existing Agent")
  }
  for (const channel of copy.externalChannels) {
    if (!channel.plugin || !ids.has(channel.ingressTo)) {
      throw new Error("External channel requires a Plugin and existing ingress Agent")
    }
    if (!Array.isArray(channel.egressFrom) || channel.egressFrom.some((agentId) => !ids.has(agentId))) {
      throw new Error("External channel egress Agents must exist")
    }
  }
  for (const test of copy.tests) {
    if (!test.id || !Array.isArray(test.inputEvents) || test.inputEvents.length === 0) {
      throw new Error("Every Swarm test requires id and input Events")
    }
    if (!test.expect?.eventType) throw new Error("Every Swarm test requires an expected Event type")
  }
  return immutable(copy)
}

function assertCompleteHeads(definition, heads) {
  const expected = definition.agents.map((agent) => agent.id).sort()
  const actual = Object.keys(heads).sort()
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error("Agent heads must exactly match the proposed Swarm Definition")
  }
}

function releaseAgents(definition, heads) {
  return Object.fromEntries(
    definition.agents.map((agent) => [
      agent.id,
      immutable({
        agentId: agent.id,
        harness: agent.harness,
        workspaceCommit: heads[agent.id],
      }),
    ]),
  )
}

function findAgent(definition, agentId) {
  const agent = definition.agents.find((item) => item.id === agentId)
  if (!agent) throw new Error(`unknown Agent: ${agentId}`)
  return agent
}

function safeForkBindings(bindings) {
  return immutable(
    bindings.map((binding) => ({
      ...binding,
      mode: binding.mode === "live" ? "mock" : binding.mode,
    })),
  )
}

function snapshotFork(fork) {
  return immutable({
    id: fork.id,
    proposalId: fork.proposalId,
    definition: fork.definition,
    agentHeads: fork.agentHeads,
    pluginBindings: fork.pluginBindings,
    scope: fork.scope,
    status: fork.status,
    createdEventId: fork.createdEventId,
    evaluationEventId: fork.evaluationEventId,
    results: fork.results,
  })
}

function assertHuman(human) {
  if (typeof human !== "string" || human.trim() === "" || human.startsWith("agent/")) {
    throw new Error("Human principal is required")
  }
}
