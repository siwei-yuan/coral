import type { HarnessCheckpoint } from "../../harness/adapter.ts"
import { immutable } from "../canonical.ts"
import type { LedgerEvent, Scope } from "../ledger/ledger.ts"
import type { MutableFork, SwarmProposal, SwarmRevision } from "./revision.ts"
import { safeForkBindings } from "./revision.ts"

export interface HarnessState {
  checkpoint: HarnessCheckpoint | null
  workspaceCommit: string
  forkNext: boolean
}

export interface SwarmState {
  revisions: SwarmRevision[]
  proposals: SwarmProposal[]
  forks: MutableFork[]
  activeRevisionId: string
  agentHeads: Record<string, string>
  mainHarness: Record<string, HarnessState>
  forkHarness: Record<string, Record<string, HarnessState>>
}

export function projectSwarmState(events: LedgerEvent[]): SwarmState {
  const revisions = events.flatMap((event) => event.type === "swarm.revision.activated" ? [revision(event)] : [])
  const proposals = events.flatMap((event) => event.type === "swarm.revision.proposed" ? [proposal(event)] : [])
  const active = revisions.at(-1)
  if (!active) throw new Error("Ledger has no active Swarm Revision")
  const activation = events.find((event) => event.id === active.eventId)!
  const activeAgents = new Set(active.definition.agents.map((agent) => agent.id))
  const agentHeads = activationHeads(activation)
  const mainHarness = initialHarness(active, activation.seq, events, agentHeads)

  for (const event of events) {
    if (event.seq <= activation.seq || event.scope.kind !== "active") continue
    updateAgentHead(event, agentHeads, activeAgents)
    updateHarness(event, mainHarness, activeAgents)
    if (event.type === "swarm.revision.proposed") freezeHarness(mainHarness)
  }

  const forks = events.flatMap((event) => event.type === "swarm.fork.created"
    ? [projectFork(event, events, revisions, proposals)]
    : [])
  return immutable({
    revisions,
    proposals,
    forks,
    activeRevisionId: active.id,
    agentHeads,
    mainHarness,
    forkHarness: Object.fromEntries(forks.map((fork) => [
      fork.id,
      projectForkHarness(fork, events, revisions, proposals),
    ])),
  })
}

function revision(event: LedgerEvent): SwarmRevision {
  const body = (event.data as { revision?: Omit<SwarmRevision, "eventId"> }).revision
  if (!body || typeof body.id !== "string") throw new Error(`Invalid Revision Event: ${event.id}`)
  return immutable({ ...body, eventId: event.id })
}

function proposal(event: LedgerEvent): SwarmProposal {
  const data = event.data as Omit<SwarmProposal, "id" | "eventId"> & { proposalId?: unknown }
  if (typeof data.proposalId !== "string") throw new Error(`Invalid Proposal Event: ${event.id}`)
  const { proposalId, ...body } = data
  return immutable({ id: proposalId, ...body, eventId: event.id })
}

function projectFork(
  created: LedgerEvent,
  events: LedgerEvent[],
  revisions: SwarmRevision[],
  proposals: SwarmProposal[],
): MutableFork {
  const data = created.data as {
    forkId?: unknown
    sourceKind: "revision" | "proposal"
    sourceId: string
    definition: MutableFork["definition"]
    agentHeads: Record<string, string>
    sourceFrontier: number
  }
  if (typeof data.forkId !== "string" || created.scope.kind !== "fork") {
    throw new Error(`Invalid Fork Event: ${created.id}`)
  }
  const scoped = events.filter((event) => event.scope.kind === "fork" && event.scope.forkId === data.forkId)
  const agentHeads = { ...data.agentHeads }
  const agentIds = new Set(data.definition.agents.map((agent) => agent.id))
  for (const event of scoped) updateAgentHead(event, agentHeads, agentIds)
  const decision = events.findLast((event) => {
    if (event.type !== "swarm.decision.recorded") return false
    return (event.data as { forkId?: unknown }).forkId === data.forkId
  })
  const verdict = (decision?.data as { verdict?: unknown } | undefined)?.verdict
  if (data.sourceKind === "revision") findRevision(revisions, data.sourceId)
  else findProposal(proposals, data.sourceId)
  return {
    id: data.forkId,
    sourceKind: data.sourceKind,
    sourceId: data.sourceId,
    definition: data.definition,
    agentHeads,
    pluginBindings: immutable(safeForkBindings(data.definition.plugins)),
    sourceFrontier: data.sourceFrontier,
    scope: created.scope,
    status: verdict === "approved" || verdict === "denied" ? verdict : "open",
    frontier: scoped.at(-1)?.seq ?? created.seq,
    createdEventId: created.id,
  }
}

