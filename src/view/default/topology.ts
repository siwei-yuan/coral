import type { LedgerEvent } from "../../core/ledger/ledger.ts"
import type { SwarmDefinition } from "../../core/swarm/definition.ts"
import { escapeHtml, formatTime } from "./html.ts"

interface Point {
  x: number
  y: number
  w: number
  h: number
}

interface AgentRoute {
  from: string
  to: string
  directions: string[]
}

interface PluginRelation {
  pluginId: string
  agentId: string
  cli: boolean
  ingress: boolean
}

export function topologySector(definition: SwarmDefinition, events: LedgerEvent[]): string {
  const min = events.at(0)?.seq ?? 0
  const max = events.at(-1)?.seq ?? 0
  return `<div class="time-control" data-time-control>
    <div class="range-meta"><span data-range-start-label>${eventLabel(events.at(0))}</span><strong>Time range</strong><span data-range-end-label>${eventLabel(events.at(-1))}</span></div>
    <div class="range-row"><div class="dual-range"><i class="range-track"><b data-range-selection></b></i><input type="range" min="${min}" max="${max}" value="${min}" data-range-start aria-label="Start of Event time range"><input type="range" min="${min}" max="${max}" value="${max}" data-range-end aria-label="End of Event time range"></div><button class="button quiet play-button" type="button" data-play-routing>▶ Play routing</button></div>
  </div><div class="topology-layout" data-topology-sector><section class="topology-pane"><header class="pane-head"><strong>Swarm Topology</strong><small data-routing-status>Ready</small></header>${topology(definition)}</section><aside class="ledger-pane"><header class="pane-head"><strong>Event Ledger</strong><small data-ledger-range>#${min}–#${max}</small></header><ol class="event-ledger">${events.map(renderLedgerEvent).join("")}</ol></aside></div>`
}

function topology(definition: SwarmDefinition): string {
  const width = 920
  const height = Math.max(560, Math.max(definition.agents.length, definition.plugins.length) * 116 + 80)
  const agents = new Map(definition.agents.map((agent, index) => [agent.id, { x: 150, y: 48 + index * 116, w: 250, h: 78 }]))
  const plugins = new Map(definition.plugins.map((plugin, index) => [plugin.id, { x: 650, y: 48 + index * 116, w: 230, h: 78 }]))
  const routeEdges = agentRoutes(definition).map((route, index) => {
    const source = agents.get(route.from)!
    const target = agents.get(route.to)!
    const control = Math.max(24, 118 - index * 12)
    const forward = route.directions.includes(`${route.from}>${route.to}`)
    const reverse = route.directions.includes(`${route.to}>${route.from}`)
    const markers = `${reverse ? ' marker-start="url(#route-arrow)"' : ""}${forward ? ' marker-end="url(#route-arrow)"' : ""}`
    return `<path class="topology-edge agent-route" data-edge-from="${escapeHtml(route.from)}" data-edge-to="${escapeHtml(route.to)}" data-routes="${escapeHtml(route.directions.join(","))}"${markers} d="M${source.x} ${source.y + source.h / 2} C${control} ${source.y + source.h / 2} ${control} ${target.y + target.h / 2} ${target.x} ${target.y + target.h / 2}"/>`
  }).join("")
  const pluginEdges = pluginRelations(definition).map((relation) => {
    const plugin = plugins.get(relation.pluginId)!
    const agent = agents.get(relation.agentId)!
    const kinds = [relation.cli ? "CLI" : "", relation.ingress ? "ingress" : ""].filter(Boolean).join(" + ")
    const routes = relation.ingress ? `${relation.pluginId}>${relation.agentId}` : ""
    return `<path class="topology-edge plugin-relation" data-edge-from="${escapeHtml(relation.pluginId)}" data-edge-to="${escapeHtml(relation.agentId)}" data-routes="${escapeHtml(routes)}" data-relation="${escapeHtml(kinds)}" aria-label="${escapeHtml(`${relation.pluginId} and ${relation.agentId}: ${kinds}`)}" d="M${plugin.x} ${plugin.y + plugin.h / 2} C${plugin.x - 95} ${plugin.y + plugin.h / 2} ${agent.x + agent.w + 95} ${agent.y + agent.h / 2} ${agent.x + agent.w} ${agent.y + agent.h / 2}"/>`
  }).join("")
  const agentNodes = definition.agents.map((agent) => {
    const tools = definition.plugins.filter((plugin) => plugin.exposedTo.includes(agent.id)).map((plugin) => plugin.id)
    return topologyNode(agent.id, "Agent", tools.length ? `uses ${tools.join(" · ")}` : "no Plugin CLI", agents.get(agent.id)!)
  }).join("")
  const pluginNodes = definition.plugins.map((plugin) => {
    const relation = plugin.exposedTo.length === definition.agents.length
      ? "available to all Agents"
      : plugin.exposedTo.length > 2
        ? `available to ${plugin.exposedTo.length} Agents`
        : plugin.exposedTo.length
          ? `available to ${plugin.exposedTo.join(" · ")}`
          : "not exposed"
    return topologyNode(plugin.id, "Plugin", relation, plugins.get(plugin.id)!)
  }).join("")
  return `<div class="topology-viewport" data-topology-viewport><div class="topology-plane" data-topology-plane data-width="${width}" data-height="${height}" style="width:${width}px;height:${height}px"><svg class="topology-graph" viewBox="0 0 ${width} ${height}" role="img" aria-label="Agents with configured communication routes and Plugin access"><defs><marker id="route-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto-start-reverse"><path d="M0 0L7 3.5L0 7Z"/></marker></defs><g data-topology-edges>${routeEdges}${pluginEdges}</g>${agentNodes}${pluginNodes}<circle class="flow-dot" r="7" data-flow-dot></circle></svg></div></div>`
}

