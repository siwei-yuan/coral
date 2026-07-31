import { contentId, digest, immutable } from "../canonical.ts"
import type { SendAction } from "../agent/actions.ts"
import type { AgentPluginAccess, AgentRuntime, AgentTurnResult } from "../agent/runtime.ts"
import type { HarnessCheckpoint } from "../../harness/adapter.ts"
import type { EventDraft, Ledger, LedgerEvent } from "../ledger/ledger.ts"
import { activeScope, forkScope } from "../ledger/ledger.ts"
import type { SwarmDefinition } from "./definition.ts"
import { findAgent, projectAgentSwarmView, validateDefinition } from "./definition.ts"
import type { ForkSnapshot, ForkSource, MutableFork, SwarmProposal, SwarmRevision } from "./revision.ts"
import {
  assertCompleteHeads,
  collectWorkspaceCommits,
  mergeWorkspaceCommits,
  proposalPluginCommits,
  proposalWorkspaceCommits,
  safeForkBindings,
} from "./revision.ts"
import type { HarnessState, SwarmState } from "./state.ts"

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
  type: "communication.sent"
  actor: string
  data?: unknown
  schema?: string
}

export type PluginEnvironment = (pluginId: string) => Record<string, string>
export type RevisionActivator = (definition: SwarmDefinition) => Promise<void>

export interface SwarmTurnResult extends AgentTurnResult {
  outputEvents: LedgerEvent[]
}

export interface AgentMailboxStatus {
  agentId: string
  pending: number
  running: boolean
}

export class Swarm {
  #revisions = new Map<string, SwarmRevision>()
  #proposals = new Map<string, SwarmProposal>()
  #forks = new Map<string, MutableFork>()
  #agentHeads = new Map<string, string>()
  readonly #pluginEnvironment: PluginEnvironment
  #mainHarness = new Map<string, HarnessState>()
  #forkHarness = new Map<string, Map<string, HarnessState>>()
  #activeRevisionId: string | null = null
  #pending = new Map<string, string[]>()
  #running = new Map<string, Promise<void>>()
  #failures: unknown[] = []
  #activationBarrier = false
  #activationOperations: Promise<unknown> = Promise.resolve()
  #mainSessionGeneration = 0
  #forkOperations = new Map<string, Promise<unknown>>()
  #revisionActivator: RevisionActivator | null = null
  #terminated = false

  readonly ledger: Ledger
  readonly agentRuntime: AgentRuntime

  constructor({
    ledger,
    agentRuntime,
    pluginEnvironment = () => ({}),
    state,
  }: {
    ledger: Ledger
    agentRuntime: AgentRuntime
    pluginEnvironment?: PluginEnvironment
    state?: SwarmState
  }) {
    this.ledger = ledger
    this.agentRuntime = agentRuntime
    this.#pluginEnvironment = pluginEnvironment
    if (state) this.#restore(state)
  }

