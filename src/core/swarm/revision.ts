import type { LedgerEvent, Scope } from "../ledger/ledger.ts"
import { sameScope } from "../ledger/ledger.ts"
import type { PluginBinding, SwarmDefinition } from "./definition.ts"

export interface CommitEvidence {
  commit: string
  eventId: string
}

export interface SwarmRevision {
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
}

export interface SwarmProposal {
  id: string
  baseRevision: string
  authoredBy: string
  reasonEventIds: string[]
  definition: SwarmDefinition
  agentHeads: Record<string, string>
  workspaceCommits: Record<string, CommitEvidence[]>
  pluginCommits: Record<string, CommitEvidence[]>
  ledgerFrontier: number
  eventId: string
}

export interface ForkSnapshot {
  id: string
  sourceKind: "revision" | "proposal"
  sourceId: string
  definition: SwarmDefinition
  agentHeads: Record<string, string>
  pluginBindings: PluginBinding[]
  scope: Scope
  status: "open" | "approved" | "denied"
  frontier: number
  createdEventId: string
}

export interface MutableFork extends ForkSnapshot {
  sourceFrontier: number
}

export interface ForkSource {
  kind: "revision" | "proposal"
  id: string
  eventId: string
  revisionId: string
  definition: SwarmDefinition
  agentHeads: Record<string, string>
  workspaceCommits: Record<string, CommitEvidence[]>
  pluginCommits: Record<string, CommitEvidence[]>
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
): Record<string, CommitEvidence[]> {
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
): Record<string, CommitEvidence[]> {
  const commits: Record<string, CommitEvidence[]> = {}
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

export function proposalPluginCommits(
  base: SwarmRevision,
  definition: SwarmDefinition,
  events: LedgerEvent[],
  throughSeq: number,
): Record<string, CommitEvidence[]> {
  const commits = collectPluginCommits(events, base.ledgerFrontier, throughSeq)
  const relevantPlugins = new Set([
    ...base.definition.plugins.map((plugin) => plugin.id),
    ...definition.plugins.map((plugin) => plugin.id),
  ])
  for (const pluginId of Object.keys(commits)) {
    if (!relevantPlugins.has(pluginId)) delete commits[pluginId]
  }

  for (const plugin of definition.plugins) {
    const baseCommit = base.definition.plugins.find((candidate) => candidate.id === plugin.id)?.commit
    if (plugin.commit === baseCommit) continue
    const evidence = commits[plugin.id] ?? []
    if (!evidence.some((item) => item.commit === plugin.commit)) {
      const backingEvent = events.find((event) => {
        if (
          event.seq > throughSeq ||
          (event.type !== "plugin.workspace.initialized" && event.type !== "plugin.workspace.committed")
        ) {
          return false
        }
        const data = event.data as { pluginId?: unknown; commit?: unknown; importedHead?: unknown }
        return data.pluginId === plugin.id && (data.commit === plugin.commit || data.importedHead === plugin.commit)
      })
      if (!backingEvent) throw new Error(`Plugin pin has no committed workspace Event: ${plugin.id}`)
      evidence.push({ commit: plugin.commit, eventId: backingEvent.id })
      commits[plugin.id] = evidence
    }
  }
  return commits
}

export function collectPluginCommits(
  events: LedgerEvent[],
  afterSeq: number,
  throughSeq = Number.POSITIVE_INFINITY,
): Record<string, CommitEvidence[]> {
  const commits: Record<string, CommitEvidence[]> = {}
  for (const event of events) {
    if (
      event.seq <= afterSeq ||
      event.seq > throughSeq ||
      event.scope.kind !== "active" ||
      (event.type !== "plugin.workspace.initialized" && event.type !== "plugin.workspace.committed")
    ) {
      continue
    }
    const data = event.data as { pluginId?: unknown; commit?: unknown }
    if (typeof data.pluginId !== "string" || typeof data.commit !== "string") continue
    const pluginCommits = commits[data.pluginId] ?? []
    commits[data.pluginId] = pluginCommits
    pluginCommits.push({ commit: data.commit, eventId: event.id })
  }
  return commits
}

export function mergeWorkspaceCommits(
  ...groups: Array<Record<string, CommitEvidence[]>>
): Record<string, CommitEvidence[]> {
  const merged: Record<string, CommitEvidence[]> = {}
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
