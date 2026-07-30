import { spawn } from "node:child_process"
import type { HarnessAdapter, HarnessInput, HarnessResult } from "./adapter.ts"
import { commandEnvironment, JsonLineDecoder, renderPrompt, waitForExit } from "./io.ts"

export class ClaudeCodeHarnessAdapter implements HarnessAdapter {
  readonly id = "claude-code"
  readonly executable: string

  constructor(executable = "claude") {
    this.executable = executable
  }

  async run(input: HarnessInput): Promise<HarnessResult> {
    const args = ["-p", "--input-format", "text", "--output-format", "stream-json", "--verbose"]
    if (input.checkpoint) {
      args.push("--resume", input.checkpoint.sessionId)
      if (input.forkSession) args.push("--fork-session")
    }
    for (const directory of additionalDirectories(input)) args.push("--add-dir", directory)

    const child = spawn(this.executable, args, {
      cwd: input.workingDirectory,
      env: commandEnvironment(input.commands),
      stdio: ["pipe", "pipe", "pipe"],
    })
    let sessionId: string | undefined
    let failed = false
    let stderr = ""
    const decoder = new JsonLineDecoder((value) => {
      if (!value || typeof value !== "object") return
      const event = value as { session_id?: unknown; is_error?: unknown }
      if (typeof event.session_id === "string") sessionId = event.session_id
      if (event.is_error === true) failed = true
    })
    child.stdout.on("data", (chunk: Buffer) => decoder.push(chunk))
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString() })
    child.stdin.end(renderPrompt(input))
    const code = await waitForExit(child)
    if (code !== 0) throw new Error(stderr.trim() || `Claude Code exited ${code}`)
    if (!sessionId) throw new Error("Claude Code returned no session id")
    return {
      outcome: failed ? "failed" : "completed",
      checkpoint: { harness: this.id, sessionId, turnId: input.turnId },
    }
  }
}

function additionalDirectories(input: HarnessInput): string[] {
  return [
    ...input.peerWorkspaces.map((workspace) => workspace.directory),
    ...input.pluginWorkspaces.map((workspace) => workspace.directory),
  ]
}
