import type { LedgerEvent } from "../../core/ledger/ledger.ts"
import type { SwarmDefinition } from "../../core/swarm/definition.ts"
import type { DefaultViewModel, EvolutionNodeView } from "./project.ts"
import { escapeHtml, formatTime, shortId } from "./html.ts"

type VisualKind = EvolutionNodeView["kind"] | "continuation"

interface VisualNode {
  id: string
  sourceId: string
  kind: VisualKind
  status: string
  seq: number
  lane: number
  label: string
  detail: string
  metrics: string[]
  parents: string[]
}

interface TimelineContext {
  definition: SwarmDefinition
  heads: Record<string, string>
  start: number
  end: number
  scope: "active" | string
  next: string
}

export function evolutionCanvas(model: DefaultViewModel): string {
  const nodes = evolutionNodes(model)
  const columns = [...new Set(nodes.map((node) => node.seq))].sort((a, b) => a - b)
  const positions = new Map(nodes.map((node) => [node.id, {
    x: 140 + columns.indexOf(node.seq) * 250,
    y: 180 + node.lane * 220,
  }]))
  const width = Math.max(1240, 300 + columns.length * 250)
  const height = Math.max(650, 360 + Math.max(...nodes.map((node) => node.lane)) * 220)
  const edges = nodes.flatMap((node) => node.parents.map((parentId) => {
    const from = positions.get(parentId)
    const to = positions.get(node.id)
    if (!from || !to) return ""
    const middle = (from.x + to.x) / 2
    return `<path class="evolution-edge" d="M${from.x} ${from.y} C${middle} ${from.y} ${middle} ${to.y} ${to.x} ${to.y}"/>`
  })).join("")
  const buttons = nodes.map((node) => evolutionNode(node, positions.get(node.id)!, Boolean(timelineContext(model, node)))).join("")
  const details = nodes.map((node) => {
    const context = timelineContext(model, node)
    return context ? timelineDetail(model, node, context) : ""
  }).join("")
  return `<div class="canvas-shell" data-evolution-canvas>
    <div class="canvas-tools"><button type="button" data-canvas-action="out" aria-label="Zoom out">−</button><button type="button" data-canvas-action="in" aria-label="Zoom in">+</button><button type="button" data-canvas-action="fit">Fit</button></div>
    <div class="evolution-viewport" data-evolution-viewport tabindex="0" aria-label="Interactive Swarm evolution canvas">
      <div class="evolution-plane" data-evolution-plane style="width:${width}px;height:${height}px">
        <div class="overview-layer" data-overview-layer data-width="${width}" data-height="${height}"><svg viewBox="0 0 ${width} ${height}" aria-hidden="true">${edges}</svg>${buttons}</div>
        ${details}
      </div>
    </div>
  </div>`
}

function evolutionNodes(model: DefaultViewModel): VisualNode[] {
  const ordered = [...model.evolution].sort((left, right) => left.seq - right.seq)
  const labels = new Map<string, string>()
  for (const kind of ["revision", "proposal", "fork", "decision"] as const) {
    ordered.filter((node) => node.kind === kind).forEach((node, index) => labels.set(node.id,
      kind === "revision" ? `Revision ${index + 1}` : kind === "fork" ? `Evaluation F${index + 1}` : `${kind === "proposal" ? "P" : "D"}${index + 1}`,
    ))
  }
  const nodes: VisualNode[] = ordered.map((node) => ({
    id: node.id,
    sourceId: node.id,
    kind: node.kind,
    status: node.status,
    seq: node.seq,
    lane: node.lane,
    label: labels.get(node.id)!,
    detail: node.detail,
    metrics: node.metrics,
    parents: node.parentId ? [node.parentId] : [],
  }))
  for (const proposal of model.proposals) {
    const base = model.revisions.find((revision) => revision.id === proposal.baseRevision)
    if (!base) continue
    const forks = model.forks.filter((fork) => fork.sourceKind === "proposal" && fork.sourceId === proposal.id)
    const activated = model.revisions.find((revision) => revision.sourceProposalId === proposal.id)
    const id = `continuation:${proposal.id}`
    nodes.push({
      id,
      sourceId: proposal.id,
      kind: "continuation",
      status: activated ? "merged" : "running",
      seq: Math.min(...forks.map((fork) => fork.seq), activated?.seq ?? proposal.seq + 1),
      lane: 0,
      label: `${labels.get(base.id) ?? "Main"} Main`,
      detail: "Main continues while Proposal evaluation runs",
      metrics: [activated ? `merged into ${labels.get(activated.id) ?? "next Revision"}` : "still running"],
      parents: [proposal.id],
    })
    const revisionNode = activated ? nodes.find((node) => node.id === activated.id) : undefined
    revisionNode?.parents.push(id)
  }
  return nodes.sort((left, right) => left.seq - right.seq || left.lane - right.lane)
}