  #restore(state: SwarmState): void {
    this.#revisions = new Map(state.revisions.map((revision) => [revision.id, revision]))
    this.#proposals = new Map(state.proposals.map((proposal) => [proposal.id, proposal]))
    this.#forks = new Map(state.forks.map((fork) => [fork.id, { ...fork }]))
    this.#agentHeads = new Map(Object.entries(state.agentHeads))
    this.#mainHarness = new Map(Object.entries(state.mainHarness))
    this.#forkHarness = new Map(Object.entries(state.forkHarness).map(([forkId, harness]) => [
      forkId,
      new Map(Object.entries(harness)),
    ]))
    this.#activeRevisionId = state.activeRevisionId
  }

  async bootstrap({ definition, agentHeads, human }: BootstrapInput): Promise<SwarmRevision> {
    this.#assertRunning()
    if (this.#activeRevisionId) throw new Error("Swarm is already bootstrapped")
    assertHuman(human)
    const checkedDefinition = validateDefinition(definition)
    await this.#assertPluginCommits(checkedDefinition)
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
      pluginCommits: Object.fromEntries(
        checkedDefinition.plugins.map((plugin) => [
          plugin.id,
          [{
            commit: plugin.commit,
            eventId: this.#pluginWorkspaces().commitEvent(plugin.id, plugin.commit).id,
          }],
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
    for (const [agentId, head] of Object.entries(agentHeads)) {
      this.#mainHarness.set(agentId, { checkpoint: null, workspaceCommit: head, forkNext: false })
    }
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

  async pluginDraftHead(pluginId: string): Promise<string> {
    return (await this.#pluginWorkspaces().draftHead(pluginId)).commit
  }

  setRevisionActivator(activator: RevisionActivator): void {
    this.#revisionActivator = activator
  }

  terminate(): void {
    this.#terminated = true
  }

  mailboxes(): AgentMailboxStatus[] {
    return this.activeRevision().definition.agents.map((agent) => ({
      agentId: agent.id,
      pending: this.#pending.get(agent.id)?.length ?? 0,
      running: this.#running.has(agent.id),
    }))
  }

  appendInput({ type, actor, data, schema }: AppendInput): LedgerEvent {
    this.#assertRunning()
    if (type !== "communication.sent") throw new Error("Swarm input must be communication.sent")
    if (actor.startsWith("agent/")) throw new Error("Agent communication must use coral send")
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
    this.#assertRunning()
    if (draft.type !== "communication.sent") throw new Error("Plugin ingress must be communication.sent")
    if (!isPluginCommunication(draft.data)) throw new Error("Plugin ingress must identify its source Plugin")
    if (draft.actor.startsWith("agent/")) throw new Error("Agent communication must use coral send")
    let data = structuredClone(draft.data ?? null)
    if (isPluginCommunication(data)) {
      const targets = this.activeRevision().definition.pluginIngress.filter(
        (binding) => binding.plugin === data.source.plugin,
      ).map((binding) => `agent/${binding.ingressTo}`)
      if (targets.length === 0) throw new Error(`No ingress for Plugin: ${data.source.plugin}`)
      if (!Array.isArray(data.to) || data.to.length === 0) data.to = targets
      else if (data.to.some((recipient) => typeof recipient !== "string" || !targets.includes(recipient))) {
        throw new Error(`Plugin ingress recipient is not allowed: ${data.source.plugin}`)
      }
    }
    return this.ledger.append({
      ...draft,
      scope: activeScope(),
      swarmRevision: this.activeRevision().id,
      data,
    })
  }

  runAgentTurn(input: { agentId: string; inputEventIds: string[] }): Promise<SwarmTurnResult> {
    this.#assertRunning()
    if (this.#activationBarrier || this.#running.has(input.agentId) || this.#pending.get(input.agentId)?.length) {
      throw new Error(`Agent already has scheduled work: ${input.agentId}`)
    }
    const definition = this.activeRevision().definition
    const inputs = input.inputEventIds.map((eventId) => this.ledger.get(eventId))
    for (const event of inputs) {
      if (!communicationTargets(definition, event).includes(input.agentId)) {
        throw new Error(`Communication is not addressed to Agent: ${input.agentId}`)
      }
    }
    return this.#runAgentTurn({ agentId: input.agentId, inputs })
  }

  route(inputEventId: string): void {
    this.#assertRunning()
    const input = this.ledger.get(inputEventId)
    if (input.scope.kind !== "active") throw new Error("Main routing requires an active-scoped Event")
    for (const agentId of communicationTargets(this.activeRevision().definition, input)) {
      const pending = this.#pending.get(agentId) ?? []
      pending.push(input.id)
      this.#pending.set(agentId, pending)
      this.#startAgent(agentId)
    }
  }

  async settled(): Promise<void> {
    while (this.#running.size > 0) await Promise.all(this.#running.values())
    const failure = this.#failures.shift()
    if (failure) throw failure
  }

  #startAgent(agentId: string): void {
    if (this.#terminated || this.#activationBarrier || this.#running.has(agentId) || !this.#pending.get(agentId)?.length) return
    const running = this.#drainAgent(agentId)
      .catch((error) => { this.#failures.push(error) })
      .finally(() => {
        this.#running.delete(agentId)
        this.#startAgent(agentId)
      })
    this.#running.set(agentId, running)
  }

  async #drainAgent(agentId: string): Promise<void> {
    while (!this.#activationBarrier) {
      const pending = this.#pending.get(agentId)
      if (!pending?.length) return
      const agent = findAgent(this.activeRevision().definition, agentId)
      const inputEventIds = agent.turnPolicy === "single-event"
        ? pending.splice(0, 1)
        : pending.splice(0)
      const result = await this.#runAgentTurn({
        agentId,
        inputs: inputEventIds.map((eventId) => this.ledger.get(eventId)),
      })
      for (const event of result.outputEvents) this.route(event.id)
    }
  }

  async #runAgentTurn({ agentId, inputs }: { agentId: string; inputs: LedgerEvent[] }): Promise<SwarmTurnResult> {
    const revision = this.activeRevision()
    const agent = findAgent(revision.definition, agentId)
    if (inputs.length === 0) throw new Error("Agent turn requires input Events")
    for (const input of inputs) {
      if (input.scope.kind !== "active") throw new Error("Agent turn input must be active-scoped")
    }
    const scope = activeScope()
    const proposalPluginFrontier = this.ledger.head().seq
    const baseCommit = this.agentHead(agentId)
    const sessionGeneration = this.#mainSessionGeneration
    const harness = this.#mainHarness.get(agentId) ?? {
      checkpoint: null,
      workspaceCommit: baseCommit,
      forkNext: false,
    }
    const checkpoint = harness.checkpoint?.harness === agent.harness ? harness.checkpoint : null
    const pluginDraftHeads = await this.#pluginDraftHeads(revision.definition)
    const result = await this.agentRuntime.runTurn({
      agent,
      baseCommit,
      scope,
      inputEvents: inputs,
      workspaceHeads: Object.fromEntries(this.#agentHeads),
      pluginAccess: this.#pluginAccess(revision.definition, agentId, true),
      ...(checkpoint ? { checkpoint } : {}),
      forkSession: Boolean(checkpoint) && (harness.forkNext || harness.workspaceCommit !== baseCommit),
      runtimeContext: {
        swarm: projectAgentSwarmView(
          revision.definition,
          agentId,
          { kind: "revision", id: revision.id },
          scope,
          revision.definition.plugins,
          pluginDraftHeads,
        ),
      },
    })
    this.#agentHeads.set(agentId, result.workspaceCommit.commit)
    this.#mainHarness.set(agentId, {
      checkpoint: result.checkpoint,
      workspaceCommit: baseCommit,
      forkNext: result.workspaceCommit.commit !== baseCommit || sessionGeneration !== this.#mainSessionGeneration,
    })
    const outputEvents: LedgerEvent[] = []
    let proposed = false
    for (const action of result.actions) {
      if (action.type === "send") {
        outputEvents.push(this.#recordAgentCommunication(revision.definition, agentId, scope, action, result.turnEvent.id))
        continue
      }
      if (proposed) throw new Error("An Agent turn may create only one Swarm Proposal")
      proposed = true
      await this.#propose({
        authoredBy: agentId,
        definition: action.definition,
        addedAgentHeads: action.addedAgentHeads,
        reasonEventIds: [result.turnEvent.id],
        pluginEvidenceFrontier: proposalPluginFrontier,
      })
    }
    return { ...result, outputEvents }
  }

  async #propose({
    authoredBy,
    definition = this.activeRevision().definition,
    addedAgentHeads = {},
    reasonEventIds,
    pluginEvidenceFrontier = this.ledger.head().seq,
  }: ProposalInput & { pluginEvidenceFrontier?: number }): Promise<SwarmProposal> {
    const base = this.activeRevision()
    findAgent(base.definition, authoredBy)
    if (!Array.isArray(reasonEventIds) || reasonEventIds.length === 0) {
      throw new Error("Proposal requires at least one committed causal Event")
    }
    const checkedDefinition = validateDefinition(definition)
    await this.#assertPluginCommits(checkedDefinition)
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
      pluginCommits: proposalPluginCommits(
        base,
        checkedDefinition,
        this.ledger.all(),
        pluginEvidenceFrontier,
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
        pluginCommits: body.pluginCommits,
        ledgerFrontier: body.ledgerFrontier,
      },
    })
    const proposal = immutable<SwarmProposal>({ id, ...body, eventId: event.id })
    this.#proposals.set(id, proposal)
    this.#mainSessionGeneration += 1
    this.#freezeMainHarness()
    return proposal
  }

  createFork(sourceId: string, human: string): ForkSnapshot {
    this.#assertRunning()
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
    this.#forkHarness.set(id, this.#sourceHarness(source))
    return snapshotFork(fork)
  }

  async runForks(forkIds: string[]): Promise<ForkSnapshot[]> {
    return Promise.all(forkIds.map((forkId) => this.runFork(forkId)))
  }

  async runFork(forkId: string): Promise<ForkSnapshot> {
    this.#assertRunning()
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
    this.#assertRunning()
    const current = this.#activationOperations.then(
      () => this.#activate(forkId, expectedFrontier, human),
      () => this.#activate(forkId, expectedFrontier, human),
    )
    this.#activationOperations = current.then(
      () => undefined,
      () => undefined,
    )
    return current
  }

  async #activate(forkId: string, expectedFrontier: number, human: string): Promise<SwarmRevision> {
    this.#activationBarrier = true
    try {
      await this.settled()
      const nextAgents = new Set(this.#mutableFork(forkId).definition.agents.map((agent) => agent.id))
      for (const agentId of this.#agentHeads.keys()) {
        if (!nextAgents.has(agentId) && this.#pending.get(agentId)?.length) {
          throw new Error(`Cannot remove Agent with pending Events: ${agentId}`)
        }
      }
      return await this.#withFork(forkId, () => this.#approve(forkId, expectedFrontier, human))
    } finally {
      this.#activationBarrier = false
      if (!this.#terminated) for (const agent of this.activeRevision().definition.agents) this.#startAgent(agent.id)
    }
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
      nextHeads[agent.id] = result.head.commit
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
      pluginCommits: source.pluginCommits,
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
    for (const agentId of this.#pending.keys()) {
      if (!(agentId in nextHeads)) this.#pending.delete(agentId)
    }
    const selectedHarness = this.#forkHarness.get(fork.id) ?? new Map<string, HarnessState>()
    this.#mainHarness = new Map(
      fork.definition.agents.map((agent) => {
        const state = selectedHarness.get(agent.id)
        return [
          agent.id,
          state
            ? { ...state, forkNext: Boolean(state.checkpoint) }
            : { checkpoint: null, workspaceCommit: nextHeads[agent.id]!, forkNext: false },
        ]
      }),
    )
    fork.status = "approved"
    if (this.#revisionActivator) {
      try {
        await this.#revisionActivator(revision.definition)
      } catch (error) {
        this.terminate()
        throw error
      }
    }
    return revision
  }

  async deny(forkId: string, expectedFrontier: number, human: string, reason?: string): Promise<LedgerEvent> {
    this.#assertRunning()
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
    const pending = new Map<string, LedgerEvent[]>()
    const running = new Map<string, Promise<void>>()
    let deliveries = 0
    const route = (event: LedgerEvent) => {
      for (const agentId of communicationTargets(fork.definition, event)) {
        const events = pending.get(agentId) ?? []
        events.push(event)
        pending.set(agentId, events)
        start(agentId)
      }
    }
    const start = (agentId: string) => {
      if (running.has(agentId) || !pending.get(agentId)?.length) return
      const work = drain(agentId).finally(() => {
        running.delete(agentId)
        start(agentId)
      })
      running.set(agentId, work)
    }
    const drain = async (agentId: string) => {
      const queue = pending.get(agentId)!
      while (queue.length > 0) {
        const agent = findAgent(fork.definition, agentId)
        const inputEvents = agent.turnPolicy === "single-event" ? queue.splice(0, 1) : queue.splice(0)
        deliveries += inputEvents.length
        if (deliveries > 100) throw new Error("Fork exceeded 100 Agent deliveries")
        const baseCommit = fork.agentHeads[agent.id]!
        const states = this.#forkHarness.get(fork.id)!
        const harness = states.get(agent.id) ?? {
          checkpoint: null,
          workspaceCommit: baseCommit,
          forkNext: false,
        }
        const checkpoint = harness.checkpoint?.harness === agent.harness ? harness.checkpoint : null
        const result = await this.agentRuntime.runTurn({
          agent,
          baseCommit,
          scope: fork.scope,
          inputEvents,
          workspaceHeads: { ...fork.agentHeads },
          pluginAccess: this.#pluginAccess({ ...fork.definition, plugins: fork.pluginBindings }, agent.id, false),
          ...(checkpoint ? { checkpoint } : {}),
          forkSession: Boolean(checkpoint) && (harness.forkNext || harness.workspaceCommit !== baseCommit),
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
        fork.agentHeads[agent.id] = result.workspaceCommit.commit
        states.set(agent.id, {
          checkpoint: result.checkpoint,
          workspaceCommit: baseCommit,
          forkNext: result.workspaceCommit.commit !== baseCommit,
        })
        for (const action of result.actions) {
          if (action.type === "propose") throw new Error("A Fork may not create another Swarm Proposal")
          route(this.#recordAgentCommunication(fork.definition, agentId, fork.scope, action, result.turnEvent.id))
        }
      }
    }
    for (const event of initialEvents) route(event)
    while (running.size > 0) await Promise.all(running.values())
  }

  #recordAgentCommunication(
    definition: SwarmDefinition,
    agentId: string,
    scope: ReturnType<typeof activeScope> | ReturnType<typeof forkScope>,
    action: SendAction,
    turnEventId: string,
  ): LedgerEvent {
    const recipients = action.to.map((target) => target.startsWith("agent/") ? target : `agent/${target}`)
    for (const recipient of recipients) {
      const target = recipient.slice("agent/".length)
      findAgent(definition, target)
      if (!definition.routes.some((route) => route.from === agentId && route.to === target)) {
        throw new Error(`Communication route is not defined: ${agentId} -> ${target}`)
      }
    }
    return this.ledger.append({
      type: "communication.sent",
      actor: `agent/${agentId}`,
      scope,
      causation: [turnEventId],
      data: {
        from: `agent/${agentId}`,
        to: recipients,
        content: [{ type: "text", text: action.text }],
      },
    })
  }

  #freezeMainHarness(): void {
    for (const [agentId, state] of this.#mainHarness) {
      this.#mainHarness.set(agentId, { ...state, forkNext: Boolean(state.checkpoint) })
    }
  }

  #sourceHarness(source: ForkSource): Map<string, HarnessState> {
    const states = new Map<string, HarnessState>()
    for (const [agentId, head] of Object.entries(source.agentHeads)) {
      const checkpoint = this.#sourceCheckpoint(source, agentId)
      states.set(agentId, {
        checkpoint,
        workspaceCommit: checkpoint ? this.#checkpointWorkspace(checkpoint) : head,
        forkNext: Boolean(checkpoint),
      })
    }
    return states
  }

  #sourceCheckpoint(source: ForkSource, agentId: string): HarnessCheckpoint | null {
    const revision = source.kind === "revision" ? this.#revisions.get(source.id) : undefined
    const scope = revision?.sourceForkId ? forkScope(revision.sourceForkId) : activeScope()
    const frontier = revision?.sourceForkId
      ? this.#lastForkEvent(revision.sourceForkId).seq
      : source.ledgerFrontier
    const event = this.ledger.all().findLast((candidate) => {
      if (candidate.seq > frontier || candidate.type !== "agent.turn.recorded") return false
      if (candidate.scope.kind !== scope.kind) return false
      if (scope.kind === "fork" && candidate.scope.kind === "fork" && candidate.scope.forkId !== scope.forkId) return false
      return (candidate.data as { agentId?: unknown }).agentId === agentId
    })
    const trajectory = (event?.data as { trajectory?: unknown } | undefined)?.trajectory
    return isHarnessCheckpoint(trajectory) ? trajectory : null
  }

  #checkpointWorkspace(checkpoint: HarnessCheckpoint): string {
    const event = this.ledger.all().findLast((candidate) => {
      if (candidate.type !== "agent.turn.recorded") return false
      const trajectory = (candidate.data as { trajectory?: unknown }).trajectory
      return isHarnessCheckpoint(trajectory) &&
        trajectory.sessionId === checkpoint.sessionId && trajectory.turnId === checkpoint.turnId
    })
    const commit = (event?.data as { inputWorkspaceCommit?: unknown } | undefined)?.inputWorkspaceCommit
    if (typeof commit !== "string") throw new Error("Harness checkpoint has no Agent turn")
    return commit
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
        pluginCommits: proposal.pluginCommits,
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
        workspaceCommits: revision.workspaceCommits,
        pluginCommits: revision.pluginCommits,
        ledgerFrontier: this.ledger.get(revision.eventId).seq,
      }
    }
    throw new Error(`unknown Fork source: ${id}`)
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

  async #assertPluginCommits(definition: SwarmDefinition): Promise<void> {
    if (definition.plugins.length === 0) return
    const pluginWorkspaces = this.#pluginWorkspaces()
    for (const plugin of definition.plugins) {
      await pluginWorkspaces.assertCommit(plugin.id, plugin.commit)
      await pluginWorkspaces.assertCommand(plugin.id, plugin.commit, plugin.command)
      await pluginWorkspaces.assertRuntime(plugin.id, plugin.commit)
      await pluginWorkspaces.prompt(plugin.id, plugin.commit)
    }
  }

  #pluginAccess(definition: SwarmDefinition, agentId: string, writable: boolean): AgentPluginAccess[] {
    return definition.plugins
      .filter((binding) =>
        binding.exposedTo.includes(agentId) ||
        definition.pluginIngress.some((edge) => edge.plugin === binding.id && edge.ingressTo === agentId),
      )
      .map((binding) => immutable({
        id: binding.id,
        ...(binding.exposedTo.includes(agentId) ? { command: binding.command } : {}),
        mode: binding.mode,
        activeCommit: binding.commit,
        writable: writable && binding.exposedTo.includes(agentId),
        env: this.#pluginEnvironment(binding.id),
      }))
  }

  async #pluginDraftHeads(definition: SwarmDefinition): Promise<Record<string, string>> {
    return Object.fromEntries(await Promise.all(definition.plugins.map(async (plugin) => [
      plugin.id,
      await this.pluginDraftHead(plugin.id),
    ])))
  }

  #pluginWorkspaces() {
    if (!this.agentRuntime.pluginWorkspaces) throw new Error("Plugin workspaces are not configured")
    return this.agentRuntime.pluginWorkspaces
  }

  #assertRunning(): void {
    if (this.#terminated) throw new Error("Swarm is terminated")
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

function isHarnessCheckpoint(value: unknown): value is HarnessCheckpoint {
  if (!value || typeof value !== "object") return false
  const checkpoint = value as Partial<HarnessCheckpoint>
  return typeof checkpoint.harness === "string" &&
    typeof checkpoint.model === "string" &&
    (checkpoint.effort === undefined || typeof checkpoint.effort === "string") &&
    typeof checkpoint.sessionId === "string" &&
    typeof checkpoint.turnId === "string"
}
