import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import type { HarnessCommand } from "../../harness/adapter.ts"
import type { SwarmDefinition } from "../swarm/definition.ts"

export interface SendAction {
  type: "send"
  to: string[]
  text: string
}

export interface ProposeAction {
  type: "propose"
  definition: SwarmDefinition
  addedAgentHeads: Record<string, string>
}

export type AgentAction = SendAction | ProposeAction

export function coreCommand(actionsFile: string, agentId: string): HarnessCommand {
  return {
    id: "coral",
    executable: process.execPath,
    arguments: [fileURLToPath(new URL("./command.mjs", import.meta.url))],
    usage: "send --to <agent> --text <message> | propose --file <proposal.json>",
    env: {
      CORAL_ACTIONS_FILE: actionsFile,
      CORAL_AGENT_ID: agentId,
    },
  }
}

export async function readActions(path: string): Promise<AgentAction[]> {
  let source: string
  try {
    source = await readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
  return source.split("\n").filter(Boolean).map((line) => validateAction(JSON.parse(line)))
}

function validateAction(value: unknown): AgentAction {
  if (!value || typeof value !== "object") throw new Error("Coral action must be an object")
  const action = value as Partial<AgentAction>
  if (action.type === "send") {
    if (!Array.isArray(action.to) || action.to.length === 0 || action.to.some((target) => typeof target !== "string")) {
      throw new Error("Coral send requires recipients")
    }
    if (typeof action.text !== "string" || action.text.length === 0) throw new Error("Coral send requires text")
    return { type: "send", to: [...action.to], text: action.text }
  }
  if (action.type === "propose") {
    if (!action.definition || typeof action.definition !== "object") {
      throw new Error("Coral propose requires a Swarm Definition")
    }
    if (!action.addedAgentHeads || typeof action.addedAgentHeads !== "object") {
      throw new Error("Coral propose addedAgentHeads must be an object")
    }
    return {
      type: "propose",
      definition: action.definition,
      addedAgentHeads: { ...action.addedAgentHeads },
    }
  }
  throw new Error("Unknown Coral action")
}
