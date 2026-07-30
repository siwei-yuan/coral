#!/usr/bin/env node
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

const [command, ...args] = process.argv.slice(2)
if (!command || command === "--help" || command === "help") {
  process.stdout.write("scheduler set --name <name> --every <duration> --note <note>\nscheduler remove --name <name>\nscheduler list\n")
  process.exit(0)
}

const stateRoot = process.env.CORALLUM_SCHEDULER_STATE
const agentId = process.env.CORALLUM_AGENT_ID
if (!stateRoot) fail("CORALLUM_SCHEDULER_STATE is required")
if (!agentId) fail("CORALLUM_AGENT_ID is required")
if (process.env.CORALLUM_PLUGIN_MODE !== "live") fail("Scheduler Plugin must be live")
const directory = join(stateRoot, "schedules", encodeURIComponent(agentId))

if (command === "set") {
  const name = scheduleName(args)
  const every = option(args, "--every")
  const note = option(args, "--note")
  const interval = parseEvery(every)
  await mkdir(directory, { recursive: true })
  const schedule = { agentId, name, every, note, nextAt: new Date(Date.now() + interval).toISOString() }
  await writeFile(join(directory, `${name}.json`), `${JSON.stringify(schedule)}\n`)
  process.stdout.write(`${JSON.stringify(schedule)}\n`)
} else if (command === "remove") {
  const name = scheduleName(args)
  await rm(join(directory, `${name}.json`), { force: true })
  process.stdout.write(`${JSON.stringify({ removed: name })}\n`)
} else if (command === "list") {
  await mkdir(directory, { recursive: true })
  const files = (await readdir(directory)).filter((file) => file.endsWith(".json")).sort()
  const schedules = await Promise.all(files.map(async (file) => JSON.parse(await readFile(join(directory, file), "utf8"))))
  process.stdout.write(`${JSON.stringify(schedules)}\n`)
} else {
  fail(`unknown command: ${command}`)
}

function scheduleName(values) {
  const name = option(values, "--name")
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) fail("--name must use letters, numbers, underscores, or hyphens")
  return name
}

function option(values, name) {
  const index = values.indexOf(name)
  const value = index >= 0 ? values[index + 1] : undefined
  if (!value) fail(`${name} is required`)
  return value
}

function parseEvery(value) {
  const match = /^(\d+)(s|m|h|d)$/.exec(value)
  if (!match || Number(match[1]) < 1) fail("--every must be a positive duration such as 30s, 10m, 6h, or 1d")
  return Number(match[1]) * { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]]
}

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}
