import { contentId, digest, immutable } from "../canonical.ts"
import type { AgentRuntime, AgentTurnResult } from "../agent/runtime.ts"
import type { EventDraft, Ledger, LedgerEvent, Scope } from "../ledger/ledger.ts"
import { activeScope, forkScope } from "../ledger/ledger.ts"
import type { PluginBinding, SwarmDefinition } from "./definition.ts"
import { findAgent, projectAgentSwarmView, validateDefinition } from "./definition.ts"
import type { ForkSnapshot, ForkSource, MutableFork, SwarmProposal, SwarmRevision } from "./revision.ts"
import {
  assertCompleteHeads,
  collectWorkspaceCommits,
  mergeWorkspaceCommits,
  proposalWorkspaceCommits,
  safeForkBindings,
} from "./revision.ts"

interface Selection {
  proposalId: string
  forkId: string
  eventId: string
}

interface BootstrapInput {
  definition: SwarmDefinition
  agentHeads: Record<string, string>
  human: string
}

interface ProposalInput {
  authoredBy: string
  definition?: SwarmDefinition
  addedAgentHeads?: Record<string, string>
  reasonEventIds: string[]
}

interface AppendInput {
  type: string
  actor: string
  data?: unknown
  schema?: string
}

export class Swarm {
  #revisions = new Map<string, SwarmRevision>()
  #proposals = new Map<string, SwarmProposal>()
  #forks = new Map<string, MutableFork>()
  #candidates = new Map<string, SwarmRevision>()
  #selections = new Map<string, Selection>()
  #agentHeads = new Map<string, string>()
  #activeRevisionId: string | null = null
  #mainOperations: Promise<unknown> = Promise.resolve()

  readonly ledger: Ledger
  readonly agentRuntime: AgentRuntime

  constructor({ ledger, agentRuntime }: { ledger: Ledger; agentRuntime: AgentRuntime }) {
    this.ledger = ledger
    this.agentRuntime = agentRuntime
  }