function evolutionNode(node: VisualNode, point: { x: number; y: number }, hasDetail: boolean): string {
  const control = node.kind === "proposal" || node.kind === "decision"
  const width = control ? 86 : 200
  const height = control ? 86 : 120
  const attributes = `data-evolution-node data-node-id="${escapeHtml(node.id)}" data-node-x="${point.x}" data-node-y="${point.y}" data-node-width="${width}" data-node-height="${height}" ${hasDetail ? "data-detail-id=\"" + escapeHtml(node.id) + "\"" : ""}`
  if (control) return `<button class="evolution-node control-node ${escapeHtml(node.kind)} ${escapeHtml(node.status)}" style="left:${point.x - 43}px;top:${point.y - 43}px" ${attributes} data-dialog-title="${escapeHtml(node.label)}" data-dialog-meta="#${node.seq} · ${escapeHtml(node.status)}" data-dialog-detail="${escapeHtml(node.detail)}"><span><b>${escapeHtml(node.label)}</b><small>${escapeHtml(node.status)}</small></span></button>`
  return `<button class="evolution-node state-node ${escapeHtml(node.kind)} ${escapeHtml(node.status)}" style="left:${point.x - 100}px;top:${point.y - 60}px" ${attributes}><span class="node-kind">${escapeHtml(node.kind === "continuation" ? "Main continuation" : node.kind === "fork" ? "Temporary evaluation" : "Formal state")}</span><strong>${escapeHtml(node.label)}</strong><small>${escapeHtml(node.status)} · #${node.seq}</small><span class="node-metrics">${node.metrics.slice(0, 2).map(escapeHtml).join(" · ")}</span></button>`
}

function timelineContext(model: DefaultViewModel, node: VisualNode): TimelineContext | null {
  const lastSeq = model.events.at(-1)?.seq ?? node.seq
  if (node.kind === "revision") {
    const revision = model.revisions.find((item) => item.id === node.sourceId)
    if (!revision) return null
    const next = nextChild(model, revision.id, revision.seq)
    return { definition: revision.definition, heads: revision.agentHeads, start: revision.seq, end: next?.seq ?? lastSeq, scope: "active", next: next ? nodeKind(next.kind) : "Now" }
  }
  if (node.kind === "continuation") {
    const proposal = model.proposals.find((item) => item.id === node.sourceId)
    const base = proposal && model.revisions.find((item) => item.id === proposal.baseRevision)
    if (!proposal || !base) return null
    const activated = model.revisions.find((item) => item.sourceProposalId === proposal.id)
    return { definition: base.definition, heads: proposalHeads(base.agentHeads, proposal.workspaceCommits), start: proposal.seq, end: activated?.seq ?? lastSeq, scope: "active", next: activated ? "Activation" : "Now" }
  }
  if (node.kind === "fork") {
    const fork = model.forks.find((item) => item.id === node.sourceId)
    if (!fork) return null
    const proposal = fork.sourceKind === "proposal" ? model.proposals.find((item) => item.id === fork.sourceId) : undefined
    const revision = proposal ? model.revisions.find((item) => item.id === proposal.baseRevision) : model.revisions.find((item) => item.id === fork.sourceId)
    if (!revision) return null
    const next = nextChild(model, fork.id, fork.seq)
    return {
      definition: proposal?.definition ?? revision.definition,
      heads: proposal ? proposalHeads(revision.agentHeads, proposal.workspaceCommits) : revision.agentHeads,
      start: fork.seq,
      end: next?.seq ?? lastSeq,
      scope: fork.id,
      next: next ? nodeKind(next.kind) : "Now",
    }
  }
  return null
}

function nextChild(model: DefaultViewModel, parentId: string, after: number): EvolutionNodeView | undefined {
  return model.evolution
    .filter((item) => item.parentId === parentId && item.seq > after)
    .sort((left, right) => left.seq - right.seq)[0]
}

function nodeKind(kind: EvolutionNodeView["kind"]): string {
  if (kind === "proposal") return "Proposal"
  if (kind === "fork") return "Evaluation"
  if (kind === "decision") return "Decision"
  return "Revision"
}

