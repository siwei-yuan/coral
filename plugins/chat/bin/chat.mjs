#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { randomUUID } from "node:crypto"

const [command, ...args] = process.argv.slice(2)

if (!command || command === "--help" || command === "help") {
  process.stdout.write("chat reply --conversation <id> --to <external recipient> --text <text> --caused-by <event id>\n")
  process.exit(0)
}

if (command !== "reply") fail(`unknown command: ${command}`)
const stateRoot = process.env.CORALLUM_PLUGIN_STATE
if (!stateRoot) fail("CORALLUM_PLUGIN_STATE is required")

const reply = {
  conversationId: option(args, "--conversation"),
  to: option(args, "--to"),
  text: option(args, "--text"),
  causedBy: option(args, "--caused-by"),
}
if (!reply.to.startsWith("external/")) fail("--to must be an external recipient")

const outbox = join(stateRoot, "outbox")
await mkdir(outbox, { recursive: true })
const id = randomUUID()
await writeFile(join(outbox, `${id}.json`), `${JSON.stringify(reply)}\n`, { flag: "wx" })
process.stdout.write(`${JSON.stringify({ queued: true, id })}\n`)

function option(values, name) {
  const index = values.indexOf(name)
  const value = index >= 0 ? values[index + 1] : undefined
  if (!value) fail(`${name} is required`)
  return value
}

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}
