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

export interface DefaultViewModel {
  activeRevision: RevisionView | null
  evolution: EvolutionNodeView[]
  revisions: RevisionView[]
  proposals: ProposalView[]
  forks: ForkView[]
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

  return {
    activeRevision,
    evolution: projectEvolution(revisions, proposals, forks, ordered),
    revisions,
    proposals,
    forks,
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
