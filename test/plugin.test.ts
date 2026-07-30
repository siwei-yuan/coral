import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import test from "node:test"
import { promisify } from "node:util"
import type { PluginIngressDraft, ViewExtension } from "../src/index.ts"

const execute = promisify(execFile)

interface RuntimeInstance {
  stop(): Promise<void> | void
  view?: ViewExtension
}

test("Chat runtime emits user Communication and its Agent CLI writes replies outside the Ledger", async (t) => {
  const root = await temporary(t, "chat")
  const emitted: PluginIngressDraft[] = []
  const runtime = await startPlugin("chat", root, emitted)

  await runtime.view!.handle!("send", new URLSearchParams({ conversationId: "conversation-1", text: "hello" }))
  assert.equal(emitted[0]?.type, "communication.sent")
  assert.equal((emitted[0]?.data as { source: { plugin: string } }).source.plugin, "chat")

  await executeWithInput(
    join(process.cwd(), "plugins/chat/bin/chat.mjs"),
    [
      "reply",
      "--conversation", "conversation-1",
      "--to", "external/user/local",
      "--caused-by", "event-1",
    ],
    "First paragraph.\n\nSecond paragraph.\n",
    { env: { ...process.env, CORALLUM_PLUGIN_STATE: root } },
  )
  const [replyFile] = await readdir(join(root, "outbox"))
  const reply = JSON.parse(await readFile(join(root, "outbox", replyFile!), "utf8")) as {
    text: string
    causedBy: string
  }
  assert.equal(reply.text, "First paragraph.\n\nSecond paragraph.")
  assert.equal(reply.causedBy, "event-1")
  await runtime.stop()
})

test("Screen pipeline coalesces capture signals, persists an Activity, then emits its reference", async (t) => {
  const root = await temporary(t, "screen")
  const emitted: PluginIngressDraft[] = []
  const { ScreenPipeline } = await import(pathToFileURL(join(process.cwd(), "plugins/screen/pipeline.mjs")).href) as {
    ScreenPipeline: new (input: {
      stateRoot: string
      emit(draft: PluginIngressDraft): Promise<void>
      capture(force: boolean): Promise<Record<string, unknown>>
      config: Record<string, number>
    }) => {
      signal(kind: string): void
      visual(): void
      stop(): Promise<void>
    }
  }
  await Promise.all([
    mkdir(join(root, "activities"), { recursive: true }),
    mkdir(join(root, "incoming"), { recursive: true }),
    mkdir(join(root, "cache"), { recursive: true }),
  ])
  let captures = 0
  const pipeline = new ScreenPipeline({
    stateRoot: root,
    config: {
      contextDelayMs: 5,
      softDelayMs: 10,
      softMaxWaitMs: 20,
      minCaptureIntervalMs: 1,
      activeVisualMs: 10,
      idleVisualMs: 20,
      activeForMs: 100,
      suspendAfterMs: 2_000,
      activityQuietMs: 15,
      maxActivityMs: 1_000,
    },
    capture: async () => {
      captures += 1
      if (captures > 1) return { type: "skip" }
      const image = join(root, "incoming", "capture.png")
      const preview = join(root, "incoming", "capture.preview.jpg")
      const changeProbe = join(root, "incoming", "capture.change-probe")
      await Promise.all([
        writeFile(image, "raw-image"),
        writeFile(preview, "preview-image"),
        writeFile(changeProbe, "change-probe"),
      ])
      return {
        type: "capture",
        contextKey: "com.openai.codex:1",
        app: { name: "Codex", bundleId: "com.openai.codex" },
        capturedAt: "2026-07-29T10:01:00Z",
        image,
        preview,
        changeProbe,
        ocr: "Implement the Screen Plugin",
      }
    },
    emit: async (draft) => {
      const activityId = ((draft.data as { content: Array<{ activityId: string }> }).content[0]!).activityId
      await readFile(join(root, "activities", activityId, "activity.json"))
      emitted.push(draft)
    },
  })
  pipeline.signal("input")
  pipeline.signal("input")
  pipeline.signal("input")
  await waitFor(() => emitted.length === 1)

  assert.equal(captures, 1)
  assert.deepEqual((emitted[0]?.data as { content: unknown[] }).content, [
    {
      type: "screen.activity",
      activityId: (emitted[0]?.data as { content: Array<{ activityId: string }> }).content[0]!.activityId,
    },
  ])
  const activityId = (emitted[0]?.data as { content: Array<{ activityId: string }> }).content[0]!.activityId
  const { stdout } = await execute(join(process.cwd(), "plugins/screen/bin/screen.mjs"), ["activity", activityId], {
    env: { ...process.env, CORALLUM_PLUGIN_STATE: root },
  })
  const activity = JSON.parse(stdout) as {
    app: { name: string }
    captures: Array<{ ocr: string; image: string; preview: string }>
  }
  assert.equal(activity.app.name, "Codex")
  assert.equal(activity.captures[0]?.ocr, "Implement the Screen Plugin")
  assert.equal(await readFile(activity.captures[0]!.image, "utf8"), "raw-image")
  assert.equal(await readFile(activity.captures[0]!.preview, "utf8"), "preview-image")
  pipeline.visual()
  await waitFor(() => captures === 2)
  assert.equal(emitted.length, 1)
  await pipeline.stop()
})