function projectForkHarness(
  fork: MutableFork,
  events: LedgerEvent[],
  revisions: SwarmRevision[],
  proposals: SwarmProposal[],
): Record<string, HarnessState> {
  const source: SwarmRevision | SwarmProposal = fork.sourceKind === "revision"
    ? findRevision(revisions, fork.sourceId)
    : findProposal(proposals, fork.sourceId)
  const sourceForkId = "sourceForkId" in source ? source.sourceForkId : null
  const sourceScope: Scope = sourceForkId ? { kind: "fork", forkId: sourceForkId } : { kind: "active" }
  const sourceFrontier = "sourceForkId" in source
    ? events.find((event) => event.id === source.eventId)!.seq
    : source.ledgerFrontier
  const states: Record<string, HarnessState> = {}
  for (const [agentId, head] of Object.entries(source.agentHeads)) {
    const turn = lastTurn(events, agentId, sourceScope, sourceFrontier)
    states[agentId] = turn ? harnessState(turn, true) : { checkpoint: null, workspaceCommit: head, forkNext: false }
  }
  const agentIds = new Set(fork.definition.agents.map((agent) => agent.id))
  for (const event of events) {
    if (event.scope.kind === "fork" && event.scope.forkId === fork.id) updateHarness(event, states, agentIds)
  }
  return states
}

function initialHarness(
  active: SwarmRevision,
  activationSeq: number,
  events: LedgerEvent[],
  heads: Record<string, string>,
): Record<string, HarnessState> {
  const states: Record<string, HarnessState> = {}
  const scope: Scope = active.sourceForkId ? { kind: "fork", forkId: active.sourceForkId } : { kind: "active" }
  for (const agent of active.definition.agents) {
    const turn = active.sourceForkId ? lastTurn(events, agent.id, scope, activationSeq) : undefined
    states[agent.id] = turn
      ? harnessState(turn, true)
      : { checkpoint: null, workspaceCommit: heads[agent.id]!, forkNext: false }
  }
  return states
}

function activationHeads(event: LedgerEvent): Record<string, string> {
  const heads = (event.data as { workspaceHeads?: unknown }).workspaceHeads
  if (!heads || typeof heads !== "object") throw new Error(`Revision has no workspace heads: ${event.id}`)
  return { ...(heads as Record<string, string>) }
}

function updateAgentHead(event: LedgerEvent, heads: Record<string, string>, agents: Set<string>): void {
  if (event.type !== "agent.workspace.committed" &&
    event.type !== "agent.workspace.restored" &&
    event.type !== "agent.workspace.reapplied") return
  const data = event.data as { agentId?: unknown; commit?: unknown }
  if (typeof data.agentId === "string" && typeof data.commit === "string" && agents.has(data.agentId)) {
    heads[data.agentId] = data.commit
  }
}

function updateHarness(event: LedgerEvent, states: Record<string, HarnessState>, agents: Set<string>): void {
  if (event.type !== "agent.turn.recorded") return
  const agentId = (event.data as { agentId?: unknown }).agentId
  if (typeof agentId === "string" && agents.has(agentId)) states[agentId] = harnessState(event, false)
}

function freezeHarness(states: Record<string, HarnessState>): void {
  for (const [agentId, state] of Object.entries(states)) {
    states[agentId] = { ...state, forkNext: Boolean(state.checkpoint) }
  }
}

function harnessState(event: LedgerEvent, forkNext: boolean): HarnessState {
  const data = event.data as {
    inputWorkspaceCommit?: unknown
    workspaceCommit?: unknown
    trajectory?: unknown
  }
  if (typeof data.inputWorkspaceCommit !== "string" || typeof data.workspaceCommit !== "string") {
    throw new Error(`Invalid Agent turn Event: ${event.id}`)
  }
  return {
    checkpoint: isCheckpoint(data.trajectory) ? data.trajectory : null,
    workspaceCommit: data.inputWorkspaceCommit,
    forkNext: forkNext || data.workspaceCommit !== data.inputWorkspaceCommit,
  }
}

function lastTurn(
  events: LedgerEvent[],
  agentId: string,
  scope: Scope,
  frontier: number,
): LedgerEvent | undefined {
  return events.findLast((event) => {
    if (event.seq > frontier || event.type !== "agent.turn.recorded" || event.scope.kind !== scope.kind) return false
    if (scope.kind === "fork" && event.scope.kind === "fork" && event.scope.forkId !== scope.forkId) return false
    return (event.data as { agentId?: unknown }).agentId === agentId
  })
}

function findRevision(revisions: SwarmRevision[], id: string): SwarmRevision {
  const revision = revisions.find((candidate) => candidate.id === id)
  if (!revision) throw new Error(`unknown Revision: ${id}`)
  return revision
}

function findProposal(proposals: SwarmProposal[], id: string): SwarmProposal {
  const proposal = proposals.find((candidate) => candidate.id === id)
  if (!proposal) throw new Error(`unknown Proposal: ${id}`)
  return proposal
}

function isCheckpoint(value: unknown): value is HarnessCheckpoint {
  if (!value || typeof value !== "object") return false
  const checkpoint = value as Partial<HarnessCheckpoint>
  return typeof checkpoint.harness === "string" &&
    typeof checkpoint.model === "string" &&
    (checkpoint.effort === undefined || typeof checkpoint.effort === "string") &&
    typeof checkpoint.sessionId === "string" &&
    typeof checkpoint.turnId === "string"
}
