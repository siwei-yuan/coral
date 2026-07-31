#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { randomUUID } from "node:crypto"

const [command, ...args] = process.argv.slice(2)

if (!command || command === "--help" || command === "help") {
  process.stdout.write("chat reply --conversation <id> --to <external recipient> --caused-by <event id> < message.txt\n")
  process.exit(0)
}

if (command !== "reply") fail(`unknown command: ${command}`)
const stateRoot = process.env.CORAL_PLUGIN_STATE
if (!stateRoot) fail("CORAL_PLUGIN_STATE is required")

process.stdin.setEncoding("utf8")
let text = ""
for await (const chunk of process.stdin) text += chunk
text = text.replaceAll("\r\n", "\n").trimEnd()
if (!text.trim()) fail("reply text is required on stdin")

const reply = {
  conversationId: option(args, "--conversation"),
  to: option(args, "--to"),
  text,
  causedBy: option(args, "--caused-by"),
  queuedAt: new Date().toISOString(),
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
