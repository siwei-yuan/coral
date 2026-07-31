import { readFile, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

export async function start({ id, mode, stateRoot, env, emit }) {
  if (id !== "scheduler") throw new Error(`Invalid Scheduler Plugin ID: ${id}`)
  const tickMs = Number(env.CORAL_SCHEDULER_TICK_MS ?? 1_000)
  if (!Number.isFinite(tickMs) || tickMs < 1) throw new Error("Invalid Scheduler tick interval")

  async function due(now = new Date()) {
    const nowMs = now.valueOf()
    if (Number.isNaN(nowMs)) throw new Error("Scheduler requires a valid time")
    const events = []
    for (const { path, schedule } of await schedules(stateRoot)) {
      const everyMs = parseEvery(schedule.every)
      const scheduledAtMs = new Date(schedule.nextAt).valueOf()
      if (Number.isNaN(scheduledAtMs)) throw new Error(`Invalid nextAt for Schedule: ${schedule.name}`)
      if (scheduledAtMs > nowMs) continue
      const steps = Math.floor((nowMs - scheduledAtMs) / everyMs) + 1
      await writeFile(path, `${JSON.stringify({ ...schedule, nextAt: new Date(scheduledAtMs + steps * everyMs).toISOString() })}\n`)
      const scheduledAt = new Date(scheduledAtMs).toISOString()
      const event = {
        type: "communication.sent",
        actor: `plugin/${id}`,
        data: {
          from: `plugin/${id}`,
          to: [`agent/${schedule.agentId}`],
          source: { plugin: id, externalRef: `${schedule.agentId}/${schedule.name}/${scheduledAt}` },
          content: [{
            type: "schedule.fired",
            name: schedule.name,
            schedule: { every: schedule.every },
            note: schedule.note,
            scheduledAt,
          }],
        },
      }
      events.push(event)
      await emit(event)
    }
    return events
  }

  let pending = Promise.resolve()
  const tick = () => {
    pending = pending.then(() => due()).catch((error) => console.error("Scheduler runtime:", error))
  }
  const timer = mode === "live" ? setInterval(tick, tickMs) : null
  timer?.unref()
  if (timer) tick()
  return {
    async stop() {
      if (timer) clearInterval(timer)
      await pending
    },
  }
}

async function schedules(stateRoot) {
  const root = join(stateRoot, "schedules")
  let agents
  try {
    agents = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }
  const values = []
  for (const agent of agents.filter((entry) => entry.isDirectory()).sort((left, right) => left.name.localeCompare(right.name))) {
    const directory = join(root, agent.name)
    const files = (await readdir(directory)).filter((file) => file.endsWith(".json")).sort()
    for (const file of files) {
      const path = join(directory, file)
      const schedule = JSON.parse(await readFile(path, "utf8"))
      validateSchedule(schedule)
      values.push({ path, schedule })
    }
  }
  return values
}

function validateSchedule(schedule) {
  if (!schedule?.agentId || !schedule.name || !schedule.every || !schedule.note || !schedule.nextAt) {
    throw new Error("Invalid Schedule")
  }
  parseEvery(schedule.every)
}

function parseEvery(value) {
  const match = /^(\d+)(s|m|h|d)$/.exec(value)
  if (!match || Number(match[1]) < 1) throw new Error(`Invalid Schedule duration: ${value}`)
  return Number(match[1]) * { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]]
}

function isMissing(error) {
  return error && typeof error === "object" && error.code === "ENOENT"
}
