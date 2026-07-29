import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentRuntime, GitWorkspaceStore, Ledger, Swarm } from "../src/index.js"

export async function createFixture(t) {
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
  const definition = {
    agents: [
      { id: "builder", harness: "scripted" },
      { id: "reviewer", harness: "scripted" },
    ],
    routes: [{ on: "test.requested", to: "builder" }],
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

function workspaceSeed(initialContext) {
  return {
    "AGENTS.md": "Own this workspace. Improve it only from committed high-level Events.\n",
    "context.ts": `export default async function compose({ read, inputEvents }) {
  return [
    { role: "system", content: await read("AGENTS.md") },
    { role: "user", content: await read("context/initial.md") },
    { role: "user", content: "composer:v1" },
    { role: "user", content: JSON.stringify(inputEvents) },
  ]
}
`,
    "context/initial.md": `${initialContext}\n`,
    "memory/README.md": "Durable Agent-authored memory.\n",
    "skills/README.md": "Reusable Agent-authored procedures.\n",
  }
}

class ScriptedHarnessAdapter {
  id = "scripted"
  runs = []

  async run({ turnId, scope, workingDirectory, inputEvents, context }) {
    this.runs.push({
      context,
    })
    if (inputEvents[0].type === "improvement.requested") {
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
      events: [
        {
          type: "work.completed",
          data: { identity, input: inputEvents[0].data },
        },
      ],
      trajectory: {
        harness: this.id,
        sessionRef: `session/${identity}`,
        range: { from: `${turnId}/start`, to: `${turnId}/end` },
        digest: `trajectory/${turnId}`,
      },
    }
  }
}