function agentRoutes(definition: SwarmDefinition): AgentRoute[] {
  const pairs = new Map<string, AgentRoute>()
  for (const route of definition.routes) {
    const [from, to] = [route.from, route.to].sort()
    const key = `${from}\0${to}`
    const pair = pairs.get(key) ?? { from: from!, to: to!, directions: [] }
    const direction = `${route.from}>${route.to}`
    if (!pair.directions.includes(direction)) pair.directions.push(direction)
    pairs.set(key, pair)
  }
  return [...pairs.values()]
}

function pluginRelations(definition: SwarmDefinition): PluginRelation[] {
  const relations = new Map<string, PluginRelation>()
  const relation = (pluginId: string, agentId: string): PluginRelation => {
    const key = `${pluginId}\0${agentId}`
    const current = relations.get(key) ?? { pluginId, agentId, cli: false, ingress: false }
    relations.set(key, current)
    return current
  }
  for (const plugin of definition.plugins) for (const agentId of plugin.exposedTo) relation(plugin.id, agentId).cli = true
  for (const binding of definition.pluginIngress) relation(binding.plugin, binding.ingressTo).ingress = true
  return [...relations.values()]
}

function topologyNode(id: string, kind: string, relation: string, point: Point): string {
  return `<g class="topology-node ${kind.toLowerCase()}" data-topology-node="${escapeHtml(id)}"><rect x="${point.x}" y="${point.y}" width="${point.w}" height="${point.h}" rx="18"/><text class="node-type" x="${point.x + 18}" y="${point.y + 22}">${kind.toUpperCase()}</text><text class="node-title" x="${point.x + 18}" y="${point.y + 46}">${escapeHtml(id)}</text><text class="node-relation" x="${point.x + 18}" y="${point.y + 65}">${escapeHtml(relation)}</text></g>`
}

function renderLedgerEvent(event: LedgerEvent): string {
  const targets = eventTargets(event)
  const owner = eventOwner(event)
  const scope = event.scope.kind === "active" ? "main" : event.scope.forkId
  return `<li><button type="button" data-ledger-event data-event-seq="${event.seq}" data-event-time="${escapeHtml(formatTime(event.recordedAt))}" data-actor-node="${escapeHtml(eventActor(event) ?? "")}" data-target-nodes="${escapeHtml(targets.join(","))}" data-owner-node="${escapeHtml(owner ?? "")}"><span class="sequence">#${event.seq}</span><time>${escapeHtml(formatTime(event.recordedAt))}</time><span><strong>${escapeHtml(event.type)}</strong><small>${escapeHtml(event.actor)} · ${escapeHtml(scope)}</small></span></button></li>`
}

function eventTargets(event: LedgerEvent): string[] {
  const data = recordData(event)
  if (event.type === "communication.sent") {
    const targets = Array.isArray(data.to) ? data.to : typeof data.to === "string" ? [data.to] : []
    return targets.filter((target): target is string => typeof target === "string").map(normalizeNode)
  }
  if (event.type === "plugin.workspace.committed" && typeof data.pluginId === "string") return [data.pluginId]
  if (event.type === "agent.workspace.reapplied" && typeof data.agentId === "string") return [data.agentId]
  return []
}

function eventActor(event: LedgerEvent): string | null {
  return event.actor.startsWith("agent/") || event.actor.startsWith("plugin/") ? normalizeNode(event.actor) : null
}

function eventOwner(event: LedgerEvent): string | null {
  const data = recordData(event)
  if (typeof data.agentId === "string") return data.agentId
  if (typeof data.pluginId === "string") return data.pluginId
  if (event.type === "communication.sent") return eventTargets(event)[0] ?? eventActor(event)
  return eventActor(event)
}

function recordData(event: LedgerEvent): Record<string, unknown> {
  return event.data && typeof event.data === "object" ? event.data as Record<string, unknown> : {}
}

function normalizeNode(value: string): string {
  return value.replace(/^(?:agent|plugin)\//, "")
}

function eventLabel(event: LedgerEvent | undefined): string {
  return event ? `#${event.seq} · ${escapeHtml(formatTime(event.recordedAt))}` : "No Events"
}
