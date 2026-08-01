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
    `<coral-turn id="${input.turnId}">`,
    messages,
    "# Coral commands",
    commands || "None",
    "# Read-only peer workspaces",
    peers || "None",
    "# Workspace persistence",
    [
      "You are working in your own Git-backed workspace.",
      "When a self-change should persist: modify the workspace, review the diff, and commit the intended change before ending the turn.",
      "Use the commit message to explain what changed and why. If no durable self-change is warranted, do not commit.",
      "Uncommitted changes are restored to the last commit at turn end and do not persist.",
      "Writable Plugin workspaces follow the same rule. Do not edit read-only peer workspaces.",
      "Do not rewrite history, switch branches, or modify Git internals. Coral owns checkout, refs, integration, and Ledger recording.",
    ].join("\n"),
    "# Coral send",
    [
      "Send a Communication to one or more Agents through configured outgoing Routes.",
      "Syntax: coral send --to <agent-id> [--to <agent-id>...] --text <message>",
      "Example: coral send --to memory-builder --text \"The user corrected their project priority.\"",
      "The Communication is recorded after the turn. Sending does not edit another Agent's workspace.",
    ].join("\n"),
    "# Coral propose",
    [
      "Propose one complete candidate Swarm Definition. A turn may submit at most one Proposal.",
      "Syntax: coral propose --file <proposal.json>",
      "Example: coral propose --file ./proposal.json",
      "The file contains either a complete Swarm Definition or { definition, addedAgentHeads } when adding Agents.",
      "A Proposal does not change Main; it becomes active only after Fork evaluation and Human approval.",
    ].join("\n"),
    "# Coral review",
    [
      "Review is read-only and creates no Ledger Event. The Agent selector accepts self, a specific Agent ID, or all; all returns every Event visible in the current scope.",
      "1. Events after a Ledger sequence:",
      "   coral review --agent <self|agent-id|all> --after <seq> --number <0..30>",
      "   Example: coral review --agent self --after 120 --number 10",
      "2. Most recent Events:",
      "   coral review --agent <self|agent-id|all> --recent --number <0..30>",
      "   Example: coral review --agent memory-builder --recent --number 10",
      "3. One complete Ledger Event:",
      "   coral review --event <event-id>",
      "   Example: coral review --event event_42_a1b2c3d4e5f6",
      "4. One Agent Turn and its native Harness trajectory:",
      "   coral review --turn <turn-event-id>",
      "   Example: coral review --turn event_57_f6e5d4c3b2a1",
      "Your final prose stays in the native Harness trajectory.",
    ].join("\n"),
    "</coral-turn>",
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
  const root = await mkdtemp(join(tmpdir(), "coral-commands-"))
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
