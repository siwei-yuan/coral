import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import type { HarnessAdapter, HarnessInput, HarnessResult } from "./adapter.ts"
import { commandEnvironment, JsonLineDecoder, renderPrompt, waitForExit } from "./io.ts"

interface PendingRequest {
  resolve(value: unknown): void
  reject(error: Error): void
}

export class CodexHarnessAdapter implements HarnessAdapter {
  readonly id = "codex"
  readonly executable: string

  constructor(executable = "codex") {
    this.executable = executable
  }

  async run(input: HarnessInput): Promise<HarnessResult> {
    const client = new CodexClient(this.executable, commandEnvironment(input.commands))
    try {
      await client.initialize()
      const thread = input.checkpoint
        ? input.forkSession
          ? await client.request("thread/fork", {
              threadId: input.checkpoint.sessionId,
              lastTurnId: input.checkpoint.turnId,
            })
          : await client.request("thread/resume", { threadId: input.checkpoint.sessionId })
        : await client.request("thread/start", { cwd: input.workingDirectory })
      const threadId = readId(thread, "thread")
      const started = await client.request("turn/start", {
        threadId,
        cwd: input.workingDirectory,
        input: [{ type: "text", text: renderPrompt(input) }],
      })
      const turnId = readId(started, "turn")
      const completed = await client.notification("turn/completed", (value) => readOptionalId(value, "turn") === turnId)
      const status = readStatus(completed)
      return {
        outcome: status === "completed" ? "completed" : status === "interrupted" ? "cancelled" : "failed",
        checkpoint: { harness: this.id, sessionId: threadId, turnId },
      }
    } finally {
      await client.close()
    }
  }
}

class CodexClient {
  readonly child: ChildProcessWithoutNullStreams
  #nextId = 1
  #pending = new Map<number, PendingRequest>()
  #notifications: Array<{ method: string; params: unknown }> = []
  #waiters: Array<{
    method: string
    predicate: (params: unknown) => boolean
    resolve(params: unknown): void
  }> = []
  #stderr = ""

  constructor(executable: string, env: NodeJS.ProcessEnv) {
    this.child = spawn(executable, ["app-server", "--stdio"], { env, stdio: ["pipe", "pipe", "pipe"] })
    const decoder = new JsonLineDecoder((value) => this.#receive(value))
    this.child.stdout.on("data", (chunk: Buffer) => decoder.push(chunk))
    this.child.stderr.on("data", (chunk: Buffer) => { this.#stderr += chunk.toString() })
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: { name: "corallum", title: "Corallum", version: "0.1.0" },
    })
    this.#send({ method: "initialized", params: {} })
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      this.#send({ id, method, params })
    })
  }

  notification(method: string, predicate: (params: unknown) => boolean): Promise<unknown> {
    const existing = this.#notifications.findIndex((item) => item.method === method && predicate(item.params))
    if (existing >= 0) return Promise.resolve(this.#notifications.splice(existing, 1)[0]!.params)
    return new Promise((resolve) => this.#waiters.push({ method, predicate, resolve }))
  }

  async close(): Promise<void> {
    this.child.stdin.end()
    if (this.child.exitCode === null) this.child.kill()
    const code = await waitForExit(this.child)
    if (code !== 0 && code !== 143 && this.#stderr) throw new Error(this.#stderr.trim())
  }

  #send(value: unknown): void {
    this.child.stdin.write(`${JSON.stringify(value)}\n`)
  }

  #receive(value: unknown): void {
    if (!value || typeof value !== "object") return
    const message = value as { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown }
    if (typeof message.id === "number" && ("result" in message || "error" in message)) {
      const pending = this.#pending.get(message.id)
      if (!pending) return
      this.#pending.delete(message.id)
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)))
      else pending.resolve(message.result)
      return
    }
    if (typeof message.id === "number" && typeof message.method === "string") {
      this.#send({ id: message.id, error: { code: -32601, message: "Unsupported server request" } })
      return
    }
    if (typeof message.method !== "string") return
    const waiter = this.#waiters.findIndex((item) => item.method === message.method && item.predicate(message.params))
    if (waiter >= 0) this.#waiters.splice(waiter, 1)[0]!.resolve(message.params)
    else this.#notifications.push({ method: message.method, params: message.params })
  }
}

function readId(value: unknown, key: string): string {
  const id = readOptionalId(value, key)
  if (!id) throw new Error(`Codex response has no ${key} id`)
  return id
}

function readOptionalId(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined
  const nested = (value as Record<string, unknown>)[key]
  if (!nested || typeof nested !== "object") return undefined
  const id = (nested as { id?: unknown }).id
  return typeof id === "string" ? id : undefined
}

function readStatus(value: unknown): string {
  if (!value || typeof value !== "object") return "failed"
  const turn = (value as { turn?: unknown }).turn
  if (!turn || typeof turn !== "object") return "failed"
  const status = (turn as { status?: unknown }).status
  return typeof status === "string" ? status : "failed"
}