test("Screen history returns newest captures in batches of 20", async (t) => {
  const root = await temporary(t, "screen-history")
  const activities = join(root, "activities")
  await mkdir(activities, { recursive: true })
  for (let index = 0; index < 21; index += 1) {
    const id = `activity_${index}`
    const directory = join(activities, id)
    await mkdir(directory)
    await writeFile(join(directory, "activity.json"), JSON.stringify({
      id,
      app: { name: "Codex" },
      captures: [{ id: `capture_${index}`, capturedAt: new Date(index * 1_000).toISOString(), image: "image.png", preview: "preview.jpg", ocr: String(index) }],
    }))
  }
  const { readCaptures } = await import(pathToFileURL(join(process.cwd(), "plugins/screen/pipeline.mjs")).href) as {
    readCaptures(root: string, before?: string): Promise<{ items: Array<{ id: string }>; nextCursor: string | null }>
  }
  const first = await readCaptures(root)
  const second = await readCaptures(root, first.nextCursor!)
  assert.equal(first.items.length, 20)
  assert.equal(first.items[0]?.id, "capture_20")
  assert.deepEqual(second.items.map((capture) => capture.id), ["capture_0"])
  assert.equal(second.nextCursor, null)
})

test("Scheduler CLI owns recurring notes and its runtime emits due Communication", async (t) => {
  const root = await temporary(t, "scheduler")
  const emitted: PluginIngressDraft[] = []
  const env = {
    ...process.env,
    CORALLUM_PLUGIN_STATE: root,
    CORALLUM_AGENT_ID: "reviewer",
    CORALLUM_PLUGIN_MODE: "live",
  }
  const executable = join(process.cwd(), "plugins/scheduler/bin/scheduler.mjs")
  const { stdout } = await execute(
    executable,
    ["set", "--name", "periodic-audit", "--every", "6h", "--note", "Review the other Agents."],
    { env },
  )
  assert.equal((JSON.parse(stdout) as { name: string }).name, "periodic-audit")
  const scheduledAt = new Date(Date.now() - 1_000).toISOString()
  const schedulePath = join(root, "schedules", "reviewer", "periodic-audit.json")
  await writeFile(schedulePath, JSON.stringify({
    agentId: "reviewer",
    name: "periodic-audit",
    every: "6h",
    note: "Review the other Agents.",
    nextAt: scheduledAt,
  }))
  const runtime = await startPlugin("scheduler", root, emitted, "live", { CORALLUM_SCHEDULER_TICK_MS: "5" })
  await waitFor(() => emitted.length === 1)
  const draft = emitted[0]
  assert.equal(emitted.length, 1)
  assert.deepEqual((draft?.data as { to: string[] }).to, ["agent/reviewer"])
  assert.deepEqual((draft?.data as { content: unknown[] }).content, [{
    type: "schedule.fired",
    name: "periodic-audit",
    schedule: { every: "6h" },
    note: "Review the other Agents.",
    scheduledAt,
  }])
  await execute(executable, ["remove", "--name", "periodic-audit"], { env })
  assert.deepEqual(JSON.parse((await execute(executable, ["list"], { env })).stdout), [])
  await runtime.stop()
})

async function startPlugin(
  id: string,
  stateRoot: string,
  emitted: PluginIngressDraft[],
  mode = "live",
  env: Record<string, string> = {},
): Promise<RuntimeInstance> {
  const path = pathToFileURL(join(process.cwd(), "plugins", id, "runtime.mjs")).href
  const module = await import(path) as {
    start(input: {
      id: string
      mode: string
      stateRoot: string
      env: Record<string, string>
      emit(draft: PluginIngressDraft): Promise<void>
    }): Promise<RuntimeInstance>
  }
  return module.start({
    id,
    mode,
    stateRoot,
    env,
    emit: async (draft) => { emitted.push(draft) },
  })
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Plugin runtime")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function executeWithInput(
  file: string,
  args: string[],
  input: string,
  options: { env: NodeJS.ProcessEnv },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { ...options, stdio: ["pipe", "ignore", "pipe"] })
    let error = ""
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk) => { error += chunk })
    child.once("error", reject)
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(error || `Chat CLI exited ${code}`)))
    child.stdin.end(input)
  })
}

async function temporary(t: test.TestContext, name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `corallum-${name}-`))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}
