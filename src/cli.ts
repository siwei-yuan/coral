#!/usr/bin/env node

import { once } from "node:events"
import { userInfo } from "node:os"
import { basename, dirname, resolve } from "node:path"
import { parseArgs } from "node:util"
import {
  deploySnapshot,
  openDeployment,
  SnapshotStore,
  type AgentMailboxStatus,
  type DefaultViewServer,
  type Deployment,
} from "./index.ts"

const { values, positionals } = parseArgs({
  allowPositionals: true,
  allowNegative: true,
  options: {
    view: { type: "boolean", default: true },
    "view-port": { type: "string", default: "0" },
  },
})
const [command, source, target] = positionals
const human = userInfo().username
let deployment: Deployment

if (command === "create" && source && target) {
  const snapshot = resolve(source)
  deployment = await deploySnapshot({
    snapshots: new SnapshotStore(dirname(snapshot)),
    name: basename(snapshot),
    instanceRoot: resolve(target),
    human,
  })
} else if (command === "start" && source && !target) {
  deployment = await openDeployment({ instanceRoot: resolve(source), human })
} else {
  throw new Error("Usage: coral create <snapshot> <instance> | coral start <instance>")
}

const port = Number(values["view-port"])
if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("Invalid View port")
let view: DefaultViewServer | null = null

try {
  if (values.view) {
    view = await deployment.view.listen({ port })
    console.log(view.url)
  }
} catch (error) {
  await deployment.stop()
  throw error
}

const keepAlive = setInterval(() => undefined, 2_147_483_647)
let stopping = false

async function stop(): Promise<void> {
  if (stopping) return
  stopping = true
  console.log("Stopping Coral. Draining Agent mailboxes…")
  try {
    if (view) {
      const closed = once(view.server, "close")
      view.server.close()
      await closed
    }
  } finally {
    try {
      await stopWithMailboxStatus(deployment)
      console.log("All Agent mailboxes are clear. Coral stopped.")
    } finally {
      clearInterval(keepAlive)
    }
  }
}

async function stopWithMailboxStatus(deployment: Deployment): Promise<void> {
  let previous = printMailboxes(deployment.swarm.mailboxes())
  const operation = deployment.stop()
  while (!await Promise.race([
    operation.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 250)),
  ])) {
    const statuses = deployment.swarm.mailboxes()
    const current = JSON.stringify(statuses)
    if (current === previous) continue
    previous = printMailboxes(statuses)
  }
}

function printMailboxes(statuses: AgentMailboxStatus[]): string {
  for (const status of statuses) {
    const turn = status.running ? "running" : "idle"
    const queue = status.pending === 0 ? "clear" : `${status.pending} queued`
    console.log(`  ${status.agentId}: ${turn}, ${queue}`)
  }
  return JSON.stringify(statuses)
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void stop().catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
  })
}

void deployment.closed.then(() => stop()).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
