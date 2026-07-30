export interface AgentDefinition {
  id: string
  harness: string
  turnPolicy: "single-event" | "batch-events"
}
