import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { TestContext } from "node:test"
import {
  AgentRuntime,
  GitWorkspaceStore,
  Ledger,
  PluginWorkspaceRuntime,
  Swarm,
  type ContextMessage,
  type HarnessAdapter,
  type HarnessCheckpoint,
  type HarnessCommand,
  type HarnessInput,
  type HarnessPluginWorkspace,
  type HarnessResult,
  type SwarmDefinition,
  type SwarmProposal,
  type WorkspaceFiles,
} from "../src/index.ts"

const execute = promisify(execFile)

export async function createFixture(
  t: TestContext,
  { pluginAgents = ["builder"] }: { pluginAgents?: string[] } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "coral-"))
  t.after(() => rm(root, { recursive: true, force: true }))

  const workspaces = new GitWorkspaceStore(join(root, "workspaces"))
  const pluginGit = new GitWorkspaceStore(join(root, "plugin-workspaces"))
  const ledger = Ledger.memory()
  const pluginWorkspaces = new PluginWorkspaceRuntime({ ledger, workspaces: pluginGit })
  const adapter = new ScriptedHarnessAdapter()
  const agentRuntime = new AgentRuntime({ ledger, workspaces, adapters: [adapter], pluginWorkspaces })
  const initial = await agentRuntime.initializeWorkspace(
    "builder",
    workspaceSeed("Build and improve the requested behavior."),
  )
  const reviewerInitial = await agentRuntime.initializeWorkspace(
    "reviewer",
    workspaceSeed("Review evidence and improve your own procedure."),
  )
  const chatInitial = await pluginWorkspaces.initialize("chat", pluginSeed("chat"))
  const swarm = new Swarm({
    ledger,
    agentRuntime,
  })
  const definition: SwarmDefinition = {
    agents: [
      { id: "builder", harness: "scripted", model: "scripted-v1", turnPolicy: "batch-events" },
      { id: "reviewer", harness: "scripted", model: "scripted-v1", turnPolicy: "single-event" },
    ],
    routes: [{ from: "builder", to: "reviewer" }],
    pluginIngress: [{ plugin: "chat", ingressTo: "builder" }],
    plugins: [{
      id: "chat",
      command: "chat",
      commit: chatInitial.commit,
      exposedTo: pluginAgents,
      mode: "live",
    }],
    tests: [
      {
        id: "core-behavior",
        inputEvents: [
          {
            type: "communication.sent",
            data: {
              from: "test/core-behavior",
              to: ["agent/builder"],
              content: [{ type: "text", text: "improve the same behavior" }],
              command: "improve-agent",
            },
          },
        ],
        expect: { eventType: "agent.turn.recorded" },
      },
    ],
  }
  const revision = await swarm.bootstrap({
    definition,
    agentHeads: { builder: initial.commit, reviewer: reviewerInitial.commit },
    human: "owner",
  })
  return {
    root,
    workspaces,
    pluginGit,
    pluginWorkspaces,
    chatInitial,
    ledger,
    adapter,
    agentRuntime,
    swarm,
    definition,
    initial,
    reviewerInitial,
    revision,
  }
}

export function pluginSeed(id: string): WorkspaceFiles {
  return {
    [`bin/${id}.mjs`]: `#!/usr/bin/env node\nconsole.log(${JSON.stringify(`${id}:v1`)})\n`,
    "runtime.mjs": runtimeSource(`${id}:v1`),
    "prompt.md": `# ${id}\n\nUse this capability deliberately.\n`,
  }
}

export function userMessage(agentId: string, text: string, data: Record<string, unknown> = {}) {
  return {
    type: "communication.sent" as const,
    actor: "external/user",
    data: {
      from: "external/user",
      to: [`agent/${agentId}`],
      content: [{ type: "text", text }],
      ...data,
    },
  }
}

export async function proposeFromAgent(
  swarm: Swarm,
  {
    agentId = "builder",
    definition = swarm.activeRevision().definition,
    addedAgentHeads = {},
  }: {
    agentId?: string
    definition?: SwarmDefinition
    addedAgentHeads?: Record<string, string>
  } = {},
): Promise<SwarmProposal> {
  const input = swarm.appendInput(userMessage(agentId, "Propose this Swarm Definition.", {
    proposalDefinition: definition,
    proposalAddedAgentHeads: addedAgentHeads,
  }))
  const result = await swarm.runAgentTurn({ agentId, inputEventIds: [input.id] })
  const event = swarm.ledger.all().findLast((candidate) =>
    candidate.type === "swarm.revision.proposed" && candidate.causation.includes(result.turnEvent.id),
  )
  const proposalId = (event?.data as { proposalId?: unknown } | undefined)?.proposalId
  if (typeof proposalId !== "string") throw new Error("Agent turn created no Swarm Proposal")
  return swarm.proposal(proposalId)
}

