#!/usr/bin/env node

import { appendFileSync, readFileSync } from "node:fs"
import { review, reviewUsage } from "./review.ts"

const [command, ...args] = process.argv.slice(2)

if (command === "review") {
  try {
    console.log(JSON.stringify(await review(args), null, 2))
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
} else if (command === "send") {
  const to = values(args, "--to")
  const text = value(args, "--text")
  if (to.length === 0 || !text) fail("usage: coral send --to <agent-id> [--to <agent-id>...] --text <message>")
  append({ type: "send", to, text })
} else if (command === "propose") {
  const path = value(args, "--file")
  if (!path) fail("usage: coral propose --file <proposal.json>")
  const proposal = JSON.parse(readFileSync(path, "utf8"))
  append({
    type: "propose",
    definition: proposal.definition ?? proposal,
    addedAgentHeads: proposal.addedAgentHeads ?? {},
  })
} else {
  fail(`usage: coral send|propose|review\n${reviewUsage()}`)
}

function append(action) {
  const actionsFile = process.env.CORAL_ACTIONS_FILE
  if (!actionsFile) fail("CORAL_ACTIONS_FILE is required")
  appendFileSync(actionsFile, `${JSON.stringify(action)}\n`, { mode: 0o600 })
}

function value(args, name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

function values(args, name) {
  const found = []
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1]) found.push(args[index + 1])
  }
  return found
}

function fail(message) {
  console.error(message)
  process.exit(1)
}
