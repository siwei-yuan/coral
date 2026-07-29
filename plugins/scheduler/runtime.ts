import { readFile, readdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { EventDraft } from "../../src/core/ledger/ledger.ts"
import { activeScope } from "../../src/core/ledger/ledger.ts"
import type { PluginExecutable } from "../../src/harness/adapter.ts"

export interface Schedule {
  agentId: string
  name: string
  every: string
  note: string
  nextAt: string
}

export class SchedulerRuntime {
  readonly id = "scheduler"
  readonly stateRoot: string

  constructor(stateRoot: string) {
    this.stateRoot = resolve(stateRoot)
  }

  executable(): PluginExecutable {
    return {
      id: this.id,
      executable: fileURLToPath(new URL("bin/scheduler.mjs", import.meta.url)),
      env: { CORALLUM_PLUGIN_STATE: this.stateRoot },
    }
  }

  async due(now = new Date()): Promise<EventDraft[]> {
    const nowMs = now.valueOf()
    if (Number.isNaN(nowMs)) throw new Error("Scheduler requires a valid time")
    const schedules = await this.#schedules()
    const events: EventDraft[] = []
    for (const { path, schedule } of schedules) {
      const everyMs = parseEvery(schedule.every)
      const scheduledAtMs = new Date(schedule.nextAt).valueOf()
      if (Number.isNaN(scheduledAtMs)) throw new Error(`Invalid nextAt for Schedule: ${schedule.name}`)
      if (scheduledAtMs > nowMs) continue
      const steps = Math.floor((nowMs - scheduledAtMs) / everyMs) + 1
      await writeFile(path, `${JSON.stringify({ ...schedule, nextAt: new Date(scheduledAtMs + steps * everyMs).toISOString() })}\n`)
      const scheduledAt = new Date(scheduledAtMs).toISOString()
      events.push({
        type: "communication.sent",
        actor: `plugin/${this.id}`,
        scope: activeScope(),
        data: {
          from: `plugin/${this.id}`,
          to: [`agent/${schedule.agentId}`],
          source: { plugin: this.id, externalRef: `${schedule.agentId}/${schedule.name}/${scheduledAt}` },
          content: [{
            type: "schedule.fired",
            name: schedule.name,
            schedule: { every: schedule.every },
            note: schedule.note,
            scheduledAt,
          }],
        },
      })
    }
    return events
  }

  async #schedules(): Promise<Array<{ path: string; schedule: Schedule }>> {
    const root = join(this.stateRoot, "schedules")
    let agents
    try {
      agents = await readdir(root, { withFileTypes: true })
    } catch (error) {
      if (isMissing(error)) return []
      throw error
    }
    const schedules: Array<{ path: string; schedule: Schedule }> = []
    for (const agent of agents.filter((entry) => entry.isDirectory()).sort((left, right) => left.name.localeCompare(right.name))) {
      const directory = join(root, agent.name)
      const files = (await readdir(directory)).filter((file) => file.endsWith(".json")).sort()
      for (const file of files) {
        const path = join(directory, file)
        const schedule = validateSchedule(JSON.parse(await readFile(path, "utf8")))
        schedules.push({ path, schedule })
      }
    }
    return schedules
  }
}

function validateSchedule(value: unknown): Schedule {
  if (!value || typeof value !== "object") throw new Error("Invalid Schedule")
  const schedule = value as Partial<Schedule>
  if (!schedule.agentId || !schedule.name || !schedule.every || !schedule.note || !schedule.nextAt) {
    throw new Error("Invalid Schedule")
  }
  parseEvery(schedule.every)
  return schedule as Schedule
}

function parseEvery(value: string): number {
  const match = /^(\d+)(s|m|h|d)$/.exec(value)
  if (!match || Number(match[1]) < 1) throw new Error(`Invalid Schedule duration: ${value}`)
  return Number(match[1]) * { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as "s" | "m" | "h" | "d"]
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}
