import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TestContext } from "node:test"
import {
  AgentRuntime,
  GitWorkspaceStore,
  Ledger,
  Swarm,
  type ContextMessage,
  type HarnessAdapter,
  type HarnessInput,
  type HarnessResult,
  type SwarmDefinition,
  type WorkspaceFiles,
} from "../src/index.ts"

export async function createFixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "corallum-"))
  t.after(() => rm(root, { recursive: true, force: true }))

  const workspaces = new GitWorkspaceStore(join(root, "workspaces"))
  const initial = await workspaces.initialize("builder", workspaceSeed("Build and improve the requested behavior."))
  const reviewerInitial = await workspaces.initialize(
    "reviewer",
    workspaceSeed("Review evidence and improve your own procedure."),
  )
  const ledger = new Ledger()
  const adapter = new ScriptedHarnessAdapter()
  const agentRuntime = new AgentRuntime({ ledger, workspaces, adapters: [adapter] })
  const swarm = new Swarm({ ledger, agentRuntime })
  const definition: SwarmDefinition = {
    agents: [
      { id: "builder", harness: "scripted" },
      { id: "reviewer", harness: "scripted" },
    ],
    routes: [
      { on: "test.requested", to: "builder" },
      { on: "review.requested", to: "reviewer" },
    ],
    externalChannels: [{ plugin: "chat", ingressTo: "builder", egressFrom: ["builder"] }],
    plugins: [{ id: "chat", version: "1", digest: "chat-v1", mode: "live" }],
    tests: [
      {
        id: "core-behavior",
        inputEvents: [{ type: "test.requested", data: { task: "improve the same behavior" } }],
        expect: { eventType: "work.completed" },
      },
    ],
  }
  const revision = swarm.bootstrap({
    definition,
    agentHeads: { builder: initial.commit, reviewer: reviewerInitial.commit },
    human: "owner",
  })
  return { root, workspaces, ledger, adapter, swarm, definition, initial, reviewerInitial, revision }
}

export function workspaceSeed(initialContext: string): WorkspaceFiles {
  return {
    "AGENTS.md": "Own this workspace. Improve it only from committed high-level Events.\n",
    "context.ts": `export default async function compose({ read, inputEvents, swarm }) {
  return [
    { role: "system", content: await read("AGENTS.md") },
    { role: "system", content: renderSwarm(swarm) },
    { role: "user", content: await read("context/initial.md") },
    { role: "user", content: "composer:v1" },
    { role: "user", content: JSON.stringify(inputEvents) },
  ]
}

function renderSwarm(swarm) {
  const agents = swarm.agents.map((agent) => {
    const label = agent.self ? \`\${agent.id} (you)\` : agent.id
    const receives = agent.receives.length > 0 ? agent.receives.join(", ") : "no routed Events"
    return \`- \${label}: receives \${receives}\${agent.externalFacing ? "; external-facing" : ""}\`
  })
  const routes = swarm.routes.map((route) => \`- \${route.event} -> \${route.to}\`)
  const plugins = swarm.plugins.map((plugin) => \`- \${plugin.id} (\${plugin.mode})\`)
  return [
    "# Current Swarm",
    \`You are: \${swarm.self}\`,
    \`Source: \${swarm.source.kind}/\${swarm.source.id}\`,
    \`Scope: \${swarm.scope.kind}\`,
    "",
    "Agents:",
    ...agents,
    "",
    "Routing:",
    ...routes,
    "",
    "Plugins:",
    ...plugins,
  ].join("\\n")
}
`,
    "context/initial.md": `${initialContext}\n`,
    "memory/README.md": "Durable Agent-authored memory.\n",
    "skills/README.md": "Reusable Agent-authored procedures.\n",
  }
}

export interface RecordedRun {
  agentId: string
  context: ContextMessage[]
}

class ScriptedHarnessAdapter implements HarnessAdapter {
  readonly id = "scripted"
  readonly runs: RecordedRun[] = []

  async run({ turnId, agentId, scope, workingDirectory, inputEvents, context }: HarnessInput): Promise<HarnessResult> {
    this.runs.push({ agentId, context })
    if (inputEvents[0]?.type === "improvement.requested") {
      await appendFile(join(workingDirectory, "AGENTS.md"), "Evolved responsibility: verify the result.\n")
      await appendFile(join(workingDirectory, "context", "initial.md"), "Use evidence from prior Events.\n")
      const composerPath = join(workingDirectory, "context.ts")
      const composer = await readFile(composerPath, "utf8")
      await writeFile(composerPath, composer.replace("composer:v1", "composer:v2"), "utf8")
    }
    await mkdir(join(workingDirectory, "memory"), { recursive: true })
    const identity = scope.kind === "fork" ? scope.forkId : "agent"
    await writeFile(join(workingDirectory, "memory", "last-run.txt"), `${identity}\n`, "utf8")
    return {
      outcome: "completed",
      events: [{ type: "work.completed", data: { identity, input: inputEvents[0]?.data } }],
      trajectory: {
        harness: this.id,
        sessionRef: `session/${identity}`,
        range: { from: `${turnId}/start`, to: `${turnId}/end` },
        digest: `trajectory/${turnId}`,
      },
    }
  }
}

export function contextText(run: RecordedRun): string {
  return run.context.map((message) => message.content).join("\n")
}
