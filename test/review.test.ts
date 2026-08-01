import assert from "node:assert/strict"
import { execFile as execFileCallback } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { promisify } from "node:util"
import { Ledger, activeScope, forkScope } from "../src/index.ts"

const execFile = promisify(execFileCallback)
const command = join(process.cwd(), "src/core/agent/command.mjs")

test("coral review filters Agent history without crossing a Fork boundary", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "coral-review-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, "ledger.jsonl")
  const ledger = Ledger.create(path)
  const first = ledger.append(communication(activeScope(), "external/user", ["agent/a"]))
  ledger.append(communication(activeScope(), "external/user", ["agent/a"]))
  const ownFork = ledger.append(communication(forkScope("f1"), "agent/a", ["agent/b"]))
  ledger.append(communication(forkScope("f2"), "agent/a", ["agent/b"]))
  ledger.close()

  const env = {
    ...process.env,
    CORAL_LEDGER_PATH: path,
    CORAL_AGENT_ID: "a",
    CORAL_SCOPE_KIND: "fork",
    CORAL_FORK_ID: "f1",
    CORAL_FORK_SOURCE_FRONTIER: String(first.seq),
  }
  const recent = await run(["review", "--agent", "self", "--recent", "--number", "30"], env)
  assert.deepEqual(recent.map((event: { id: string }) => event.id), [first.id, ownFork.id])
  const all = await run(["review", "--agent", "all", "--after", String(first.seq), "--number", "30"], env)
  assert.deepEqual(all.map((event: { id: string }) => event.id), [ownFork.id])
  const exact = await run(["review", "--event", ownFork.id], env)
  assert.equal(exact.data.from, "agent/a")
})

test("coral review resolves a Turn Event to its native Harness excerpt", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "coral-review-turn-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const ledgerPath = join(root, "ledger.jsonl")
  const ledger = Ledger.create(ledgerPath)
  const turn = ledger.append({
    type: "agent.turn.recorded",
    actor: "agent/runtime",
    scope: activeScope(),
    data: {
      agentId: "a",
      trajectory: {
        harness: "claude-code",
        model: "test-model",
        sessionId: "session-1",
        turnId: "turn-1",
      },
    },
  })
  ledger.close()

  const projects = join(root, "claude", "projects", "agent")
  await mkdir(projects, { recursive: true })
  await writeFile(join(projects, "session-1.jsonl"), [
    JSON.stringify({ type: "user", message: { content: '<coral-turn id="turn-1">input' } }),
    JSON.stringify({ type: "assistant", message: { content: "result" } }),
    JSON.stringify({ type: "user", message: { content: '<coral-turn id="turn-2">next' } }),
  ].join("\n"))

  const result = await run(["review", "--turn", turn.id], {
    ...process.env,
    CLAUDE_CONFIG_DIR: join(root, "claude"),
    CORAL_LEDGER_PATH: ledgerPath,
    CORAL_AGENT_ID: "a",
    CORAL_SCOPE_KIND: "active",
  })
  assert.equal(result.event.id, turn.id)
  assert.equal(result.trajectory.available, true)
  assert.equal(result.trajectory.excerpt.length, 2)
})

function communication(scope: ReturnType<typeof activeScope> | ReturnType<typeof forkScope>, from: string, to: string[]) {
  return {
    type: "communication.sent",
    actor: from,
    scope,
    data: { from, to, content: [{ type: "text", text: "message" }] },
  }
}

async function run(args: string[], env: NodeJS.ProcessEnv): Promise<any> {
  const { stdout } = await execFile(process.execPath, [command, ...args], { env })
  return JSON.parse(stdout)
}
