#!/usr/bin/env node
import { spawn } from "node:child_process"

const args = process.argv.slice(2)

if (process.env.CORAL_PLUGIN_MODE !== "live") {
  fail("Composio Plugin is unavailable outside live mode")
}

const executable = process.env.CORAL_COMPOSIO_EXECUTABLE || "composio"
const child = spawn(executable, args, { env: process.env, stdio: "inherit" })
child.once("error", (error) => {
  if (error && typeof error === "object" && error.code === "ENOENT") {
    fail(`Composio CLI was not found: ${executable}`)
  }
  fail(error instanceof Error ? error.message : String(error))
})
child.once("exit", (code, signal) => {
  if (signal) fail(`Composio CLI exited from signal ${signal}`)
  process.exit(code ?? 1)
})

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}
