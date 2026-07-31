#!/usr/bin/env node

import { once } from "node:events"
import { userInfo } from "node:os"
import { basename, dirname, resolve } from "node:path"
import { parseArgs } from "node:util"
import {
  deploySnapshot,
  openDeployment,
  SnapshotStore,
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
  throw new Error("Usage: corallum create <snapshot> <instance> | corallum start <instance>")
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
  try {
    if (view) {
      const closed = once(view.server, "close")
      view.server.close()
      await closed
    }
  } finally {
    try {
      await deployment.stop()
    } finally {
      clearInterval(keepAlive)
    }
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void stop().catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
  })
}
