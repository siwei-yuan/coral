import assert from "node:assert/strict"
import { execFile } from "node:child_process"
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

  await execute(
    join(process.cwd(), "plugins/chat/bin/chat.mjs"),
    [
      "reply",
      "--conversation", "conversation-1",
      "--to", "external/user/local",
      "--text", "hi",
      "--caused-by", "event-1",
    ],
    { env: { ...process.env, CORALLUM_PLUGIN_STATE: root } },
  )
  const [replyFile] = await readdir(join(root, "outbox"))
  const reply = JSON.parse(await readFile(join(root, "outbox", replyFile!), "utf8")) as {
    text: string
    causedBy: string
  }
  assert.equal(reply.text, "hi")
  assert.equal(reply.causedBy, "event-1")
  await runtime.stop()
})

test("Screen runtime emits activity Communication and its CLI reads App, OCR, and raw image", async (t) => {
  const root = await temporary(t, "screen")
  const emitted: PluginIngressDraft[] = []
  const runtime = await startPlugin("screen", root, emitted, "live", { CORALLUM_SCREEN_TICK_MS: "5" })
  const inbox = join(root, "inbox")
  await mkdir(inbox, { recursive: true })
  await writeFile(join(inbox, "activity-1.json"), JSON.stringify({
    id: "activity-1",
    app: { name: "Codex", bundleId: "com.openai.codex" },
    startedAt: "2026-07-29T10:00:00Z",
    endedAt: "2026-07-29T10:05:00Z",
    captures: [{
      id: "capture-1",
      capturedAt: "2026-07-29T10:01:00Z",
      image: Buffer.from("raw-image").toString("base64"),
      ocr: "Implement the Screen Plugin",
    }],
  }))
  await waitFor(() => emitted.length === 1)

  assert.deepEqual((emitted[0]?.data as { content: unknown[] }).content, [
    { type: "screen.activity", activityId: "activity-1" },
  ])
  const { stdout } = await execute(join(process.cwd(), "plugins/screen/bin/screen.mjs"), ["activity", "activity-1"], {
    env: { ...process.env, CORALLUM_PLUGIN_STATE: root },
  })
  const activity = JSON.parse(stdout) as {
    app: { name: string }
    captures: Array<{ ocr: string; image: string }>
  }
  assert.equal(activity.app.name, "Codex")
  assert.equal(activity.captures[0]?.ocr, "Implement the Screen Plugin")
  assert.equal(await readFile(activity.captures[0]!.image, "utf8"), "raw-image")
  await runtime.stop()
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

async function temporary(t: test.TestContext, name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `corallum-${name}-`))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}
