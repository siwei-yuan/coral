import type { LedgerEvent } from "../../core/ledger/ledger.ts"
import type { SwarmDefinition } from "../../core/swarm/definition.ts"
import type { CommitEvidence, SwarmRevision } from "../../core/swarm/revision.ts"

export interface RevisionView {
  id: string
  parentRevision: string | null
  sourceProposalId: string | null
  sourceForkId: string | null
  definition: SwarmDefinition
  agentHeads: Record<string, string>
  workspaceCommits: Record<string, CommitEvidence[]>
  pluginCommits: Record<string, CommitEvidence[]>
  ledgerFrontier: number
  eventId: string
  seq: number
  active: boolean
}

export interface ProposalView {
  id: string
  baseRevision: string
  authoredBy: string
  definition: SwarmDefinition
  workspaceCommits: Record<string, CommitEvidence[]>
  pluginCommits: Record<string, CommitEvidence[]>
  eventId: string
  seq: number
}

export interface ForkTestView {
  id: string
  passed: boolean
  evidenceEventIds: string[]
}

export interface ForkView {
  id: string
  sourceKind: "revision" | "proposal"
  sourceId: string
  status: "open" | "approved" | "denied"
  frontier: number
  communicationCount: number
  turnCount: number
  workspaceCommitCount: number
  changedAgents: string[]
  tests: ForkTestView[]
  seq: number
}

export interface PluginEventView {
  seq: number
  type: string
  actor: string
  recipients: string[]
  scope: "main" | string
}

export interface PluginView {
  id: string
  command: string
  mode: string
  activeCommit: string
  draftCommit: string
  exposedTo: string[]
  ingressTargets: string[]
  events: PluginEventView[]
}

export interface AgentCheckpointView {
  harness: string
  sessionId: string
  turnId: string
  outcome: string
  pendingFork: boolean
}

export interface AgentStateView {
  id: string
  harness: string
  workspaceHead: string
  evolved: boolean
  checkpoint: AgentCheckpointView | null
}

export interface EvolutionNodeView {
  id: string
  eventId: string
  parentId: string | null
  kind: "revision" | "proposal" | "fork" | "decision"
  status: string
  seq: number
  lane: number
  detail: string
  metrics: string[]
  sourceId?: string
}

export interface EventReferenceView {
  id: string
  type: string
}

export interface TurnView {
  id: string
  seq: number
  agentId: string
  scope: string
  outcome: string
  inputs: EventReferenceView[]
  outputs: EventReferenceView[]
  checkpoint: { harness: string; sessionId: string; turnId: string } | null
}

export interface DefaultViewModel {
  activeRevision: RevisionView | null
  activeWorkspaceHeads: Record<string, string>
  agents: AgentStateView[]
  evolution: EvolutionNodeView[]
  turns: TurnView[]
  revisions: RevisionView[]
  proposals: ProposalView[]
  forks: ForkView[]
  plugins: PluginView[]
  events: LedgerEvent[]
}

type RevisionBody = Omit<SwarmRevision, "eventId">

