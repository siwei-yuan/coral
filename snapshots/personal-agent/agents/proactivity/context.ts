export default async function compose({ read, inputEvents, swarm }) {
  return [
    { role: "system", content: await read("AGENTS.md") },
    { role: "system", content: renderSwarm(swarm) },
    { role: "user", content: await read("context/initial.md") },
    { role: "user", content: JSON.stringify(inputEvents) },
  ]
}

function renderSwarm(swarm) {
  const agents = swarm.agents.map((agent) => {
    const label = agent.self ? `${agent.id} (you)` : agent.id
    const receives = agent.receives.length > 0 ? agent.receives.join(", ") : "nobody"
    const sendsTo = agent.sendsTo.length > 0 ? agent.sendsTo.join(", ") : "nobody"
    const pluginIngress = agent.receivesFromPlugins.length > 0
      ? `; Plugin ingress: ${agent.receivesFromPlugins.join(", ")}`
      : ""
    return `- ${label}: receives from ${receives}; sends to ${sendsTo}${pluginIngress}`
  })
  const routes = swarm.routes.map((route) => `- ${route.from} -> ${route.to}`)
  const plugins = swarm.plugins.map((plugin) => `- ${plugin.id}: ${plugin.command} (${plugin.mode})`)
  return [
    "# Current Swarm",
    `You are: ${swarm.self}`,
    `Source: ${swarm.source.kind}/${swarm.source.id}`,
    `Scope: ${swarm.scope.kind}`,
    "",
    "Agents:",
    ...agents,
    "",
    "Routing:",
    ...routes,
    "",
    "Plugins:",
    ...plugins,
  ].join("\n")
}

