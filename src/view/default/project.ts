import type { LedgerEvent } from "../../core/ledger/ledger.ts"
import type { SwarmDefinition } from "../../core/swarm/definition.ts"
import type { SwarmRevision, WorkspaceCommitRef } from "../../core/swarm/revision.ts"

export interface RevisionView {
  id: string
  parentRevision: string | null
  sourceProposalId: string | null
  sourceForkId: string | null
  definition: SwarmDefinition
  agentHeads: Record<string, string>
  workspaceCommits: Record<string, WorkspaceCommitRef[]>
  ledgerFrontier: number
  activatedAt: string
  active: boolean
}

export interface ProposalView {
  id: string
  baseRevision: string
  authoredBy: string
  definition: SwarmDefinition
  agentHeads: Record<string, string>
  workspaceCommits: Record<string, WorkspaceCommitRef[]>
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
  definition: SwarmDefinition
  agentHeads: Record<string, string>
  status: "open" | "approved" | "denied"
  frontier: number
  eventCount: number
  communicationCount: number
  tests: ForkTestView[]
  createdAt: string
}

export interface DefaultViewModel {
  activeRevision: RevisionView | null
  activeWorkspaceHeads: Record<string, string>
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
    const data = event.data as { revision?: RevisionBody }
    if (!data.revision) return []
    return [{ ...data.revision, activatedAt: event.recordedAt, active: false }]
  })
  const activeRevision = revisions.at(-1) ?? null
  if (activeRevision) activeRevision.active = true

  const proposals = ordered.flatMap((event): ProposalView[] => {
    if (event.type !== "swarm.revision.proposed") return []
    const data = event.data as {
      proposalId: string
      baseRevision: string
      authoredBy: string
      definition: SwarmDefinition
      agentHeads: Record<string, string>
      workspaceCommits: Record<string, WorkspaceCommitRef[]>
    }
    return [{
      id: data.proposalId,
      baseRevision: data.baseRevision,
      authoredBy: data.authoredBy,
      definition: data.definition,
      agentHeads: data.agentHeads,
      workspaceCommits: data.workspaceCommits,
      eventId: event.id,
      seq: event.seq,
    }]
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
    const decision = ordered.findLast((item) => {
      if (item.type !== "swarm.decision.recorded") return false
      return (item.data as { forkId?: string }).forkId === data.forkId
    })
    const verdict = (decision?.data as { verdict?: "approved" | "denied" } | undefined)?.verdict
    return [{
      id: data.forkId,
      sourceKind: data.sourceKind,
      sourceId: data.sourceId,
      definition: data.definition,
      agentHeads: heads,
      status: verdict ?? "open",
      frontier: scoped.at(-1)?.seq ?? event.seq,
      eventCount: scoped.length,
      communicationCount: scoped.filter((item) => item.type === "communication.sent").length,
      tests: projectTests(data.definition, scoped),
      createdAt: event.recordedAt,
    }]
  })

  const activeWorkspaceHeads = activeRevision ? activeHeads(activeRevision, ordered) : {}
  return { activeRevision, activeWorkspaceHeads, revisions, proposals, forks, events: ordered }
}

function activeHeads(revision: RevisionView, events: LedgerEvent[]): Record<string, string> {
  const activation = events.find((event) => {
    if (event.type !== "swarm.revision.activated") return false
    return (event.data as { revision?: { id?: string } }).revision?.id === revision.id
  })
  const data = activation?.data as { workspaceHeads?: Record<string, string> } | undefined
  const heads = { ...(data?.workspaceHeads ?? revision.agentHeads) }
  for (const event of events) {
    if (event.seq <= (activation?.seq ?? 0) || event.scope.kind !== "active") continue
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
