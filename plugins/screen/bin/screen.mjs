#!/usr/bin/env node
import { readFile } from "node:fs/promises"
import { join } from "node:path"

const [command, id] = process.argv.slice(2)
if (!command || command === "--help" || command === "help") {
  process.stdout.write("screen current\nscreen activity <id>\n")
  process.exit(0)
}

const stateRoot = process.env.CORALLUM_SCREEN_STATE
if (!stateRoot) fail("CORALLUM_SCREEN_STATE is required")

let activityId = id
if (command === "current") {
  const current = JSON.parse(await readFile(join(stateRoot, "current.json"), "utf8"))
  activityId = current.activityId
} else if (command !== "activity") {
  fail(`unknown command: ${command}`)
}
if (!activityId) fail("activity id is required")
if (!/^[A-Za-z0-9_-]+$/.test(activityId)) fail("invalid activity id")

const activityRoot = join(stateRoot, "activities", activityId)
const activity = JSON.parse(await readFile(join(activityRoot, "activity.json"), "utf8"))
for (const capture of activity.captures) capture.image = join(activityRoot, capture.image)
process.stdout.write(`${JSON.stringify(activity)}\n`)

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}
