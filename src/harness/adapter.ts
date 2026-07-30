import type { ContextMessage } from "../core/workspace/context-bridge.ts"

export interface HarnessCheckpoint {
  harness: string
  sessionId: string
  turnId: string
}

export interface HarnessCommand {
  id: string
  executable: string
  arguments?: string[]
  usage: string
  env?: Record<string, string>
}

export interface HarnessPluginWorkspace {
  id: string
  directory: string
  activeCommit: string
  draftCommit: string
  writable: boolean
}

export interface HarnessPeerWorkspace {
  agentId: string
  directory: string
  commit: string
}

export interface HarnessInput {
  turnId: string
  workingDirectory: string
  context: ContextMessage[]
  commands: HarnessCommand[]
  pluginWorkspaces: HarnessPluginWorkspace[]
  peerWorkspaces: HarnessPeerWorkspace[]
  checkpoint?: HarnessCheckpoint
  forkSession: boolean
}

export interface HarnessResult {
  outcome: "completed" | "failed" | "cancelled"
  checkpoint: HarnessCheckpoint | null
}

export interface HarnessAdapter {
  readonly id: string
  run(input: HarnessInput): Promise<HarnessResult>
  stop?(): Promise<void>
}
