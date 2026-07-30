import { randomUUID } from "node:crypto"
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"

export const screenConfig = {
  contextDelayMs: 300,
  softDelayMs: 1_200,
  softMaxWaitMs: 8_000,
  minCaptureIntervalMs: 2_000,
  activeVisualMs: 5_000,
  idleVisualMs: 30_000,
  activeForMs: 60_000,
  suspendAfterMs: 300_000,
  activityQuietMs: 10_000,
  maxActivityMs: 600_000,
  retentionMs: 7 * 86_400_000,
  maxBytes: 2 * 1024 * 1024 * 1024,
}

export class ScreenPipeline {
  constructor({ stateRoot, emit, capture, config, now = () => Date.now() }) {
    this.stateRoot = stateRoot
    this.emit = emit
    this.capture = capture
    this.config = config
    this.now = now
    this.lastSignalAt = now()
    this.lastCaptureAt = 0
  }

  signal(kind) {
    if (this.stopped) return
    if (kind === "sleep") {
      this.suspended = true
      clearTimeout(this.captureTimer)
      return
    }
    if (kind === "wake") {
      this.suspended = false
      kind = "context"
    }
    if (kind !== "context" && kind !== "input") return

    const now = this.now()
    this.lastSignalAt = now
    if (kind === "context") {
      this.softStartedAt = null
      this.#schedule(now + this.config.contextDelayMs, true)
      return
    }
    this.softStartedAt ??= now
    this.#schedule(Math.min(
      now + this.config.softDelayMs,
      this.softStartedAt + this.config.softMaxWaitMs,
    ), false)
  }

  visual() {
    if (this.stopped || this.suspended || this.now() - this.lastSignalAt >= this.config.suspendAfterMs) return
    this.#request(false)
  }

  visualDelay() {
    return this.now() - this.lastSignalAt < this.config.activeForMs
      ? this.config.activeVisualMs
      : this.config.idleVisualMs
  }

  async stop() {
    this.stopped = true
    clearTimeout(this.captureTimer)
    clearTimeout(this.quietTimer)
    await this.captureWork
    if (this.activity) await rm(this.activity.directory, { recursive: true, force: true })
  }

  #schedule(deadline, force) {
    if (this.pendingHard && !force) return
    this.pendingHard = force
    clearTimeout(this.captureTimer)
    const minimum = force ? deadline : Math.max(deadline, this.lastCaptureAt + this.config.minCaptureIntervalMs)
    this.captureTimer = setTimeout(() => {
      this.pendingHard = false
      this.softStartedAt = null
      this.#request(force)
    }, Math.max(0, minimum - this.now()))
    this.captureTimer.unref()
  }

  #request(force) {
    this.pendingCapture = this.pendingCapture === undefined ? force : this.pendingCapture || force
    if (this.captureWork) return
    this.captureWork = this.#drain().finally(() => { this.captureWork = null })
  }

  async #drain() {
    while (this.pendingCapture !== undefined && !this.stopped) {
      const force = this.pendingCapture
      this.pendingCapture = undefined
      this.lastCaptureAt = this.now()
      try {
        const result = await this.capture(force)
        if (result?.type === "capture") await this.#accept(result)
      } catch (error) {
        console.error("Screen runtime:", error)
      }
    }
  }

  async #accept(input) {
    assertCapture(input)
    assertIncoming(this.stateRoot, input.image)
    assertIncoming(this.stateRoot, input.preview)
    assertIncoming(this.stateRoot, input.changeProbe)
    const capturedAt = new Date(input.capturedAt)
    if (Number.isNaN(capturedAt.valueOf())) throw new Error("Screen capture requires a valid time")

    const expired = this.activity
      && capturedAt.valueOf() - new Date(this.activity.startedAt).valueOf() >= this.config.maxActivityMs
    if (this.activity && (this.activity.contextKey !== input.contextKey || expired)) await this.#finalize()
    if (!this.activity) await this.#begin(input)

    const captureId = `capture_${randomUUID()}`
    const image = `captures/${captureId}.png`
    const preview = `captures/${captureId}.preview.jpg`
    await rename(input.image, join(this.activity.directory, image))
    await rename(input.preview, join(this.activity.directory, preview))
    this.activity.endedAt = input.capturedAt
    this.activity.captures.push({ id: captureId, capturedAt: input.capturedAt, image, preview, ocr: input.ocr })
    await writeJson(join(this.activity.directory, "activity.json"), publicActivity(this.activity))
    await rename(input.changeProbe, join(this.stateRoot, "cache", "change-probe.bin"))
    await writeJson(join(this.stateRoot, "cache", "change-probe.json"), { contextKey: input.contextKey })

    clearTimeout(this.quietTimer)
    this.quietTimer = setTimeout(() => {
      this.#finalize().catch((error) => console.error("Screen runtime:", error))
    }, this.config.activityQuietMs)
    this.quietTimer.unref()
  }

  async #begin(input) {
    const id = `activity_${randomUUID()}`
    const directory = join(this.stateRoot, `.tmp-${id}`)
    this.activity = {
      id,
      contextKey: input.contextKey,
      directory,
      app: { ...input.app },
      startedAt: input.capturedAt,
      endedAt: input.capturedAt,
      captures: [],
    }
    await mkdir(join(directory, "captures"), { recursive: true })
  }

  async #finalize() {
    const activity = this.activity
    if (!activity) return
    this.activity = null
    clearTimeout(this.quietTimer)
    await writeJson(join(activity.directory, "activity.json"), publicActivity(activity))
    await rename(activity.directory, join(this.stateRoot, "activities", activity.id))
    await writeJson(join(this.stateRoot, "current.json"), { activityId: activity.id })
    await this.emit({
      type: "communication.sent",
      actor: "plugin/screen",
      data: {
        from: "plugin/screen",
        to: [],
        source: { plugin: "screen", externalRef: activity.id },
        content: [{ type: "screen.activity", activityId: activity.id }],
      },
    })
  }
}

