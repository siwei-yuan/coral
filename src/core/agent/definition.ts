export interface AgentDefinition {
  id: string
  harness: string
  model: string
  effort?: string
  turnPolicy: "single-event" | "batch-events"
}
