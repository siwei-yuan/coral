import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { createView } from "./view.mjs"

export async function start({ id, mode, stateRoot, env, emit }) {
  if (id !== "screen") throw new Error(`Invalid Screen Plugin ID: ${id}`)
  const inbox = join(stateRoot, "inbox")
  await mkdir(inbox, { recursive: true })

  async function activity(activityId) {
    assertId(activityId)
    const root = join(stateRoot, "activities", activityId)
    const value = JSON.parse(await readFile(join(root, "activity.json"), "utf8"))
    return { ...value, captures: value.captures.map((capture) => ({ ...capture, image: join(root, capture.image) })) }
  }

  async function current() {
    try {
      const value = JSON.parse(await readFile(join(stateRoot, "current.json"), "utf8"))
      return value.activityId ? activity(value.activityId) : null
    } catch (error) {
      if (isMissing(error)) return null
      throw error
    }
  }

  async function publish(input) {
    if (!input.app?.name || !input.startedAt || !input.endedAt || !Array.isArray(input.captures) || input.captures.length === 0) {
      throw new Error("Screen activity requires App session and captures")
    }
    const activityId = input.id ?? `activity_${randomUUID()}`
    assertId(activityId)
    const observations = join(stateRoot, "activities")
    const temporary = join(stateRoot, `.tmp-${activityId}`)
    const destination = join(observations, activityId)
    await mkdir(join(temporary, "captures"), { recursive: true })
    const captures = []
    for (const capture of input.captures) {
      if (!capture.capturedAt) throw new Error("Screen capture requires time")
      const captureId = capture.id ?? `capture_${randomUUID()}`
      assertId(captureId)
      const image = `captures/${captureId}.png`
      await writeFile(join(temporary, image), Buffer.from(capture.image, "base64"))
      captures.push({ id: captureId, capturedAt: capture.capturedAt, image, ocr: capture.ocr ?? "" })
    }
    const value = {
      id: activityId,
      app: { ...input.app },
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      captures,
    }
    await writeFile(join(temporary, "activity.json"), `${JSON.stringify(value, null, 2)}\n`)
    await mkdir(observations, { recursive: true })
    await rename(temporary, destination)
    await writeFile(join(stateRoot, "current.json"), `${JSON.stringify({ activityId })}\n`)
    await emit({
      type: "communication.sent",
      actor: `plugin/${id}`,
      data: {
        from: `plugin/${id}`,
        to: [],
        source: { plugin: id, externalRef: activityId },
        content: [{ type: "screen.activity", activityId }],
      },
    })
    return value
  }

  async function drain() {
    const files = (await readdir(inbox)).filter((file) => file.endsWith(".json")).sort()
    for (const file of files) {
      const path = join(inbox, file)
      await publish(JSON.parse(await readFile(path, "utf8")))
      await rm(path)
    }
  }

  const tickMs = interval(env.CORALLUM_SCREEN_TICK_MS)
  let pending = Promise.resolve()
  const tick = () => {
    pending = pending.then(drain).catch((error) => console.error("Screen runtime:", error))
  }
  const timer = mode === "live" ? setInterval(tick, tickMs) : null
  timer?.unref()
  if (timer) tick()

  return {
    view: createView({ current }),
    async stop() {
      if (timer) clearInterval(timer)
      await pending
    },
  }
}

function interval(value) {
  const milliseconds = Number(value ?? 1_000)
  if (!Number.isFinite(milliseconds) || milliseconds < 1) throw new Error("Invalid Screen tick interval")
  return milliseconds
}

function assertId(id) {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid Screen activity identifier: ${id}`)
}

function isMissing(error) {
  return error && typeof error === "object" && error.code === "ENOENT"
}