export function workspaceSeed(initialContext: string): WorkspaceFiles {
  return {
    "AGENTS.md": "Own this workspace. Improve it only from committed high-level Events.\n",
    "context.ts": `export default async function compose({ read, inputEvents, swarm, plugins = [] }) {
  return [
    { role: "system", content: await read("AGENTS.md") },
    { role: "system", content: renderSwarm(swarm) },
    ...plugins.map((plugin) => ({ role: "system", content: plugin.instructions + "\\n" + plugin.workspace.directory })),
    { role: "user", content: await read("context/initial.md") },
    { role: "user", content: "composer:v1" },
    { role: "user", content: JSON.stringify(inputEvents) },
  ]
}

function renderSwarm(swarm) {
  const agents = swarm.agents.map((agent) => {
    const label = agent.self ? \`\${agent.id} (you)\` : agent.id
    const receives = agent.receives.length > 0 ? agent.receives.join(", ") : "nobody"
    const sendsTo = agent.sendsTo.length > 0 ? agent.sendsTo.join(", ") : "nobody"
    const pluginIngress = agent.receivesFromPlugins.length > 0 ? \`; Plugin ingress: \${agent.receivesFromPlugins.join(", ")}\` : ""
    const effort = agent.effort ? \` · \${agent.effort}\` : ""
    return \`- \${label}: \${agent.harness} · \${agent.model}\${effort}; receives from \${receives}; sends to \${sendsTo}\${pluginIngress}\`
  })
  const routes = swarm.routes.map((route) => \`- \${route.from} -> \${route.to}\`)
  const plugins = swarm.plugins.map((plugin) => \`- \${plugin.id}: \${plugin.command} (\${plugin.mode})\`)
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
  commands: HarnessCommand[]
  pluginWorkspaces: HarnessPluginWorkspace[]
  checkpoint?: HarnessCheckpoint
  forkSession: boolean
}

interface Gate {
  promise: Promise<void>
  resolve(): void
}

class ScriptedHarnessAdapter implements HarnessAdapter {
  readonly id = "scripted"
  readonly runs: RecordedRun[] = []
  #blocked = new Map<string, Gate[]>()
  #sessions = 0

  blockNext(agentId: string): () => void {
    let release = () => {}
    const gate = { promise: new Promise<void>((resolve) => { release = resolve }), resolve: () => release() }
    const blocked = this.#blocked.get(agentId) ?? []
    blocked.push(gate)
    this.#blocked.set(agentId, blocked)
    return gate.resolve
  }

  async run(input: HarnessInput): Promise<HarnessResult> {
    const { turnId, workingDirectory, context, commands, pluginWorkspaces, peerWorkspaces } = input
    const inputEvents = contextInputEvents(context)
    const event = inputEvents[0]
    const data = (event?.data ?? {}) as {
      command?: string
      pluginId?: string
      version?: string
      forwardTo?: string
      readPeer?: string
      readPath?: string
      proposalDefinition?: SwarmDefinition
      proposalAddedAgentHeads?: Record<string, string>
    }
    const core = commands.find((command) => command.id === "coral")!
    const agentId = core.env!.CORAL_AGENT_ID!
    this.runs.push({
      agentId,
      context,
      commands,
      pluginWorkspaces,
      ...(input.checkpoint ? { checkpoint: input.checkpoint } : {}),
      forkSession: input.forkSession,
    })
    const gate = this.#blocked.get(agentId)?.shift()
    if (gate) await gate.promise
    if (data.command === "improve-plugin") {
      const plugin = pluginWorkspaces.find((workspace) => workspace.id === data.pluginId)
      if (!plugin?.writable) throw new Error(`Plugin workspace is not writable: ${data.pluginId}`)
      await writeFile(join(plugin.directory, "runtime.mjs"), runtimeSource(data.version ?? "unknown"))
      await commitWorkspace(plugin.directory, `Update ${data.pluginId} to ${data.version}`)
    }
    if (data.command === "improve-agent") {
      await appendFile(join(workingDirectory, "AGENTS.md"), "Evolved responsibility: verify the result.\n")
      await appendFile(join(workingDirectory, "context", "initial.md"), "Use evidence from prior Events.\n")
      const composerPath = join(workingDirectory, "context.ts")
      const composer = await readFile(composerPath, "utf8")
      await writeFile(composerPath, composer.replace("composer:v1", "composer:v2"), "utf8")
    }
    if (data.command === "two-agent-commits") {
      await writeFile(join(workingDirectory, "memory", "first.txt"), "first\n", "utf8")
      await commitWorkspace(workingDirectory, "Record the first learning")
      await writeFile(join(workingDirectory, "memory", "second.txt"), "second\n", "utf8")
      await commitWorkspace(workingDirectory, "Record the second learning")
    }
    await mkdir(join(workingDirectory, "memory"), { recursive: true })
    if (data.command === "continue-main") {
      await writeFile(join(workingDirectory, "memory", "main-tail.txt"), "continued on Main\n", "utf8")
    }
    const identity = event?.scope.kind === "fork" ? event.scope.forkId : "agent"
    if (event?.scope.kind === "fork" && data.command !== "continue-main") {
      await writeFile(join(workingDirectory, "memory", "last-run.txt"), `${identity}\n`, "utf8")
    }
    const peer = data.readPeer ? peerWorkspaces.find((workspace) => workspace.agentId === data.readPeer) : undefined
    const peerContent = peer ? await readFile(join(peer.directory, data.readPath ?? "AGENTS.md"), "utf8") : undefined
    if (data.proposalDefinition) {
      const proposal = join(dirname(core.env!.CORAL_ACTIONS_FILE!), "proposal.json")
      await writeFile(proposal, JSON.stringify({
        definition: data.proposalDefinition,
        addedAgentHeads: data.proposalAddedAgentHeads ?? {},
      }))
      await execute(core.executable, [...(core.arguments ?? []), "propose", "--file", proposal], {
        env: { ...process.env, ...core.env },
      })
    } else if (data.forwardTo) {
      await execute(core.executable, [...(core.arguments ?? []),
        "send",
        "--to",
        data.forwardTo,
        "--text",
        peerContent ?? `completed by ${agentId}`,
      ], { env: { ...process.env, ...core.env } })
    }
    if (data.command !== "leave-dirty") {
      await commitWorkspace(workingDirectory, `Apply ${data.command ?? "turn"} learning`)
    } else {
      await writeFile(join(workingDirectory, "memory", "uncommitted.txt"), "not durable\n", "utf8")
    }
    const sessionId = input.checkpoint && !input.forkSession
      ? input.checkpoint.sessionId
      : `session-${++this.#sessions}`
    return {
      outcome: "completed",
      checkpoint: {
        harness: this.id,
        model: input.model,
        ...(input.effort ? { effort: input.effort } : {}),
        sessionId,
        turnId,
      },
    }
  }
}

async function commitWorkspace(directory: string, message: string): Promise<void> {
  const status = (await execute("git", ["-C", directory, "status", "--porcelain"])).stdout
  if (!status.trim()) return
  await execute("git", ["-C", directory, "add", "-A"])
  await execute("git", ["-C", directory, "commit", "-m", message], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Scripted Agent",
      GIT_AUTHOR_EMAIL: "agent@coral.local",
      GIT_COMMITTER_NAME: "Scripted Agent",
      GIT_COMMITTER_EMAIL: "agent@coral.local",
    },
  })
}

function runtimeSource(version: string): string {
  if (version === "chat:fail") return `export async function start() { throw new Error("Plugin runtime failed") }\n`
  return `import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
export const version = ${JSON.stringify(version)}
export async function start({ stateRoot }) {
  await mkdir(stateRoot, { recursive: true })
  await writeFile(join(stateRoot, "active-version.txt"), version)
  return { async stop() {} }
}
`
}

function contextInputEvents(context: ContextMessage[]): Array<{ scope: { kind: "active" } | { kind: "fork"; forkId: string }; data: unknown }> {
  for (const message of context.toReversed()) {
    try {
      const value = JSON.parse(message.content)
      if (Array.isArray(value)) return value
    } catch {}
  }
  throw new Error("Scripted Harness received no input Events")
}

export function contextText(run: RecordedRun): string {
  return run.context.map((message) => message.content).join("\n")
}