export function projectLedger(events: LedgerEvent[]): DefaultViewModel {
  const ordered = [...events].sort((left, right) => left.seq - right.seq)
  const revisions = ordered.flatMap((event): RevisionView[] => {
    if (event.type !== "swarm.revision.activated") return []
    const revision = (event.data as { revision?: RevisionBody }).revision
    return revision ? [{
      id: revision.id,
      parentRevision: revision.parentRevision,
      sourceProposalId: revision.sourceProposalId,
      sourceForkId: revision.sourceForkId,
      definition: revision.definition,
      agentHeads: revision.agentHeads,
      workspaceCommits: revision.workspaceCommits,
      pluginCommits: revision.pluginCommits,
      ledgerFrontier: revision.ledgerFrontier,
      eventId: event.id,
      seq: event.seq,
      active: false,
    }] : []
  })
  const activeRevision = revisions.at(-1) ?? null
  if (activeRevision) activeRevision.active = true

  const proposals = ordered.flatMap((event): ProposalView[] => {
    if (event.type !== "swarm.revision.proposed") return []
    const data = event.data as {
      proposalId?: unknown
      baseRevision: string
      authoredBy: string
      definition: SwarmDefinition
      workspaceCommits: Record<string, CommitEvidence[]>
      pluginCommits: Record<string, CommitEvidence[]>
    }
    return typeof data.proposalId === "string" ? [{
      id: data.proposalId,
      baseRevision: data.baseRevision,
      authoredBy: data.authoredBy,
      definition: data.definition,
      workspaceCommits: data.workspaceCommits,
      pluginCommits: data.pluginCommits,
      eventId: event.id,
      seq: event.seq,
    }] : []
  })

  const forks = ordered.flatMap((event): ForkView[] => {
    if (event.type !== "swarm.fork.created") return []
    const data = event.data as {
      forkId: string
      sourceKind: "revision" | "proposal"
      sourceId: string
      definition: SwarmDefinition
      agentHeads: Record<string, string>
    }
    const scoped = ordered.filter((item) => item.scope.kind === "fork" && item.scope.forkId === data.forkId)
    const heads = { ...data.agentHeads }
    for (const item of scoped) {
      if (item.type !== "agent.workspace.committed") continue
      const commit = item.data as { agentId?: string; commit?: string }
      if (commit.agentId && commit.commit) heads[commit.agentId] = commit.commit
    }
    const decision = decisionForFork(ordered, data.forkId)
    const verdict = (decision?.data as { verdict?: "approved" | "denied" } | undefined)?.verdict
    return [{
      id: data.forkId,
      sourceKind: data.sourceKind,
      sourceId: data.sourceId,
      status: verdict ?? "open",
      frontier: scoped.at(-1)?.seq ?? event.seq,
      communicationCount: count(scoped, "communication.sent"),
      turnCount: count(scoped, "agent.turn.recorded"),
      workspaceCommitCount: count(scoped, "agent.workspace.committed"),
      changedAgents: Object.keys(heads).filter((agentId) => heads[agentId] !== data.agentHeads[agentId]),
      tests: projectTests(data.definition, scoped),
      seq: event.seq,
    }]
  })

  const plugins = activeRevision?.definition.plugins.map((binding): PluginView => ({
    id: binding.id,
    command: binding.command,
    mode: binding.mode,
    activeCommit: binding.commit,
    draftCommit: pluginDraftCommit(ordered, binding.id, binding.commit),
    exposedTo: binding.exposedTo,
    ingressTargets: activeRevision.definition.pluginIngress
      .filter((item) => item.plugin === binding.id)
      .map((item) => item.ingressTo),
    events: ordered.flatMap((event): PluginEventView[] => {
      if (!isPluginEvent(event, binding.id)) return []
      const data = event.data as { to?: unknown }
      return [{
        seq: event.seq,
        type: event.type,
        actor: event.actor,
        recipients: Array.isArray(data.to) ? data.to.filter((item): item is string => typeof item === "string") : [],
        scope: event.scope.kind === "active" ? "main" : event.scope.forkId,
      }]
    }),
  })) ?? []

  const activeWorkspaceHeads = activeRevision ? activeHeads(activeRevision, ordered) : {}
  return {
    activeRevision,
    activeWorkspaceHeads,
    agents: activeRevision ? projectAgents(activeRevision, activeWorkspaceHeads, ordered) : [],
    evolution: projectEvolution(revisions, proposals, forks, ordered),
    turns: projectTurns(ordered),
    revisions,
    proposals,
    forks,
    plugins,
    events: ordered,
  }
}

function projectEvolution(
  revisions: RevisionView[],
  proposals: ProposalView[],
  forks: ForkView[],
  events: LedgerEvent[],
): EvolutionNodeView[] {
  const lanes = new Map(forks.map((fork, index) => [fork.id, index + 1]))
  const nodes: EvolutionNodeView[] = []
  for (const revision of revisions) {
    const decision = revision.sourceForkId ? decisionForFork(events, revision.sourceForkId) : undefined
    const workspaceCommits = Object.values(revision.workspaceCommits).reduce((total, items) => total + items.length, 0)
    const pluginCommits = Object.values(revision.pluginCommits).reduce((total, items) => total + items.length, 0)
    nodes.push({
      id: revision.id,
      eventId: revision.eventId,
      parentId: decision?.id ?? revision.parentRevision,
      kind: "revision",
      status: revision.active ? "active" : "snapshot",
      seq: revision.seq,
      lane: 0,
      detail: revision.active ? "Active Main snapshot" : "Immutable Swarm snapshot",
      metrics: [`${revision.definition.agents.length} Agents`, `${workspaceCommits} workspace commits`, `${pluginCommits} Plugin commits`],
      sourceId: revision.id,
    })
  }
  for (const proposal of proposals) {
    const commits = Object.values(proposal.workspaceCommits).reduce((total, items) => total + items.length, 0)
    const pluginCommits = Object.values(proposal.pluginCommits).reduce((total, items) => total + items.length, 0)
    nodes.push({
      id: proposal.id,
      eventId: proposal.eventId,
      parentId: proposal.baseRevision,
      kind: "proposal",
      status: "proposed",
      seq: proposal.seq,
      lane: 0,
      detail: `Proposed by ${proposal.authoredBy}`,
      metrics: [`${proposal.definition.agents.length} Agents`, `${commits} workspace commits`, `${pluginCommits} Plugin commits`],
      sourceId: proposal.id,
    })
  }
  for (const fork of forks) {
    nodes.push({
      id: fork.id,
      eventId: eventForFork(events, fork.id)?.id ?? fork.id,
      parentId: fork.sourceId,
      kind: "fork",
      status: fork.status,
      seq: fork.seq,
      lane: lanes.get(fork.id)!,
      detail: `${fork.sourceKind} evaluation branch`,
      metrics: [`${fork.turnCount} turns`, `${fork.workspaceCommitCount} commits`, `${fork.communicationCount} messages`],
    })
    const decision = decisionForFork(events, fork.id)
    if (!decision) continue
    const verdict = (decision.data as { verdict?: string }).verdict ?? "decided"
    nodes.push({
      id: decision.id,
      eventId: decision.id,
      parentId: fork.id,
      kind: "decision",
      status: verdict,
      seq: decision.seq,
      lane: lanes.get(fork.id)!,
      detail: `${verdict === "approved" ? "Approved" : "Denied"} by ${decision.actor.replace(/^human\//, "")}`,
      metrics: [`frontier #${(decision.data as { forkFrontier?: unknown }).forkFrontier ?? fork.frontier}`],
    })
  }
  return nodes.sort((left, right) => left.seq - right.seq)
}

