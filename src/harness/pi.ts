import { spawn } from "node:child_process"
import type { HarnessAdapter, HarnessInput, HarnessResult } from "./adapter.ts"
import { commandEnvironment, JsonLineDecoder, renderPrompt, waitForExit } from "./io.ts"

export class PiHarnessAdapter implements HarnessAdapter {
  readonly id = "pi"
  readonly executable: string
  readonly sessionDirectory: string | undefined

  constructor({ executable = "pi", sessionDirectory }: { executable?: string; sessionDirectory?: string } = {}) {
    this.executable = executable
    this.sessionDirectory = sessionDirectory
  }

  async run(input: HarnessInput): Promise<HarnessResult> {
    const args = ["--mode", "rpc"]
    if (this.sessionDirectory) args.push("--session-dir", this.sessionDirectory)
    if (input.checkpoint) args.push(input.forkSession ? "--fork" : "--session", input.checkpoint.sessionId)
    const child = spawn(this.executable, args, {
      cwd: input.workingDirectory,
      env: commandEnvironment(input.commands),
      stdio: ["pipe", "pipe", "pipe"],
    })
    let agentEnded = false
    let sessionId: string | undefined
    let stateRequested = false
    let stderr = ""
    const done = new Promise<void>((resolve, reject) => {
      const decoder = new JsonLineDecoder((value) => {
        if (!value || typeof value !== "object") return
        const message = value as {
          id?: unknown
          type?: unknown
          success?: unknown
          data?: { sessionId?: unknown }
        }
        if (message.type === "agent_end") {
          agentEnded = true
          stateRequested = true
          child.stdin.write(`${JSON.stringify({ id: "state", type: "get_state" })}\n`)
          return
        }
        if (message.id === "state" && message.type === "response") {
          if (message.success !== true || typeof message.data?.sessionId !== "string") {
            reject(new Error("Pi returned no session state"))
            return
          }
          sessionId = message.data.sessionId
          resolve()
        }
      })
      child.stdout.on("data", (chunk: Buffer) => decoder.push(chunk))
      child.once("error", reject)
    })
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString() })
    child.stdin.write(`${JSON.stringify({ id: "prompt", type: "prompt", message: renderPrompt(input) })}\n`)
    await done
    child.stdin.end()
    if (child.exitCode === null) child.kill()
    const code = await waitForExit(child)
    if ((!agentEnded || !stateRequested || code !== 0 && code !== 143) && stderr) throw new Error(stderr.trim())
    return {
      outcome: "completed",
      checkpoint: { harness: this.id, sessionId: sessionId!, turnId: input.turnId },
    }
  }
}
