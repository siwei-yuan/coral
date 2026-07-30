import assert from "node:assert/strict"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type { TestContext } from "node:test"
import {
  ClaudeCodeHarnessAdapter,
  CodexHarnessAdapter,
  PiHarnessAdapter,
  type HarnessInput,
} from "../src/index.ts"

test("Codex Adapter starts, resumes, and forks exact native turns", async (t) => {
  const { root, executable } = await fakeExecutable(t, "codex", `
import readline from "node:readline"
const lines = readline.createInterface({ input: process.stdin })
lines.on("line", (line) => {
  const message = JSON.parse(line)
  if (typeof message.id !== "number") return
  if (message.method === "initialize") respond(message.id, {})
  if (message.method === "thread/start") respond(message.id, { thread: { id: "codex-new" } })
  if (message.method === "thread/resume") respond(message.id, { thread: { id: message.params.threadId } })
  if (message.method === "thread/fork") respond(message.id, { thread: { id: "codex-fork" } })
  if (message.method === "turn/start") {
    respond(message.id, { turn: { id: "codex-turn" } })
    send({ method: "turn/completed", params: { turn: { id: "codex-turn", status: "completed" } } })
  }
})
function respond(id, result) { send({ id, result }) }
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n") }
`)
  const adapter = new CodexHarnessAdapter(executable)
  const started = await adapter.run(harnessInput(root))
  assert.deepEqual(started.checkpoint, { harness: "codex", sessionId: "codex-new", turnId: "codex-turn" })
  const resumed = await adapter.run(harnessInput(root, started.checkpoint!, false))
  assert.equal(resumed.checkpoint?.sessionId, "codex-new")
  const forked = await adapter.run(harnessInput(root, resumed.checkpoint!, true))
  assert.equal(forked.checkpoint?.sessionId, "codex-fork")
})

test("Claude Code Adapter preserves or forks the supplied session", async (t) => {
  const { root, executable } = await fakeExecutable(t, "claude", `
const args = process.argv.slice(2)
process.stdin.resume()
process.stdin.on("end", () => {
  const resume = args.indexOf("--resume")
  const session = args.includes("--fork-session") ? "claude-fork" : resume >= 0 ? args[resume + 1] : "claude-new"
  process.stdout.write(JSON.stringify({ type: "result", session_id: session, is_error: false }) + "\\n")
})
`)
  const adapter = new ClaudeCodeHarnessAdapter(executable)
  const started = await adapter.run(harnessInput(root))
  assert.equal(started.checkpoint?.sessionId, "claude-new")
  const resumed = await adapter.run(harnessInput(root, started.checkpoint!, false))
  assert.equal(resumed.checkpoint?.sessionId, "claude-new")
  const forked = await adapter.run(harnessInput(root, resumed.checkpoint!, true))
  assert.equal(forked.checkpoint?.sessionId, "claude-fork")
})

test("Pi Adapter drives one RPC turn and returns its session checkpoint", async (t) => {
  const { root, executable } = await fakeExecutable(t, "pi", `
import readline from "node:readline"
const lines = readline.createInterface({ input: process.stdin })
lines.on("line", (line) => {
  const message = JSON.parse(line)
  if (message.type === "prompt") {
    send({ id: message.id, type: "response", command: "prompt", success: true })
    send({ type: "agent_end" })
  }
  if (message.type === "get_state") {
    send({ id: message.id, type: "response", command: "get_state", success: true, data: { sessionId: "pi-session" } })
  }
})
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n") }
`)
  const adapter = new PiHarnessAdapter({ executable })
  const result = await adapter.run(harnessInput(root))
  assert.deepEqual(result.checkpoint, { harness: "pi", sessionId: "pi-session", turnId: "turn-1" })
})

function harnessInput(
  workingDirectory: string,
  checkpoint?: NonNullable<HarnessInput["checkpoint"]>,
  forkSession = false,
): HarnessInput {
  return {
    turnId: "turn-1",
    workingDirectory,
    context: [{ role: "user", content: "do the work" }],
    commands: [],
    pluginWorkspaces: [],
    peerWorkspaces: [],
    ...(checkpoint ? { checkpoint } : {}),
    forkSession,
  }
}

async function fakeExecutable(t: TestContext, name: string, source: string) {
  const root = await mkdtemp(join(tmpdir(), `corallum-${name}-`))
  t.after(() => rm(root, { recursive: true, force: true }))
  const executable = join(root, name)
  await writeFile(executable, `#!/usr/bin/env node\n${source}`)
  await chmod(executable, 0o755)
  return { root, executable }
}