function proposalHeads(base: Record<string, string>, commits: Record<string, Array<{ commit: string }>>): Record<string, string> {
  return Object.fromEntries(Object.entries(base).map(([agentId, head]) => [agentId, commits[agentId]?.at(-1)?.commit ?? head]))
}

function timelineDetail(model: DefaultViewModel, node: VisualNode, context: TimelineContext): string {
  const resources = [
    ...context.definition.agents.map((agent) => ({ id: agent.id, kind: "Agent", initial: context.heads[agent.id] ?? "—" })),
    ...context.definition.plugins.map((plugin) => ({ id: plugin.id, kind: "Plugin", initial: plugin.commit })),
  ]
  const events = model.events.filter((event) => event.seq > context.start && event.seq <= context.end && eventScope(event) === context.scope)
  const width = 2480
  const height = Math.max(920, 300 + resources.length * 88)
  const span = Math.max(1, context.end - context.start)
  const lanes = resources.map((resource, index) => {
    const y = 320 + index * 88
    const commits = events.filter((event) => commitOwner(event) === resource.id).map((event) => {
      const data = recordData(event)
      const x = 760 + (event.seq - context.start) / span * 1420
      const commit = typeof data.commit === "string" ? data.commit : event.id
      const message = typeof data.message === "string" ? data.message : event.type
      return `<button class="commit-node" style="left:${x - 190}px;top:-10px" data-dialog-title="${escapeHtml(resource.id)} · ${escapeHtml(shortId(commit))}" data-dialog-meta="#${event.seq} · ${escapeHtml(event.actor)} · ${escapeHtml(formatTime(event.recordedAt))}" data-dialog-detail="${escapeHtml(message)}"><i></i><span>${escapeHtml(shortId(commit))}</span></button>`
    }).join("")
    return `<div class="timeline-lane" style="top:${y}px"><span class="resource-label"><small>${resource.kind}</small><strong>${escapeHtml(resource.id)}</strong></span><code class="initial-head">${escapeHtml(shortId(resource.initial))}</code><i class="lane-line"></i><i class="initial-mark"></i>${commits}</div>`
  }).join("")
  return `<div class="timeline-detail" data-detail-layer="${escapeHtml(node.id)}" data-width="${width}" data-height="${height}" style="width:${width}px;height:${height}px" hidden>
    <button class="back-button" type="button" data-detail-back>‹ Revision map</button>
    <header><p class="eyebrow">${escapeHtml(node.kind === "fork" ? "Temporary evaluation" : node.kind === "continuation" ? "Main continuation" : "Formal state")}</p><h3>${escapeHtml(node.label)}</h3><p>${escapeHtml(node.detail)} · Ledger #${context.start}–#${context.end}</p>${timelineActions(model, node)}</header>
    <div class="timeline-columns"><span>Resource</span><span>Start head</span><span>Timeline</span><strong>${escapeHtml(context.next)}</strong></div>
    <i class="timeline-axis"></i><i class="timeline-next"></i>${lanes}
  </div>`
}

function timelineActions(model: DefaultViewModel, node: VisualNode): string {
  if (node.kind === "revision") return `<form method="post" action="/fork"><input type="hidden" name="sourceId" value="${escapeHtml(node.sourceId)}"><button class="button quiet" type="submit">Fork this Revision</button></form>`
  if (node.kind !== "fork") return ""
  const fork = model.forks.find((item) => item.id === node.sourceId)
  if (!fork || fork.status !== "open") return ""
  return `<div class="decision-actions"><form method="post" action="/approve"><input type="hidden" name="forkId" value="${escapeHtml(fork.id)}"><input type="hidden" name="frontier" value="${fork.frontier}"><button class="button" type="submit">Approve</button></form><form method="post" action="/deny"><input type="hidden" name="forkId" value="${escapeHtml(fork.id)}"><input type="hidden" name="frontier" value="${fork.frontier}"><button class="button danger-button" type="submit">Deny</button></form></div>`
}

function commitOwner(event: LedgerEvent): string | null {
  if (event.type !== "agent.workspace.committed" && event.type !== "plugin.workspace.committed") return null
  const data = recordData(event)
  if (typeof data.agentId === "string") return data.agentId
  if (typeof data.pluginId === "string") return data.pluginId
  return null
}

function eventScope(event: LedgerEvent): string {
  return event.scope.kind === "active" ? "active" : event.scope.forkId
}

function recordData(event: LedgerEvent): Record<string, unknown> {
  return event.data && typeof event.data === "object" ? event.data as Record<string, unknown> : {}
}
