import { contentId, digest, immutable } from "../canonical.ts"
import type { AgentRuntime, AgentTurnResult } from "../agent/runtime.ts"
import type { HarnessPluginCommand, PluginExecutable } from "../../harness/adapter.ts"
import type { EventDraft, Ledger, LedgerEvent } from "../ledger/ledger.ts"
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
  #agentHeads = new Map<string, string>()
  #pluginExecutables = new Map<string, PluginExecutable>()
  #activeRevisionId: string | null = null
  #mainOperations: Promise<unknown> = Promise.resolve()
  #forkOperations = new Map<string, Promise<unknown>>()

  readonly ledger: Ledger
  readonly agentRuntime: AgentRuntime

  constructor({
    ledger,
    agentRuntime,
    pluginExecutables = [],
  }: {
    ledger: Ledger
    agentRuntime: AgentRuntime
    pluginExecutables?: PluginExecutable[]
  }) {
    this.ledger = ledger
    this.agentRuntime = agentRuntime
    this.#pluginExecutables = new Map(pluginExecutables.map((plugin) => [plugin.id, plugin]))
  }

  async bootstrap({ definition, agentHeads, human }: BootstrapInput): Promise<SwarmRevision> {
    if (this.#activeRevisionId) throw new Error("Swarm is already bootstrapped")
    assertHuman(human)
    const checkedDefinition = validateDefinition(definition)
    this.#assertPluginExecutables(checkedDefinition)
    assertCompleteHeads(checkedDefinition, agentHeads)
    await Promise.all(
      checkedDefinition.agents.map((agent) => this.agentRuntime.assertWorkspaceCommit(agent.id, agentHeads[agent.id]!, true)),
    )

    const body = {
      parentRevision: null,
      sourceProposalId: null,
      sourceForkId: null,
      definition: checkedDefinition,
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
      ledgerFrontier: this.ledger.head().seq + 1,
    }
    const id = contentId("revision", body)
    const decision = this.ledger.append({
      type: "swarm.decision.recorded",
      actor: `human/${human}`,
      scope: activeScope(),
      data: { verdict: "approved", revisionId: id, bootstrap: true },
    })
    const activated = this.ledger.append({
      type: "swarm.revision.activated",
      actor: "swarm/runtime",
      scope: activeScope(),
      causation: [decision.id],
      swarmRevision: id,
      data: { previousRevisionId: null, revision: { id, ...body }, workspaceHeads: agentHeads },
    })

    const revision = immutable<SwarmRevision>({ id, ...body, eventId: activated.id })
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
    return this.ledger.append({
      ...draft,
      scope: activeScope(),
      swarmRevision: this.activeRevision().id,
      data,
    })
  }

  pluginBindingForEgress(pluginId: string, event: LedgerEvent): PluginBinding {
    if (event.scope.kind !== "active") throw new Error("Fork Events cannot use live external egress")
    const revision = this.activeRevision()
    const plugin = revision.definition.plugins.find((binding) => binding.id === pluginId)
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

  async dispatch(inputEventId: string): Promise<AgentTurnResult[]> {
    return this.#withMain(() => this.#dispatch(inputEventId))
  }

  async #dispatch(inputEventId: string): Promise<AgentTurnResult[]> {
    const input = this.ledger.get(inputEventId)
    if (input.scope.kind !== "active") throw new Error("Main dispatch requires an active-scoped Event")
    const queue = [input]
    const turns: AgentTurnResult[] = []
    while (queue.length > 0) {
      const event = queue.shift()!
      for (const agentId of communicationTargets(this.activeRevision().definition, event)) {
        if (turns.length >= 100) throw new Error("Main exceeded 100 Agent deliveries")
        const result = await this.#runAgentTurn({ agentId, inputEventId: event.id })
        turns.push(result)
        queue.push(...result.outputEvents)
      }
    }
    return turns
  }

  async #runAgentTurn({ agentId, inputEventId }: { agentId: string; inputEventId: string }): Promise<AgentTurnResult> {
    const revision = this.activeRevision()
    const agent = findAgent(revision.definition, agentId)
    const input = this.ledger.get(inputEventId)
    if (input.scope.kind !== "active") throw new Error("Agent turn input must be active-scoped")
    if (input.type === "communication.sent" && !communicationTargets(revision.definition, input).includes(agentId)) {
      throw new Error(`Communication is not addressed to Agent: ${agentId}`)
    }
    const scope = activeScope()
    const result = await this.agentRuntime.runTurn({
      agent,
      baseCommit: this.agentHead(agentId),
      scope,
      inputEvents: [input],
      workspaceHeads: Object.fromEntries(this.#agentHeads),
      pluginCommands: this.#commandsFor(revision.definition.plugins, agentId),
      runtimeContext: {
        swarm: projectAgentSwarmView(
          revision.definition,
          agentId,
          { kind: "revision", id: revision.id },
          scope,
          revision.definition.plugins,
        ),
      },
    })
    this.#agentHeads.set(agentId, result.revision.commit)
    for (const event of result.outputEvents) {
      if (event.type !== "swarm.revision.requested") continue
      const request = revisionRequest(event.data)
      await this.#propose({
        authoredBy: agentId,
        definition: request.definition,
        addedAgentHeads: request.addedAgentHeads,
        reasonEventIds: [event.id],
      })
    }
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
    this.#assertPluginExecutables(checkedDefinition)
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
        base.ledgerFrontier,
      ),
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
        authoredBy,
        reasonEventIds,
        definition: checkedDefinition,
        agentHeads: body.agentHeads,
        workspaceCommits: body.workspaceCommits,
        ledgerFrontier: body.ledgerFrontier,
      },
    })
    const proposal = immutable<SwarmProposal>({ id, ...body, eventId: event.id })
    this.#proposals.set(id, proposal)
    return proposal
  }

  createFork(sourceId: string, human: string): ForkSnapshot {
    assertHuman(human)
    const source = this.#forkSource(sourceId)
    const ordinal = [...this.#forks.values()].filter((fork) => fork.sourceId === sourceId).length + 1
    const id = contentId("fork", { sourceId, ordinal })
    const scope = forkScope(id)
    const event = this.ledger.append({
      type: "swarm.fork.created",
      actor: `human/${human}`,
      scope,
      causation: [source.eventId],
      swarmRevision: source.revisionId,
      data: {
        forkId: id,
        sourceKind: source.kind,
        sourceId,
        definition: source.definition,
        agentHeads: source.agentHeads,
        sourceFrontier: source.ledgerFrontier,
      },
    })
    const fork: MutableFork = {
      id,
      sourceKind: source.kind,
      sourceId,
      definition: source.definition,
      agentHeads: { ...source.agentHeads },
      pluginBindings: immutable(safeForkBindings(source.definition.plugins)),
      sourceFrontier: source.ledgerFrontier,
      scope,
      status: "open",
      frontier: event.seq,
      createdEventId: event.id,
    }
    this.#forks.set(id, fork)
    return snapshotFork(fork)
  }

  async runForks(forkIds: string[]): Promise<ForkSnapshot[]> {
    return Promise.all(forkIds.map((forkId) => this.runFork(forkId)))
  }

  async runFork(forkId: string): Promise<ForkSnapshot> {
    return this.#withFork(forkId, () => this.#runFork(forkId))
  }

  async #runFork(forkId: string): Promise<ForkSnapshot> {
    const fork = this.#mutableFork(forkId)
    if (fork.status !== "open") throw new Error(`Fork is not open: ${forkId}`)

    for (const test of fork.definition.tests) {
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
    }
    fork.frontier = this.#forkFrontier(fork.id)
    return snapshotFork(fork)
  }

  async approve(forkId: string, expectedFrontier: number, human: string): Promise<SwarmRevision> {
    return this.#withMain(() => this.#withFork(forkId, () => this.#approve(forkId, expectedFrontier, human)))
  }

  async #approve(forkId: string, expectedFrontier: number, human: string): Promise<SwarmRevision> {
    assertHuman(human)
    const fork = this.#mutableFork(forkId)
    if (fork.status !== "open") throw new Error(`Fork is not open: ${forkId}`)
    this.#assertForkFrontier(fork, expectedFrontier)
    const source = this.#forkSource(fork.sourceId)

    const nextHeads: Record<string, string> = {}
    const reappliedCommits: Record<string, Array<{ sourceCommit: string; appliedCommit: string }>> = {}
    for (const agent of fork.definition.agents) {
      const forkHead = fork.agentHeads[agent.id]!
      const sourceHead = source.agentHeads[agent.id]
      const currentHead = this.#agentHeads.get(agent.id)
      if (!currentHead) {
        await this.agentRuntime.assertWorkspaceCommit(agent.id, forkHead)
        nextHeads[agent.id] = forkHead
        continue
      }
      if (!sourceHead) throw new Error(`Fork source has no workspace head: ${agent.id}`)
      const result = await this.agentRuntime.reapplyWorkspaceTail(
        agent.id,
        sourceHead,
        currentHead,
        forkHead,
        `approval/${fork.id}/${agent.id}`,
      )
      nextHeads[agent.id] = result.revision.commit
      if (result.commits.length > 0) reappliedCommits[agent.id] = result.commits
    }

    const body = {
      parentRevision: source.kind === "proposal" ? source.revisionId : source.id,
      sourceProposalId: source.kind === "proposal" ? source.id : null,
      sourceForkId: fork.id,
      definition: fork.definition,
      agentHeads: { ...fork.agentHeads },
      workspaceCommits: mergeWorkspaceCommits(
        source.workspaceCommits,
        collectWorkspaceCommits(this.ledger.all(), source.ledgerFrontier, fork.scope),
      ),
      ledgerFrontier: this.ledger.head().seq + 1,
    }
    const id = contentId("revision", body)
    await Promise.all(
      Object.entries(nextHeads).map(([agentId, head]) =>
        this.agentRuntime.retainWorkspaceHead(agentId, `activation/${id}`, head),
      ),
    )
    const removedAgentHeads = Object.fromEntries(
      [...this.#agentHeads].filter(([agentId]) => !(agentId in nextHeads)),
    )
    const decision = this.ledger.append({
      type: "swarm.decision.recorded",
      actor: `human/${human}`,
      scope: activeScope(),
      causation: [this.#lastForkEvent(fork.id).id],
      data: {
        verdict: "approved",
        forkId: fork.id,
        forkFrontier: expectedFrontier,
        revisionId: id,
        agentHeads: fork.agentHeads,
        definitionDigest: digest(fork.definition),
      },
    })
    const reappliedEventIds: string[] = []
    for (const [agentId, commits] of Object.entries(reappliedCommits)) {
      let parentCommit = fork.agentHeads[agentId]!
      for (const commit of commits) {
        const event = this.ledger.append({
          type: "agent.workspace.reapplied",
          actor: "swarm/runtime",
          scope: activeScope(),
          causation: [decision.id],
          swarmRevision: id,
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
    const activated = this.ledger.append({
      type: "swarm.revision.activated",
      actor: "swarm/runtime",
      scope: activeScope(),
      causation: [decision.id, ...reappliedEventIds],
      swarmRevision: id,
      data: {
        previousRevisionId: this.activeRevision().id,
        revision: { id, ...body },
        workspaceHeads: nextHeads,
        removedAgentHeads,
      },
    })
    const revision = immutable<SwarmRevision>({ id, ...body, eventId: activated.id })
    this.#revisions.set(id, revision)
    this.#activeRevisionId = id
    this.#agentHeads.clear()
    for (const [agentId, head] of Object.entries(nextHeads)) this.#agentHeads.set(agentId, head)
    fork.status = "approved"
    return revision
  }

  async deny(forkId: string, expectedFrontier: number, human: string, reason?: string): Promise<LedgerEvent> {
    return this.#withFork(forkId, async () => this.#deny(forkId, expectedFrontier, human, reason))
  }

  #deny(forkId: string, expectedFrontier: number, human: string, reason?: string): LedgerEvent {
    assertHuman(human)
    const fork = this.#mutableFork(forkId)
    if (fork.status !== "open") throw new Error(`Fork is not open: ${forkId}`)
    this.#assertForkFrontier(fork, expectedFrontier)
    const event = this.ledger.append({
      type: "swarm.decision.recorded",
      actor: `human/${human}`,
      scope: activeScope(),
      causation: [this.#lastForkEvent(fork.id).id],
      data: {
        verdict: "denied",
        forkId: fork.id,
        forkFrontier: expectedFrontier,
        sourceKind: fork.sourceKind,
        sourceId: fork.sourceId,
        agentHeads: fork.agentHeads,
        definitionDigest: digest(fork.definition),
        ...(reason ? { reason } : {}),
      },
    })
    fork.status = "denied"
    return event
  }

  proposal(id: string): SwarmProposal {
    const proposal = this.#proposals.get(id)
    if (!proposal) throw new Error(`unknown Proposal: ${id}`)
    return proposal
  }

  fork(id: string): ForkSnapshot {
    const fork = this.#mutableFork(id)
    fork.frontier = this.#forkFrontier(id)
    return snapshotFork(fork)
  }

  eventsVisibleToFork(forkId: string): LedgerEvent[] {
    const fork = this.#mutableFork(forkId)
    return this.ledger.visibleToFork(forkId, fork.sourceFrontier)
  }

  async #drainFork(fork: MutableFork, initialEvents: LedgerEvent[]): Promise<void> {
    const queue = [...initialEvents]
    let deliveries = 0
    while (queue.length > 0) {
      const event = queue.shift()!
      for (const agentId of communicationTargets(fork.definition, event)) {
        deliveries += 1
        if (deliveries > 100) throw new Error("Fork exceeded 100 Agent deliveries")
        const agent = findAgent(fork.definition, agentId)
        const result = await this.agentRuntime.runTurn({
          agent,
          baseCommit: fork.agentHeads[agent.id]!,
          scope: fork.scope,
          inputEvents: [event],
          workspaceHeads: { ...fork.agentHeads },
          pluginCommands: this.#commandsFor(fork.pluginBindings, agent.id),
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
      }
    }
  }

  #mutableFork(id: string): MutableFork {
    const fork = this.#forks.get(id)
    if (!fork) throw new Error(`unknown Fork: ${id}`)
    return fork
  }

  #forkFrontier(forkId: string): number {
    return this.#lastForkEvent(forkId).seq
  }

  #lastForkEvent(forkId: string): LedgerEvent {
    const event = this.ledger.inScope(forkScope(forkId)).at(-1)
    if (!event) throw new Error(`Fork has no Ledger Events: ${forkId}`)
    return event
  }

  #assertForkFrontier(fork: MutableFork, expected: number): void {
    const current = this.#forkFrontier(fork.id)
    if (!Number.isInteger(expected) || expected !== current) {
      throw new Error(`Fork changed after it was viewed: expected frontier ${expected}, current ${current}`)
    }
    fork.frontier = current
  }

  #forkSource(id: string): ForkSource {
    const proposal = this.#proposals.get(id)
    if (proposal) {
      return {
        kind: "proposal",
        id: proposal.id,
        eventId: proposal.eventId,
        revisionId: proposal.baseRevision,
        definition: proposal.definition,
        agentHeads: proposal.agentHeads,
        workspaceCommits: proposal.workspaceCommits,
        ledgerFrontier: proposal.ledgerFrontier,
      }
    }
    const revision = this.#revisions.get(id)
    if (revision) {
      return {
        kind: "revision",
        id: revision.id,
        eventId: revision.eventId,
        revisionId: revision.id,
        definition: revision.definition,
        agentHeads: revision.agentHeads,
        workspaceCommits: {},
        ledgerFrontier: this.ledger.get(revision.eventId).seq,
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

  #withFork<T>(forkId: string, operation: () => Promise<T>): Promise<T> {
    const pending = this.#forkOperations.get(forkId) ?? Promise.resolve()
    const current = pending.then(operation, operation)
    this.#forkOperations.set(
      forkId,
      current.then(
        () => undefined,
        () => undefined,
      ),
    )
    return current
  }

  #assertPluginExecutables(definition: SwarmDefinition): void {
    for (const plugin of definition.plugins) {
      if (!this.#pluginExecutables.has(plugin.id)) throw new Error(`Plugin executable is not registered: ${plugin.id}`)
    }
  }

  #commandsFor(bindings: PluginBinding[], agentId: string): HarnessPluginCommand[] {
    return bindings
      .filter((binding) => binding.exposedTo.includes(agentId))
      .map((binding) => {
        const executable = this.#pluginExecutables.get(binding.id)
        if (!executable) throw new Error(`Plugin executable is not registered: ${binding.id}`)
        return immutable({
          ...executable,
          command: binding.command,
          mode: binding.mode,
        })
      })
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
    frontier: fork.frontier,
    createdEventId: fork.createdEventId,
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

function communicationTargets(definition: SwarmDefinition, event: LedgerEvent): string[] {
  if (event.type !== "communication.sent") return []
  if (!event.data || typeof event.data !== "object") throw new Error("Communication data is required")
  const data = event.data as { from?: unknown; to?: unknown }
  if (!Array.isArray(data.to)) throw new Error("Communication recipients are required")
  const targets = [...new Set(data.to.filter((recipient): recipient is string => typeof recipient === "string"))]
    .filter((recipient) => recipient.startsWith("agent/"))
    .map((recipient) => recipient.slice("agent/".length))
  for (const target of targets) findAgent(definition, target)

  if (event.actor.startsWith("agent/")) {
    const sender = event.actor.slice("agent/".length)
    if (data.from !== event.actor) throw new Error("Communication sender must match its Agent actor")
    for (const target of targets) {
      if (!definition.routes.some((route) => route.from === sender && route.to === target)) {
        throw new Error(`Communication route is not defined: ${sender} -> ${target}`)
      }
    }
  }
  return targets
}

function revisionRequest(data: unknown): { definition: SwarmDefinition; addedAgentHeads: Record<string, string> } {
  if (!data || typeof data !== "object") throw new Error("Swarm revision request data is required")
  const request = data as { definition?: unknown; addedAgentHeads?: unknown }
  if (request.addedAgentHeads !== undefined && (!request.addedAgentHeads || typeof request.addedAgentHeads !== "object")) {
    throw new Error("Swarm revision request addedAgentHeads must be an object")
  }
  return {
    definition: validateDefinition(request.definition),
    addedAgentHeads: (request.addedAgentHeads ?? {}) as Record<string, string>,
  }
}
