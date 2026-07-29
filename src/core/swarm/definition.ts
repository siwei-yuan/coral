import { immutable } from "../canonical.ts"
import type { AgentDefinition } from "../agent/definition.ts"
import type { Scope } from "../ledger/ledger.ts"

export interface Route {
  from: string
  to: string
}

export interface PluginIngress {
  plugin: string
  ingressTo: string
}

export interface PluginBinding {
  id: string
  command: string
  exposedTo: string[]
  mode: string
}

export interface SwarmTest {
  id: string
  inputEvents: Array<{ type: string; schema?: string; data?: unknown }>
  expect: { eventType: string }
}

export interface SwarmDefinition {
  agents: AgentDefinition[]
  routes: Route[]
  pluginIngress: PluginIngress[]
  plugins: PluginBinding[]
  tests: SwarmTest[]
}

export interface AgentSwarmView {
  self: string
  source: { kind: "revision" | "proposal"; id: string }
  scope: Scope
  agents: Array<{
    id: string
    self: boolean
    receives: string[]
    sendsTo: string[]
    receivesFromPlugins: string[]
  }>
  routes: Route[]
  plugins: Array<{ id: string; command: string; mode: string }>
}

export function validateDefinition(definition: unknown): SwarmDefinition {
  if (!definition || typeof definition !== "object") throw new Error("Swarm Definition is required")
  const source = definition as Partial<SwarmDefinition>
  const copy = structuredClone({
    agents: source.agents ?? [],
    routes: source.routes ?? [],
    pluginIngress: source.pluginIngress ?? [],
    plugins: source.plugins ?? [],
    tests: source.tests ?? [],
  })
  const ids = new Set<string>()
  for (const agent of copy.agents) {
    if (!agent.id || !agent.harness) throw new Error("Every Agent requires id and harness")
    if (ids.has(agent.id)) throw new Error(`duplicate Agent: ${agent.id}`)
    ids.add(agent.id)
  }
  for (const route of copy.routes) {
    if (!ids.has(route.from) || !ids.has(route.to)) {
      throw new Error("Every communication route requires existing sender and receiver Agents")
    }
  }
  const pluginIds = new Set<string>()
  for (const plugin of copy.plugins) {
    if (!plugin.id || !plugin.command) throw new Error("Every Plugin requires id and command")
    if (pluginIds.has(plugin.id)) throw new Error(`duplicate Plugin: ${plugin.id}`)
    if (!Array.isArray(plugin.exposedTo) || plugin.exposedTo.some((agentId) => !ids.has(agentId))) {
      throw new Error("Plugin exposure Agents must exist")
    }
    pluginIds.add(plugin.id)
  }
  const ingressEdges = new Set<string>()
  for (const ingress of copy.pluginIngress) {
    if (!pluginIds.has(ingress.plugin) || !ids.has(ingress.ingressTo)) {
      throw new Error("Plugin ingress requires a Plugin and existing Agent")
    }
    const edge = `${ingress.plugin}\0${ingress.ingressTo}`
    if (ingressEdges.has(edge)) throw new Error(`duplicate Plugin ingress: ${ingress.plugin} -> ${ingress.ingressTo}`)
    ingressEdges.add(edge)
  }
  for (const test of copy.tests) {
    if (!test.id || !Array.isArray(test.inputEvents) || test.inputEvents.length === 0) {
      throw new Error("Every Swarm test requires id and input Events")
    }
    if (!test.expect?.eventType) throw new Error("Every Swarm test requires an expected Event type")
  }
  return immutable(copy)
}

export function findAgent(definition: SwarmDefinition, agentId: string): AgentDefinition {
  const agent = definition.agents.find((item) => item.id === agentId)
  if (!agent) throw new Error(`unknown Agent: ${agentId}`)
  return agent
}

export function projectAgentSwarmView(
  definition: SwarmDefinition,
  self: string,
  source: AgentSwarmView["source"],
  scope: Scope,
  pluginBindings: PluginBinding[],
): AgentSwarmView {
  findAgent(definition, self)
  return immutable({
    self,
    source,
    scope,
    agents: definition.agents.map((agent) => ({
      id: agent.id,
      self: agent.id === self,
      receives: definition.routes.filter((route) => route.to === agent.id).map((route) => route.from),
      sendsTo: definition.routes.filter((route) => route.from === agent.id).map((route) => route.to),
      receivesFromPlugins: definition.pluginIngress
        .filter((ingress) => ingress.ingressTo === agent.id)
        .map((ingress) => ingress.plugin)
        .filter((plugin, index, plugins) => plugins.indexOf(plugin) === index),
    })),
    routes: definition.routes,
    plugins: pluginBindings
      .filter((plugin) => plugin.exposedTo.includes(self))
      .map((plugin) => ({ id: plugin.id, command: plugin.command, mode: plugin.mode })),
  })
}