function projectAgents(
  revision: RevisionView,
  heads: Record<string, string>,
  events: LedgerEvent[],
): AgentStateView[] {
  const latestProposal = events.findLast((event) => event.scope.kind === "active" && event.type === "swarm.revision.proposed")
  return revision.definition.agents.map((agent) => {
    const activeTurn = events.findLast((event) =>
      event.seq > revision.seq && event.scope.kind === "active" && isAgentTurn(event, agent.id),
    )
    const sourceTurn = !activeTurn && revision.sourceForkId
      ? turnForFork(revision.sourceForkId, agent.id, events)
      : undefined
    const turn = activeTurn ?? sourceTurn
    const data = turn?.data as {
      inputWorkspaceCommit?: unknown
      outcome?: unknown
      trajectory?: { harness?: unknown; sessionId?: unknown; turnId?: unknown }
    } | undefined
    const trajectory = data?.trajectory
    const workspaceHead = heads[agent.id]!
    const checkpoint = turn && isTrajectory(trajectory) ? {
      harness: trajectory.harness,
      sessionId: trajectory.sessionId,
      turnId: trajectory.turnId,
      outcome: typeof data?.outcome === "string" ? data.outcome : "unknown",
      pendingFork: data?.inputWorkspaceCommit !== workspaceHead ||
        turn.seq < revision.seq || Boolean(latestProposal && latestProposal.seq > turn.seq),
    } : null
    return {
      id: agent.id,
      harness: agent.harness,
      workspaceHead,
      evolved: workspaceHead !== revision.agentHeads[agent.id],
      checkpoint,
    }
  })
}

function turnForFork(forkId: string, agentId: string, events: LedgerEvent[]): LedgerEvent | undefined {
  const ownTurn = events.findLast((event) =>
    event.scope.kind === "fork" && event.scope.forkId === forkId && isAgentTurn(event, agentId),
  )
  if (ownTurn) return ownTurn
  const created = eventForFork(events, forkId)
  const source = created?.data as {
    sourceKind?: unknown
    sourceId?: unknown
    sourceFrontier?: unknown
  } | undefined
  if (source?.sourceKind === "proposal" && typeof source.sourceFrontier === "number") {
    const frontier = source.sourceFrontier
    return events.findLast((event) =>
      event.seq <= frontier && event.scope.kind === "active" && isAgentTurn(event, agentId),
    )
  }
  if (source?.sourceKind !== "revision" || typeof source.sourceId !== "string") return undefined
  const activation = events.find((event) => {
    if (event.type !== "swarm.revision.activated") return false
    return (event.data as { revision?: { id?: unknown } }).revision?.id === source.sourceId
  })
  const sourceForkId = (activation?.data as { revision?: { sourceForkId?: unknown } } | undefined)?.revision?.sourceForkId
  if (typeof sourceForkId === "string") return turnForFork(sourceForkId, agentId, events)
  return events.findLast((event) =>
    event.seq <= (activation?.seq ?? 0) && event.scope.kind === "active" && isAgentTurn(event, agentId),
  )
}

