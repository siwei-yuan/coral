import type { ChildProcessWithoutNullStreams } from "node:child_process"
import type { HarnessCommand, HarnessInput } from "./adapter.ts"

export class JsonLineDecoder {
  #buffer = ""
  readonly onValue: (value: unknown) => void

  constructor(onValue: (value: unknown) => void) {
    this.onValue = onValue
  }

  push(chunk: Buffer | string): void {
    this.#buffer += chunk.toString()
    for (;;) {
      const end = this.#buffer.indexOf("\n")
      if (end < 0) return
      const line = this.#buffer.slice(0, end).replace(/\r$/, "")
      this.#buffer = this.#buffer.slice(end + 1)
      if (line) this.onValue(JSON.parse(line))
    }
  }
}

export function commandEnvironment(commands: HarnessCommand[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const command of commands) {
    for (const [key, value] of Object.entries(command.env ?? {})) {
      if (env[key] !== undefined && env[key] !== value) throw new Error(`Harness command environment conflicts: ${key}`)
      env[key] = value
    }
  }
  return env
}

export function renderPrompt(input: HarnessInput): string {
  const messages = input.context.map((message) => `[${message.role}]\n${message.content}`).join("\n\n")
  const commands = input.commands.map((command) =>
    `- ${command.id}: ${[command.executable, ...(command.arguments ?? []), command.usage].join(" ")}`
  ).join("\n")
  const peers = input.peerWorkspaces.map((workspace) =>
    `- ${workspace.agentId} at ${workspace.directory} (${workspace.commit})`
  ).join("\n")
  return [
    `<corallum-turn id="${input.turnId}">`,
    messages,
    "# Corallum commands",
    commands || "None",
    "# Read-only peer workspaces",
    peers || "None",
    "Use the Corallum command for inter-Agent communication or a Swarm Proposal. Your final prose stays in the native Harness trajectory.",
    "</corallum-turn>",
  ].join("\n\n")
}

export function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode)
  return new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("close", (code) => resolve(code ?? 1))
  })
}
