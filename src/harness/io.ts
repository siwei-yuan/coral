import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
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

export async function prepareCommands(commands: HarnessCommand[]): Promise<{
  commands: HarnessCommand[]
  cleanup(): Promise<void>
}> {
  const wrapped = commands.filter((command) => command.env && Object.keys(command.env).length > 0)
  if (wrapped.length === 0) return { commands, cleanup: async () => {} }
  for (const command of wrapped) {
    for (const key of Object.keys(command.env!)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid command environment key: ${key}`)
    }
  }
  const root = await mkdtemp(join(tmpdir(), "corallum-commands-"))
  try {
    const prepared = await Promise.all(commands.map(async (command, index) => {
      if (!command.env || Object.keys(command.env).length === 0) return command
      const executable = join(root, String(index))
      await writeFile(executable, [
        "#!/bin/sh",
        ...Object.entries(command.env).map(([key, value]) => `export ${key}=${shell(value)}`),
        `exec ${[command.executable, ...(command.arguments ?? [])].map(shell).join(" ")} \"$@\"`,
        "",
      ].join("\n"))
      await chmod(executable, 0o700)
      return { id: command.id, executable, usage: command.usage }
    }))
    return {
      commands: prepared,
      cleanup: () => rm(root, { recursive: true, force: true }),
    }
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

export function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode)
  return new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("close", (code) => resolve(code ?? 1))
  })
}

function shell(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`
}
