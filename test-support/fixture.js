import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentRuntime, GitWorkspaceStore, Ledger, Swarm } from "../src/index.js"

export async function createFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "verifiable-swarm-"))
  t.after(() => rm(root, { recursive: true, force: true }))

  const workspaces = new GitWorkspaceStore(join(root, "workspaces"))
  const initial = await workspaces.initialize("builder", {
    "AGENTS.md": "Own this workspace. Improve it only from committed high-level Events.\n",
  })
  const ledger = new Ledger()
  const adapter = new ScriptedHarnessAdapter()
  const agentRuntime = new AgentRuntime({ ledger, workspaces, adapters: [adapter] })
  const swarm = new Swarm({ ledger, agentRuntime, workspaces })
  const definition = {
    agents: [{ id: "builder", harness: "scripted" }],
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
    agentHeads: { builder: initial.commit },
    human: "owner",
  })
  return { root, workspaces, ledger, adapter, swarm, definition, initial, revision }
}

class ScriptedHarnessAdapter {
  id = "scripted"

  async run({ turnId, scope, workingDirectory, inputEvents }) {
    await mkdir(join(workingDirectory, "memory"), { recursive: true })
    const identity = scope.kind === "fork" ? scope.forkId : "agent-draft"
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
