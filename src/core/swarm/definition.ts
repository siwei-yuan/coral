import { immutable } from "../canonical.ts"
import type { AgentDefinition } from "../agent/definition.ts"
import type { Scope } from "../ledger/ledger.ts"

export interface Route {
  from: string
  to: string
}

export interface ExternalChannel {
  plugin: string
  ingressTo: string
  egressFrom: string[]
}

export interface PluginBinding {
  id: string
  version: string
  digest: string
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
  externalChannels: ExternalChannel[]
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
    externalFacing: boolean
  }>
  routes: Route[]
  plugins: Array<{ id: string; mode: string }>
}

export function validateDefinition(definition: unknown): SwarmDefinition {
  if (!definition || typeof definition !== "object") throw new Error("Swarm Definition is required")
  const source = definition as Partial<SwarmDefinition>
  const copy = structuredClone({
    agents: source.agents ?? [],
    routes: source.routes ?? [],
    externalChannels: source.externalChannels ?? [],
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
  for (const channel of copy.externalChannels) {
    if (!channel.plugin || !ids.has(channel.ingressTo)) {
      throw new Error("External channel requires a Plugin and existing ingress Agent")
    }
    if (!Array.isArray(channel.egressFrom) || channel.egressFrom.some((agentId) => !ids.has(agentId))) {
      throw new Error("External channel egress Agents must exist")
    }
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
      externalFacing: definition.externalChannels.some(
        (channel) => channel.ingressTo === agent.id || channel.egressFrom.includes(agent.id),
      ),
    })),
    routes: definition.routes,
    plugins: pluginBindings.map((plugin) => ({ id: plugin.id, mode: plugin.mode })),
  })
}