function projectTurns(events: LedgerEvent[]): TurnView[] {
  const byId = new Map(events.map((event) => [event.id, event]))
  return events.flatMap((event): TurnView[] => {
    if (event.type !== "agent.turn.recorded") return []
    const data = event.data as {
      turnId?: unknown
      agentId?: unknown
      inputEventIds?: unknown
      outcome?: unknown
      trajectory?: { harness?: unknown; sessionId?: unknown; turnId?: unknown }
    }
    if (typeof data.agentId !== "string") return []
    const inputIds = Array.isArray(data.inputEventIds)
      ? data.inputEventIds.filter((id): id is string => typeof id === "string")
      : []
    const related = events.filter((candidate) => {
      if (candidate.causation.includes(event.id)) return true
      if (candidate.type !== "agent.workspace.committed" && candidate.type !== "plugin.workspace.committed") return false
      return typeof data.turnId === "string" && (candidate.data as { turnId?: unknown }).turnId === data.turnId
    })
    return [{
      id: event.id,
      seq: event.seq,
      agentId: data.agentId,
      scope: event.scope.kind === "active" ? "Main" : event.scope.forkId,
      outcome: typeof data.outcome === "string" ? data.outcome : "unknown",
      inputs: inputIds.map((id) => ({ id, type: byId.get(id)?.type ?? "unknown" })),
      outputs: related.map((item) => ({ id: item.id, type: item.type })),
      checkpoint: isTrajectory(data.trajectory) ? data.trajectory : null,
    }]
  })
}

function pluginDraftCommit(events: LedgerEvent[], pluginId: string, fallback: string): string {
  for (const event of [...events].reverse()) {
    if (
      event.scope.kind !== "active" ||
      (event.type !== "plugin.workspace.initialized" && event.type !== "plugin.workspace.committed")
    ) continue
    const data = event.data as { pluginId?: unknown; commit?: unknown; importedHead?: unknown }
    if (data.pluginId !== pluginId) continue
    if (typeof data.importedHead === "string") return data.importedHead
    if (typeof data.commit === "string") return data.commit
  }
  return fallback
}

function activeHeads(revision: RevisionView, events: LedgerEvent[]): Record<string, string> {
  const activation = events.find((event) => event.id === revision.eventId)
  const data = activation?.data as { workspaceHeads?: Record<string, string> } | undefined
  const heads = { ...(data?.workspaceHeads ?? revision.agentHeads) }
  for (const event of events) {
    if (event.seq <= revision.seq || event.scope.kind !== "active") continue
    if (event.type !== "agent.workspace.committed" && event.type !== "agent.workspace.reapplied") continue
    const commit = event.data as { agentId?: string; commit?: string }
    if (commit.agentId && commit.commit && commit.agentId in heads) heads[commit.agentId] = commit.commit
  }
  return heads
}

function projectTests(definition: SwarmDefinition, events: LedgerEvent[]): ForkTestView[] {
  return definition.tests.map((test) => {
    const roots = events.filter((event) => event.actor === `test/${test.id}`)
    const reachable = new Set(roots.map((event) => event.id))
    for (const event of events) {
      if (event.causation.some((id) => reachable.has(id))) reachable.add(event.id)
    }
    const evidence = events.filter(
      (event) => reachable.has(event.id) && event.type === test.expect.eventType && !roots.includes(event),
    )
    return { id: test.id, passed: evidence.length > 0, evidenceEventIds: evidence.map((event) => event.id) }
  })
}

function isPluginEvent(event: LedgerEvent, pluginId: string): boolean {
  if (event.type !== "communication.sent" || !event.data || typeof event.data !== "object") return false
  const data = event.data as { source?: { plugin?: unknown } }
  return event.actor === `plugin/${pluginId}` || data.source?.plugin === pluginId
}

function isAgentTurn(event: LedgerEvent, agentId: string): boolean {
  return event.type === "agent.turn.recorded" && (event.data as { agentId?: unknown }).agentId === agentId
}

function isTrajectory(value: unknown): value is { harness: string; sessionId: string; turnId: string } {
  if (!value || typeof value !== "object") return false
  const trajectory = value as { harness?: unknown; sessionId?: unknown; turnId?: unknown }
  return typeof trajectory.harness === "string" &&
    typeof trajectory.sessionId === "string" &&
    typeof trajectory.turnId === "string"
}

function decisionForFork(events: LedgerEvent[], forkId: string): LedgerEvent | undefined {
  return events.findLast((event) =>
    event.type === "swarm.decision.recorded" && (event.data as { forkId?: unknown }).forkId === forkId,
  )
}

function eventForFork(events: LedgerEvent[], forkId: string): LedgerEvent | undefined {
  return events.find((event) =>
    event.type === "swarm.fork.created" && (event.data as { forkId?: unknown }).forkId === forkId,
  )
}

function count(events: LedgerEvent[], type: string): number {
  return events.filter((event) => event.type === type).length
}
