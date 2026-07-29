import type { LedgerEvent, Scope } from "../ledger/ledger.ts"
import { sameScope } from "../ledger/ledger.ts"
import type { PluginBinding, SwarmDefinition } from "./definition.ts"

export interface WorkspaceCommitRef {
  commit: string
  eventId: string
}

export interface SwarmRevision {
  id: string
  parentRevision: string | null
  proposalId: string | null
  selectedForkId: string | null
  definition: SwarmDefinition
  definitionDigest: string
  agentHeads: Record<string, string>
  workspaceCommits: Record<string, WorkspaceCommitRef[]>
  pluginBindings: PluginBinding[]
  evaluationEventIds: string[]
  ledgerFrontier: number
  frozenEventId: string
}

export interface SwarmProposal {
  id: string
  baseRevision: string
  authoredBy: string
  reasonEventIds: string[]
  definition: SwarmDefinition
  agentHeads: Record<string, string>
  workspaceCommits: Record<string, WorkspaceCommitRef[]>
  pluginBindings: PluginBinding[]
  testDigest: string
  ledgerFrontier: number
  eventId: string
}

export interface ForkResult {
  testId: string
  passed: boolean
  evidenceEventIds: string[]
}

export interface ForkSnapshot {
  id: string
  sourceKind: "revision" | "proposal"
  sourceId: string
  definition: SwarmDefinition
  agentHeads: Record<string, string>
  pluginBindings: PluginBinding[]
  scope: Scope
  status: "running" | "completed" | "promoted"
  createdEventId: string
  evaluationEventId: string | null
  results: ForkResult[] | null
}

export interface MutableFork extends ForkSnapshot {
  ledgerFrontier: number
}

export interface ForkSource {
  kind: "revision" | "proposal"
  eventId: string
  revisionId: string
  definition: SwarmDefinition
  agentHeads: Record<string, string>
  pluginBindings: PluginBinding[]
  testDigest: string
  ledgerFrontier: number
}

export function assertCompleteHeads(definition: SwarmDefinition, heads: Record<string, string>): void {
  const expected = definition.agents.map((agent) => agent.id).sort()
  const actual = Object.keys(heads).sort()
  const hasInvalidHead = expected.some((agentId) => typeof heads[agentId] !== "string" || heads[agentId] === "")
  if (JSON.stringify(expected) !== JSON.stringify(actual) || hasInvalidHead) {
    throw new Error("Agent heads must exactly match the proposed Swarm Definition")
  }
}

export function proposalWorkspaceCommits(
  base: SwarmRevision,
  definition: SwarmDefinition,
  heads: Record<string, string>,
  events: LedgerEvent[],
  afterSeq: number,
): Record<string, WorkspaceCommitRef[]> {
  const commits = collectWorkspaceCommits(events, afterSeq, { kind: "active" })
  const relevantAgents = new Set([
    ...base.definition.agents.map((agent) => agent.id),
    ...definition.agents.map((agent) => agent.id),
  ])
  for (const agentId of Object.keys(commits)) {
    if (!relevantAgents.has(agentId)) delete commits[agentId]
  }

  for (const agent of definition.agents) {
    const baseHead = base.agentHeads[agent.id]
    if (!baseHead) {
      const agentCommits = commits[agent.id] ?? []
      commits[agent.id] = agentCommits
      if (agentCommits.some((item) => item.commit === heads[agent.id])) continue
      const initialization = events.find((event) => {
        if (event.type !== "agent.workspace.initialized") return false
        const data = event.data as { agentId?: unknown; commit?: unknown }
        return data.agentId === agent.id && data.commit === heads[agent.id]
      })
      if (!initialization) throw new Error(`New Agent head has no workspace initialization Event: ${agent.id}`)
      agentCommits.push({ commit: heads[agent.id]!, eventId: initialization.id })
      continue
    }
    if (heads[agent.id] !== baseHead && commits[agent.id]?.at(-1)?.commit !== heads[agent.id]) {
      throw new Error(`Agent head is not backed by a workspace commit Event: ${agent.id}`)
    }
  }
  return commits
}

export function collectWorkspaceCommits(
  events: LedgerEvent[],
  afterSeq: number,
  scope: Scope,
): Record<string, WorkspaceCommitRef[]> {
  const commits: Record<string, WorkspaceCommitRef[]> = {}
  for (const event of events) {
    if (
      event.seq <= afterSeq ||
      (event.type !== "agent.workspace.initialized" &&
        event.type !== "agent.workspace.committed" &&
        event.type !== "agent.workspace.reapplied") ||
      !sameScope(event.scope, scope)
    ) {
      continue
    }
    const data = event.data as { agentId?: unknown; commit?: unknown }
    if (typeof data.agentId !== "string" || typeof data.commit !== "string") continue
    const agentCommits = commits[data.agentId] ?? []
    commits[data.agentId] = agentCommits
    agentCommits.push({ commit: data.commit, eventId: event.id })
  }
  return commits
}

export function mergeWorkspaceCommits(
  ...groups: Array<Record<string, WorkspaceCommitRef[]>>
): Record<string, WorkspaceCommitRef[]> {
  const merged: Record<string, WorkspaceCommitRef[]> = {}
  for (const group of groups) {
    for (const [agentId, commits] of Object.entries(group)) {
      const agentCommits = merged[agentId] ?? []
      merged[agentId] = agentCommits
      agentCommits.push(...commits)
    }
  }
  return merged
}

export function safeForkBindings(bindings: PluginBinding[]): PluginBinding[] {
  return bindings.map((binding) => ({
    ...binding,
    mode: binding.mode === "live" ? "mock" : binding.mode,
  }))
}
