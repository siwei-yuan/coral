import { execFile, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { access, mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { cleanup, readCapture, readCaptures, screenConfig, ScreenPipeline } from "./pipeline.mjs"
import { createView } from "./view.mjs"

const execute = promisify(execFile)

export async function start({ id, mode, stateRoot, env, emit }) {
  if (id !== "screen") throw new Error(`Invalid Screen Plugin ID: ${id}`)
  await Promise.all([
    mkdir(join(stateRoot, "activities"), { recursive: true }),
    mkdir(join(stateRoot, "incoming"), { recursive: true }),
    mkdir(join(stateRoot, "cache"), { recursive: true }),
  ])

  const captures = (before) => readCaptures(stateRoot, before)
  const captureById = (activityId, captureId) => readCapture(stateRoot, activityId, captureId)
  if (mode !== "live" || env.CORAL_SCREEN_DISABLED === "1") {
    return { view: createView({ captures, capture: captureById }), async stop() {} }
  }

  await cleanup(stateRoot)
  const helper = await compileHelper(stateRoot)
  const pipeline = new ScreenPipeline({
    stateRoot,
    emit,
    capture: (force) => captureScreen(helper, stateRoot, force),
    config: screenConfig,
  })
  const observer = observe(helper, (signal) => pipeline.signal(signal))
  pipeline.signal("context")

  let visualTimer
  const scheduleVisual = () => {
    visualTimer = setTimeout(() => {
      pipeline.visual()
      scheduleVisual()
    }, pipeline.visualDelay())
    visualTimer.unref()
  }
  scheduleVisual()
  const cleanupTimer = setInterval(
    () => cleanup(stateRoot).catch((error) => console.error("Screen cleanup:", error)),
    3_600_000,
  )
  cleanupTimer.unref()

  return {
    view: createView({ captures, capture: captureById }),
    async stop() {
      clearTimeout(visualTimer)
      clearInterval(cleanupTimer)
      observer.kill()
      await pipeline.stop()
    },
  }
}

async function compileHelper(stateRoot) {
  const source = fileURLToPath(new URL("native/screen.swift", import.meta.url))
  const hash = createHash("sha256").update(await readFile(source)).digest("hex").slice(0, 16)
  const root = join(stateRoot, "native", hash)
  const executable = join(root, "screen")
  try {
    await access(executable, constants.X_OK)
    return executable
  } catch {}
  await mkdir(root, { recursive: true })
  await execute("/usr/bin/swiftc", ["-O", source, "-o", executable], { timeout: 120_000 })
  return executable
}

function observe(helper, onSignal) {
  const child = spawn(helper, ["observe"], { stdio: ["ignore", "pipe", "pipe"] })
  let buffer = ""
  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (chunk) => {
    buffer += chunk
    const lines = buffer.split("\n")
    buffer = lines.pop()
    for (const line of lines) {
      try {
        onSignal(JSON.parse(line).kind)
      } catch (error) {
        console.error("Screen observer:", error)
      }
    }
  })
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (value) => console.error(`Screen observer: ${value.trim()}`))
  return child
}

async function captureScreen(helper, stateRoot, force) {
  const { stdout } = await execute(helper, ["capture", stateRoot, force ? "force" : "changed"], {
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  })
  return JSON.parse(stdout)
}
