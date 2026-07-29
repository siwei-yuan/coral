import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { ChatRuntime, ScreenRuntime, forkScope } from "../src/index.ts"
import { createFixture } from "../test-support/fixture.ts"

const execute = promisify(execFile)

test("Chat Runtime turns user input and an Agent CLI reply into auditable Communication", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "corallum-chat-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sent: unknown[] = []
  const chat = new ChatRuntime({ stateRoot: root, send: async (message) => sent.push(message) })
  const { swarm, ledger } = await createFixture(t)

  const inbound = swarm.ingest(
    chat.ingress({
      userId: "user-1",
      conversationId: "conversation-1",
      text: "hello",
      externalRef: "message-1",
    }),
  )
  assert.deepEqual((inbound.data as { to: string[] }).to, ["agent/builder"])

  const executable = chat.executable()
  await execute(
    executable.executable,
    [
      "reply",
      "--conversation",
      "conversation-1",
      "--to",
      "external/user/user-1",
      "--text",
      "hi",
      "--caused-by",
      inbound.id,
    ],
    { env: { ...process.env, ...executable.env } },
  )
  const [reply] = await chat.takeReplies("builder")
  assert.ok(reply)
  const outbound = swarm.ingest(reply)
  assert.deepEqual(outbound.causation, [inbound.id])
  await chat.deliver(outbound, swarm.pluginBindingForEgress("chat", outbound))
  assert.equal(sent.length, 1)

  const forked = ledger.append({ ...reply, scope: forkScope("fork-for-test") })
  assert.throws(() => swarm.pluginBindingForEgress("chat", forked), /Fork Events cannot use live external egress/)
})

test("Screen Runtime publishes an activity Event and its CLI reads App, OCR, and raw image", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "corallum-screen-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const screen = new ScreenRuntime(root)
  const event = await screen.publish({
    id: "activity-1",
    app: { name: "Codex", bundleId: "com.openai.codex" },
    startedAt: "2026-07-29T10:00:00Z",
    endedAt: "2026-07-29T10:05:00Z",
    captures: [
      {
        id: "capture-1",
        capturedAt: "2026-07-29T10:01:00Z",
        image: Buffer.from("raw-image"),
        ocr: "Implement the Screen Plugin",
      },
    ],
  })

  assert.equal(event.type, "communication.sent")
  assert.deepEqual((event.data as { content: unknown[] }).content, [
    { type: "screen.activity", activityId: "activity-1" },
  ])
  const executable = screen.executable()
  const { stdout } = await execute(executable.executable, ["activity", "activity-1"], {
    env: { ...process.env, ...executable.env },
  })
  const activity = JSON.parse(stdout) as {
    app: { name: string }
    captures: Array<{ ocr: string; image: string }>
  }
  assert.equal(activity.app.name, "Codex")
  assert.equal(activity.captures[0]?.ocr, "Implement the Screen Plugin")
  assert.equal(await readFile(activity.captures[0]!.image, "utf8"), "raw-image")
})
