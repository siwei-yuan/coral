import { parseArgs } from "node:util"
import type { HarnessCheckpoint } from "../../harness/adapter.ts"
import { readHarnessTurn } from "../../harness/trajectory.ts"
import { Ledger, type LedgerEvent } from "../ledger/ledger.ts"

export async function review(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<unknown> {
  const ledgerPath = env.CORAL_LEDGER_PATH
  if (!ledgerPath) throw new Error("CORAL_LEDGER_PATH is required")
  const events = visibleEvents(Ledger.read(ledgerPath), env)
  const options = reviewOptions(args)

  if ("event" in options) return findEvent(events, options.event)
  if ("turn" in options) {
    const event = findEvent(events, options.turn)
    if (event.type !== "agent.turn.recorded") throw new Error(`Event is not an Agent turn: ${event.id}`)
    const checkpoint = (event.data as { trajectory?: unknown } | null)?.trajectory
    if (!isCheckpoint(checkpoint)) return { event, trajectory: { available: false, reason: "No Harness checkpoint" } }
    try {
      return { event, trajectory: { available: true, checkpoint, excerpt: await readHarnessTurn(checkpoint, env) } }
    } catch (error) {
      return {
        event,
        trajectory: {
          available: false,
          checkpoint,
          reason: error instanceof Error ? error.message : String(error),
        },
      }
    }
  }

  const agentId = options.agent === "self" ? env.CORAL_AGENT_ID : options.agent
  if (!agentId) throw new Error("CORAL_AGENT_ID is required for --agent self")
  const related = agentId === "all" ? events : events.filter((event) => relatesToAgent(event, agentId))
  const after = options.after
  const selected = options.number === 0
    ? []
    : after === undefined
      ? related.slice(-options.number)
      : related.filter((event) => event.seq > after).slice(0, options.number)
  return selected.map(eventIndex)
}

function reviewOptions(args: string[]):
  | { event: string; turn?: never; agent?: never; after?: never; number?: never }
  | { turn: string; event?: never; agent?: never; after?: never; number?: never }
  | { agent: string; after: number | undefined; number: number; event?: never; turn?: never } {
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    strict: true,
    options: {
      agent: { type: "string" },
      after: { type: "string" },
      recent: { type: "boolean" },
      number: { type: "string" },
      event: { type: "string" },
      turn: { type: "string" },
    },
  })
  if (values.event && Object.keys(values).length === 1) return { event: values.event }
  if (values.turn && Object.keys(values).length === 1) return { turn: values.turn }
  if (!values.agent || values.number === undefined || Boolean(values.recent) === (values.after !== undefined)) {
    throw new Error(reviewUsage())
  }
  if (Object.keys(values).some((key) => !["agent", "after", "recent", "number"].includes(key))) {
    throw new Error(reviewUsage())
  }
  const number = integer(values.number, "--number")
  if (number < 0 || number > 30) throw new Error("--number must be between 0 and 30")
  return {
    agent: values.agent,
    after: values.after === undefined ? undefined : integer(values.after, "--after"),
    number,
  }
}

function visibleEvents(events: LedgerEvent[], env: NodeJS.ProcessEnv): LedgerEvent[] {
  if (env.CORAL_SCOPE_KIND === "active") return events
  if (env.CORAL_SCOPE_KIND !== "fork") throw new Error("CORAL_SCOPE_KIND is required")
  const forkId = env.CORAL_FORK_ID
  const frontier = Number(env.CORAL_FORK_SOURCE_FRONTIER)
  if (!forkId || !Number.isInteger(frontier) || frontier < 0) throw new Error("Fork review scope is incomplete")
  return events.filter((event) =>
    event.scope.kind === "active" && event.seq <= frontier ||
    event.scope.kind === "fork" && event.scope.forkId === forkId
  )
}

function relatesToAgent(event: LedgerEvent, agentId: string): boolean {
  if (event.actor === `agent/${agentId}`) return true
  if (!event.data || typeof event.data !== "object") return false
  const data = event.data as Record<string, unknown>
  return data.agentId === agentId ||
    data.authoredBy === agentId ||
    data.from === `agent/${agentId}` ||
    Array.isArray(data.to) && data.to.includes(`agent/${agentId}`)
}

function eventIndex(event: LedgerEvent) {
  return {
    id: event.id,
    seq: event.seq,
    type: event.type,
    actor: event.actor,
    scope: event.scope,
    causation: event.causation,
    ...(event.swarmRevision ? { swarmRevision: event.swarmRevision } : {}),
    recordedAt: event.recordedAt,
  }
}

function findEvent(events: LedgerEvent[], id: string): LedgerEvent {
  const event = events.find((candidate) => candidate.id === id)
  if (!event) throw new Error(`Event is not visible: ${id}`)
  return event
}

function integer(value: string, name: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`)
  return parsed
}

function isCheckpoint(value: unknown): value is HarnessCheckpoint {
  if (!value || typeof value !== "object") return false
  const checkpoint = value as Partial<HarnessCheckpoint>
  return typeof checkpoint.harness === "string" &&
    typeof checkpoint.model === "string" &&
    typeof checkpoint.sessionId === "string" &&
    typeof checkpoint.turnId === "string"
}

export function reviewUsage(): string {
  return [
    "usage:",
    "  coral review --agent <self|agent-id|all> --after <seq> --number <0..30>",
    "  coral review --agent <self|agent-id|all> --recent --number <0..30>",
    "  coral review --event <event-id>",
    "  coral review --turn <turn-event-id>",
  ].join("\n")
}
