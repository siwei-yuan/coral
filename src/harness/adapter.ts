import type { ContextMessage } from "../core/workspace/context-bridge.ts"
import type { LedgerEvent, Scope } from "../core/ledger/ledger.ts"

export interface HarnessEmission {
  type: string
  schema?: string
  data?: unknown
  evidence?: unknown
}

export interface HarnessResult {
  outcome?: string
  events?: HarnessEmission[]
  trajectory?: unknown
}

export interface PluginExecutable {
  id: string
  executable: string
  env?: Record<string, string>
}

export interface HarnessPluginCommand extends PluginExecutable {
  command: string
  mode: string
}

export interface HarnessInput {
  turnId: string
  agentId: string
  scope: Scope
  workingDirectory: string
  inputEvents: LedgerEvent[]
  context: ContextMessage[]
  pluginCommands: HarnessPluginCommand[]
  readWorkspace(agentId: string, path: string): Promise<string>
}

export interface HarnessAdapter {
  id: string
  run(input: HarnessInput): Promise<HarnessResult>
}