  async bootstrap({ definition, agentHeads, human }: BootstrapInput): Promise<SwarmRevision> {
    if (this.#activeRevisionId) throw new Error("Swarm is already bootstrapped")
    assertHuman(human)
    const checkedDefinition = validateDefinition(definition)
    assertCompleteHeads(checkedDefinition, agentHeads)
    await Promise.all(
      checkedDefinition.agents.map((agent) => this.agentRuntime.assertWorkspaceCommit(agent.id, agentHeads[agent.id]!, true)),
    )

    const body = {
      parentRevision: null,
      proposalId: null,
      selectedForkId: null,
      definition: checkedDefinition,
      definitionDigest: digest(checkedDefinition),
      agentHeads: { ...agentHeads },
      workspaceCommits: Object.fromEntries(
        checkedDefinition.agents.map((agent) => [
          agent.id,
          [
            {
              commit: agentHeads[agent.id]!,
              eventId: this.agentRuntime.initializationEvent(agent.id, agentHeads[agent.id]!).id,
            },
          ],
        ]),
      ),
      pluginBindings: checkedDefinition.plugins,
      evaluationEventIds: [] as string[],
      ledgerFrontier: this.ledger.head().seq + 1,
    }
    const id = contentId("revision", body)
    const frozen = this.ledger.append({
      type: "swarm.revision.frozen",
      actor: `human/${human}`,
      scope: activeScope(),
      data: { revisionId: id, bootstrap: true },
    })
    const decision = this.ledger.append({
      type: "swarm.decision.recorded",
      actor: `human/${human}`,
      scope: activeScope(),
      causation: [frozen.id],
      data: { candidateRevisionId: id, verdict: "approved" },
    })
    this.ledger.append({
      type: "swarm.revision.activated",
      actor: "swarm/runtime",
      scope: activeScope(),
      causation: [decision.id],
      swarmRevision: id,
      data: { previousRevisionId: null, revisionId: id },
    })

    const revision = immutable<SwarmRevision>({ id, ...body, frozenEventId: frozen.id })
    this.#revisions.set(id, revision)
    this.#activeRevisionId = id
    for (const [agentId, head] of Object.entries(agentHeads)) this.#agentHeads.set(agentId, head)
    return revision
  }

  activeRevision(): SwarmRevision {
    if (!this.#activeRevisionId) throw new Error("Swarm is not bootstrapped")
    return this.#revisions.get(this.#activeRevisionId)!
  }

  agentHead(agentId: string): string {
    const head = this.#agentHeads.get(agentId)
    if (!head) throw new Error(`unknown Agent workspace: ${agentId}`)
    return head
  }

  appendInput({ type, actor, data, schema }: AppendInput): LedgerEvent {
    const revision = this.activeRevision()
    return this.ledger.append({
      type,
      ...(schema ? { schema } : {}),
      actor,
      scope: activeScope(),
      swarmRevision: revision.id,
      data,
    })
  }

  ingest(draft: EventDraft): LedgerEvent {
    let data = structuredClone(draft.data ?? null)
    if (draft.type === "communication.sent" && isPluginCommunication(data)) {
      const channel = this.activeRevision().definition.externalChannels.find(
        (binding) => binding.plugin === data.source.plugin,
      )
      if (!channel) throw new Error(`No external channel for Plugin: ${data.source.plugin}`)
      if (!Array.isArray(data.to) || data.to.length === 0) data.to = [`agent/${channel.ingressTo}`]
    }
    return this.appendInput({
      type: draft.type,
      ...(draft.schema ? { schema: draft.schema } : {}),
      actor: draft.actor,
      data,
    })
  }

  pluginBindingForEgress(pluginId: string, event: LedgerEvent): PluginBinding {
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

  async runAgentTurn(input: { agentId: string; inputEventId: string }): Promise<AgentTurnResult> {
    return this.#withMain(() => this.#runAgentTurn(input))
  }

  async #runAgentTurn({ agentId, inputEventId }: { agentId: string; inputEventId: string }): Promise<AgentTurnResult> {
    const revision = this.activeRevision()
    const agent = findAgent(revision.definition, agentId)
    const input = this.ledger.get(inputEventId)
    if (input.scope.kind !== "active") throw new Error("Agent turn input must be active-scoped")
    const scope = activeScope()
    const result = await this.agentRuntime.runTurn({
      agent,
      baseCommit: this.agentHead(agentId),
      scope,
      inputEvents: [input],
      runtimeContext: {
        swarm: projectAgentSwarmView(
          revision.definition,
          agentId,
          { kind: "revision", id: revision.id },
          scope,
          revision.pluginBindings,
        ),
      },
    })
    this.#agentHeads.set(agentId, result.revision.commit)
    return result
  }

  async propose(input: ProposalInput): Promise<SwarmProposal> {
    return this.#withMain(() => this.#propose(input))
  }

  async #propose({
    authoredBy,
    definition = this.activeRevision().definition,
    addedAgentHeads = {},
    reasonEventIds,
  }: ProposalInput): Promise<SwarmProposal> {
    const base = this.activeRevision()
    findAgent(base.definition, authoredBy)
    if (!Array.isArray(reasonEventIds) || reasonEventIds.length === 0) {
      throw new Error("Proposal requires at least one committed causal Event")
    }
    const checkedDefinition = validateDefinition(definition)
    if (checkedDefinition.tests.length === 0) throw new Error("Proposal requires pinned tests and test inputs")
    const existingAgentIds = new Set(base.definition.agents.map((agent) => agent.id))
    const addedAgentIds = checkedDefinition.agents
      .filter((agent) => !existingAgentIds.has(agent.id))
      .map((agent) => agent.id)
      .sort()
    if (JSON.stringify(Object.keys(addedAgentHeads).sort()) !== JSON.stringify(addedAgentIds)) {
      throw new Error("Initial heads must exactly match the Agents added by the Proposal")
    }
    const heads = Object.fromEntries(
      checkedDefinition.agents.map((agent) => [
        agent.id,
        existingAgentIds.has(agent.id) ? this.agentHead(agent.id) : addedAgentHeads[agent.id]!,
      ]),
    )
    assertCompleteHeads(checkedDefinition, heads)
    await Promise.all(
      checkedDefinition.agents.map((agent) =>
        this.agentRuntime.assertWorkspaceCommit(agent.id, heads[agent.id]!, !existingAgentIds.has(agent.id)),
      ),
    )
    for (const eventId of reasonEventIds) {
      const event = this.ledger.get(eventId)
      if (event.scope.kind !== "active") throw new Error("Proposal reasons must be active-scoped Events")
    }

    const body = {
      baseRevision: base.id,
      authoredBy,
      reasonEventIds: [...reasonEventIds],
      definition: checkedDefinition,
      agentHeads: { ...heads },
      workspaceCommits: proposalWorkspaceCommits(
        base,
        checkedDefinition,
        heads,
        this.ledger.all(),
        base.proposalId ? this.proposal(base.proposalId).ledgerFrontier : base.ledgerFrontier,
      ),
      pluginBindings: checkedDefinition.plugins,
      testDigest: digest(checkedDefinition.tests),
      ledgerFrontier: this.ledger.head().seq + 1,
    }
    const id = contentId("proposal", body)
    if (this.#proposals.has(id)) throw new Error(`Proposal already exists: ${id}`)
    const event = this.ledger.append({
      type: "swarm.revision.proposed",
      actor: `agent/${authoredBy}`,
      scope: activeScope(),
      causation: reasonEventIds,
      swarmRevision: base.id,
      data: {
        proposalId: id,
        baseRevision: base.id,
        definitionDigest: digest(checkedDefinition),
        testDigest: body.testDigest,
        agentHeads: body.agentHeads,
        workspaceCommits: body.workspaceCommits,
      },
    })
    const proposal = immutable<SwarmProposal>({ id, ...body, eventId: event.id })
    this.#proposals.set(id, proposal)
    return proposal
  }

  createFork(sourceId: string): ForkSnapshot {
    const source = this.#forkSource(sourceId)
    const ordinal = [...this.#forks.values()].filter((fork) => fork.sourceId === sourceId).length + 1
    const id = contentId("fork", { sourceId, ordinal })
    const scope = forkScope(id)
    const event = this.ledger.append({
      type: "swarm.fork.created",
      actor: "swarm/runtime",
      scope,
      causation: [source.eventId],
      swarmRevision: source.revisionId,
      data: { forkId: id, sourceKind: source.kind, sourceId, testDigest: source.testDigest },
    })
    const fork: MutableFork = {
      id,
      sourceKind: source.kind,
      sourceId,
      definition: source.definition,
      agentHeads: { ...source.agentHeads },
      pluginBindings: immutable(safeForkBindings(source.pluginBindings)),
      ledgerFrontier: source.ledgerFrontier,
      scope,
      status: "running",
      createdEventId: event.id,
      evaluationEventId: null,
      results: null,
    }
    this.#forks.set(id, fork)
    return snapshotFork(fork)
  }

  async runForks(forkIds: string[]): Promise<ForkSnapshot[]> {
    return Promise.all(forkIds.map((forkId) => this.runFork(forkId)))
  }

  async runFork(forkId: string): Promise<ForkSnapshot> {
    const fork = this.#mutableFork(forkId)
    if (fork.status !== "running") throw new Error(`Fork is not runnable: ${forkId}`)
    const results = []

    for (const test of fork.definition.tests) {
      const startSeq = this.ledger.head().seq
      const inputs = test.inputEvents.map((input) =>
        this.ledger.append({
          type: input.type,
          ...(input.schema ? { schema: input.schema } : {}),
          actor: `test/${test.id}`,
          scope: fork.scope,
          causation: [fork.createdEventId],
          correlation: `${fork.id}/${test.id}`,
          swarmRevision: this.#forkSource(fork.sourceId).revisionId,
          data: input.data ?? null,
        }),
      )
      await this.#drainFork(fork, inputs)
      const matching = this.ledger
        .inScope(fork.scope)
        .filter((event) => event.seq > startSeq && event.type === test.expect.eventType)
      results.push(
        immutable({ testId: test.id, passed: matching.length > 0, evidenceEventIds: matching.map((event) => event.id) }),
      )
    }

    const evaluation = this.ledger.append({
      type: "swarm.fork.evaluated",
      actor: "swarm/runtime",
      scope: fork.scope,
      causation: [fork.createdEventId],
      swarmRevision: this.#forkSource(fork.sourceId).revisionId,
      data: {
        sourceKind: fork.sourceKind,
        sourceId: fork.sourceId,
        forkId: fork.id,
        testDigest: digest(fork.definition.tests),
        agentHeads: fork.agentHeads,
        results,
      },
    })
    fork.status = "completed"
    fork.results = results
    fork.evaluationEventId = evaluation.id
    return snapshotFork(fork)
  }

  selectFork({ proposalId, forkId, selectedBy }: { proposalId: string; forkId: string; selectedBy: string }): Selection {
    const fork = this.#mutableFork(forkId)
    if (fork.sourceKind !== "proposal" || fork.sourceId !== proposalId) {
      throw new Error("Only a Proposal Fork can be selected for a Candidate")
    }
    if (fork.status !== "completed") throw new Error("Fork must be evaluated before selection")
    if (this.#selections.has(proposalId)) throw new Error("Proposal already has a selected Fork")
    const event = this.ledger.append({
      type: "swarm.fork.selected",
      actor: selectedBy,
      scope: activeScope(),
      causation: [fork.evaluationEventId!],
      data: { proposalId, forkId },
    })
    const selection = immutable({ proposalId, forkId, eventId: event.id })
    this.#selections.set(proposalId, selection)
    return selection
  }

  freezeCandidate(proposalId: string): SwarmRevision {
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
      agentHeads: { ...fork.agentHeads },
      workspaceCommits: mergeWorkspaceCommits(
        proposal.workspaceCommits,
        collectWorkspaceCommits(this.ledger.all(), proposal.ledgerFrontier, fork.scope),
      ),
      pluginBindings: proposal.pluginBindings,
      evaluationEventIds: [fork.evaluationEventId!],
      ledgerFrontier: this.ledger.head().seq + 1,
    }
    const id = contentId("revision", body)
    const event = this.ledger.append({
      type: "swarm.revision.frozen",
      actor: "swarm/runtime",
      scope: activeScope(),
      causation: [selection.eventId],
      swarmRevision: proposal.baseRevision,
      data: {
        candidateRevisionId: id,
        proposalId,
        selectedForkId: fork.id,
        definitionDigest: body.definitionDigest,
        agentHeads: fork.agentHeads,
        workspaceCommits: body.workspaceCommits,
      },
    })
    const candidate = immutable<SwarmRevision>({ id, ...body, frozenEventId: event.id })
    this.#candidates.set(id, candidate)
    return candidate
  }

  async approveAndActivate(candidateId: string, human: string): Promise<SwarmRevision> {
    return this.#withMain(() => this.#approveAndActivate(candidateId, human))
  }

  async #approveAndActivate(candidateId: string, human: string): Promise<SwarmRevision> {
    assertHuman(human)
    const candidate = this.#candidates.get(candidateId)
    if (!candidate) throw new Error(`unknown Candidate: ${candidateId}`)
    if (this.#activeRevisionId !== candidate.parentRevision) {
      throw new Error("Candidate is stale: active revision no longer matches its base")
    }
    const proposal = this.proposal(candidate.proposalId!)
    const selectedFork = this.#mutableFork(candidate.selectedForkId!)
    if (selectedFork.status !== "completed") throw new Error("Selected Fork is not ready for promotion")

    const nextHeads: Record<string, string> = {}
    const reappliedCommits: Record<string, Array<{ sourceCommit: string; appliedCommit: string }>> = {}
    for (const agent of candidate.definition.agents) {
      const candidateHead = candidate.agentHeads[agent.id]!
      const proposalHead = proposal.agentHeads[agent.id]
      const currentHead = this.#agentHeads.get(agent.id)
      if (!currentHead) {
        if (!proposalHead) throw new Error(`Proposal has no workspace head: ${agent.id}`)
        await this.agentRuntime.assertWorkspaceCommit(agent.id, candidateHead)
        nextHeads[agent.id] = candidateHead
        continue
      }
      if (!proposalHead) throw new Error(`Proposal has no workspace head: ${agent.id}`)
      const result = await this.agentRuntime.reapplyWorkspaceTail(
        agent.id,
        proposalHead,
        currentHead,
        candidateHead,
        `activation/${candidate.id}/${agent.id}`,
      )
      nextHeads[agent.id] = result.revision.commit
      if (result.commits.length > 0) reappliedCommits[agent.id] = result.commits
    }

    await Promise.all(
      Object.entries(nextHeads).map(([agentId, head]) =>
        this.agentRuntime.retainWorkspaceHead(agentId, `activation/${candidate.id}`, head),
      ),
    )
    const removedAgentHeads = Object.fromEntries(
      [...this.#agentHeads].filter(([agentId]) => !(agentId in nextHeads)),
    )
    const decision = this.ledger.append({
      type: "swarm.decision.recorded",
      actor: `human/${human}`,
      scope: activeScope(),
      causation: [candidate.frozenEventId],
      data: { candidateRevisionId: candidate.id, verdict: "approved" },
    })
    const reappliedEventIds: string[] = []
    for (const [agentId, commits] of Object.entries(reappliedCommits)) {
      let parentCommit = candidate.agentHeads[agentId]!
      for (const commit of commits) {
        const event = this.ledger.append({
          type: "agent.workspace.reapplied",
          actor: "swarm/runtime",
          scope: activeScope(),
          causation: [decision.id],
          swarmRevision: candidate.id,
          data: {
            agentId,
            sourceCommit: commit.sourceCommit,
            parentCommit,
            commit: commit.appliedCommit,
          },
        })
        reappliedEventIds.push(event.id)
        parentCommit = commit.appliedCommit
      }
    }
    this.ledger.append({
      type: "swarm.revision.activated",
      actor: "swarm/runtime",
      scope: activeScope(),
      causation: [decision.id, ...reappliedEventIds],
      swarmRevision: candidate.id,
      data: {
        previousRevisionId: candidate.parentRevision,
        revisionId: candidate.id,
        promotedForkId: selectedFork.id,
        workspaceHeads: nextHeads,
        reappliedCommits,
        removedAgentHeads,
      },
    })
    this.#revisions.set(candidate.id, candidate)
    this.#candidates.delete(candidate.id)
    this.#activeRevisionId = candidate.id
    this.#agentHeads.clear()
    for (const [agentId, head] of Object.entries(nextHeads)) this.#agentHeads.set(agentId, head)
    selectedFork.status = "promoted"
    return candidate
  }

  proposal(id: string): SwarmProposal {
    const proposal = this.#proposals.get(id)
    if (!proposal) throw new Error(`unknown Proposal: ${id}`)
    return proposal
  }

  fork(id: string): ForkSnapshot {
    return snapshotFork(this.#mutableFork(id))
  }

  eventsVisibleToFork(forkId: string): LedgerEvent[] {
    const fork = this.#mutableFork(forkId)
    return this.ledger.visibleToFork(forkId, fork.ledgerFrontier)
  }

  async #drainFork(fork: MutableFork, initialEvents: LedgerEvent[]): Promise<void> {
    const queue = [...initialEvents]
    let deliveries = 0
    while (queue.length > 0) {
      const event = queue.shift()!
      const routes = fork.definition.routes.filter((route) => route.on === event.type)
      for (const route of routes) {
        deliveries += 1
        if (deliveries > 100) throw new Error("Fork exceeded 100 Agent deliveries")
        const agent = findAgent(fork.definition, route.to)
        const result = await this.agentRuntime.runTurn({
          agent,
          baseCommit: fork.agentHeads[agent.id]!,
          scope: fork.scope,
          inputEvents: [event],
          runtimeContext: {
            swarm: projectAgentSwarmView(
              fork.definition,
              agent.id,
              { kind: fork.sourceKind, id: fork.sourceId },
              fork.scope,
              fork.pluginBindings,
            ),
          },
        })
        fork.agentHeads[agent.id] = result.revision.commit
        queue.push(...result.outputEvents)
        if (result.workspaceEvent) queue.push(result.workspaceEvent)
        queue.push(result.turnEvent)
      }
    }
  }

  #mutableFork(id: string): MutableFork {
    const fork = this.#forks.get(id)
    if (!fork) throw new Error(`unknown Fork: ${id}`)
    return fork
  }

  #forkSource(id: string): ForkSource {
    const proposal = this.#proposals.get(id)
    if (proposal) {
      return {
        kind: "proposal",
        eventId: proposal.eventId,
        revisionId: proposal.baseRevision,
        definition: proposal.definition,
        agentHeads: proposal.agentHeads,
        pluginBindings: proposal.pluginBindings,
        testDigest: proposal.testDigest,
        ledgerFrontier: proposal.ledgerFrontier,
      }
    }
    const revision = this.#revisions.get(id) ?? this.#candidates.get(id)
    if (revision) {
      return {
        kind: "revision",
        eventId: revision.frozenEventId,
        revisionId: revision.id,
        definition: revision.definition,
        agentHeads: revision.agentHeads,
        pluginBindings: revision.pluginBindings,
        testDigest: digest(revision.definition.tests),
        ledgerFrontier: revision.ledgerFrontier,
      }
    }
    throw new Error(`unknown Fork source: ${id}`)
  }

  #withMain<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.#mainOperations.then(operation, operation)
    this.#mainOperations = current.then(
      () => undefined,
      () => undefined,
    )
    return current
  }
}

function snapshotFork(fork: MutableFork): ForkSnapshot {
  return immutable({
    id: fork.id,
    sourceKind: fork.sourceKind,
    sourceId: fork.sourceId,
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

function assertHuman(human: string): void {
  if (typeof human !== "string" || human.trim() === "" || human.startsWith("agent/")) {
    throw new Error("Human principal is required")
  }
}

function isPluginCommunication(data: unknown): data is { source: { plugin: string }; to?: string[] } {
  if (!data || typeof data !== "object") return false
  const candidate = data as { source?: { plugin?: unknown }; to?: unknown }
  return typeof candidate.source?.plugin === "string"
}