export async function readCaptures(stateRoot, before, limit = 20) {
  const captures = await allCaptures(stateRoot)
  const cursorIndex = before ? captures.findIndex((capture) => capture.cursor === before) : -1
  if (before && cursorIndex < 0) throw new Error("Unknown Screen history cursor")
  const start = cursorIndex + 1
  const page = captures.slice(start, start + limit)
  return {
    items: page.map(({ image: _image, preview: _preview, ocr: _ocr, cursor: _cursor, ...capture }) => capture),
    nextCursor: captures[start + limit] ? page.at(-1)?.cursor ?? null : null,
  }
}

export async function readCapture(stateRoot, activityId, captureId) {
  assertId(activityId)
  assertId(captureId)
  const root = join(stateRoot, "activities", activityId)
  const activity = JSON.parse(await readFile(join(root, "activity.json"), "utf8"))
  const capture = activity.captures.find((item) => item.id === captureId)
  if (!capture) throw new Error(`Unknown Screen capture: ${captureId}`)
  return {
    activityId,
    app: activity.app,
    ...capture,
    image: join(root, capture.image),
    preview: join(root, capture.preview),
  }
}

export async function cleanup(stateRoot) {
  const root = join(stateRoot, "activities")
  const activities = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const path = join(root, entry.name)
    const info = await stat(path)
    activities.push({ path, modifiedAt: info.mtimeMs, bytes: await directorySize(path) })
  }
  activities.sort((left, right) => left.modifiedAt - right.modifiedAt)
  let total = activities.reduce((sum, activity) => sum + activity.bytes, 0)
  for (const activity of activities) {
    if (Date.now() - activity.modifiedAt <= screenConfig.retentionMs && total <= screenConfig.maxBytes) continue
    await rm(activity.path, { recursive: true, force: true })
    total -= activity.bytes
  }
}

function publicActivity(activity) {
  return {
    id: activity.id,
    app: activity.app,
    startedAt: activity.startedAt,
    endedAt: activity.endedAt,
    captures: activity.captures,
  }
}

function assertCapture(input) {
  if (!input.contextKey || !input.app?.name || !input.capturedAt || !input.image || !input.preview || !input.changeProbe) {
    throw new Error("Invalid native Screen capture")
  }
  if (typeof input.ocr !== "string") throw new Error("Invalid native Screen OCR")
}

function assertIncoming(stateRoot, path) {
  if (relative(join(stateRoot, "incoming"), path).startsWith("..")) {
    throw new Error("Screen capture path escapes incoming state")
  }
}

async function writeJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`)
  await rename(temporary, path)
}

async function directorySize(root) {
  let bytes = 0
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    bytes += entry.isDirectory() ? await directorySize(path) : (await stat(path)).size
  }
  return bytes
}

async function allCaptures(stateRoot) {
  const root = join(stateRoot, "activities")
  const captures = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const activityRoot = join(root, entry.name)
    const activity = JSON.parse(await readFile(join(activityRoot, "activity.json"), "utf8"))
    for (const capture of activity.captures) captures.push({
      activityId: activity.id,
      app: activity.app,
      ...capture,
      image: join(activityRoot, capture.image),
      preview: join(activityRoot, capture.preview),
      cursor: `${capture.capturedAt}|${capture.id}`,
    })
  }
  return captures.sort((left, right) => right.cursor.localeCompare(left.cursor))
}

function assertId(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid Screen activity or capture ID")
}
