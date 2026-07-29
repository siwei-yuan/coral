import { mkdir, rename, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import type { EventDraft } from "../../src/core/ledger/ledger.ts"
import { activeScope } from "../../src/core/ledger/ledger.ts"
import type { PluginExecutable } from "../../src/harness/adapter.ts"

export interface ScreenCaptureInput {
  id?: string
  capturedAt: string
  image: Uint8Array
  ocr: string
}

export interface ScreenActivityInput {
  id?: string
  app: { name: string; bundleId?: string }
  startedAt: string
  endedAt: string
  captures: ScreenCaptureInput[]
}

export interface ScreenActivity {
  id: string
  app: { name: string; bundleId?: string }
  startedAt: string
  endedAt: string
  captures: Array<{ id: string; capturedAt: string; image: string; ocr: string }>
}

export class ScreenRuntime {
  readonly id = "screen"
  readonly stateRoot: string

  constructor(stateRoot: string) {
    this.stateRoot = resolve(stateRoot)
  }

  executable(): PluginExecutable {
    return {
      id: this.id,
      executable: fileURLToPath(new URL("bin/screen.mjs", import.meta.url)),
      env: { CORALLUM_PLUGIN_STATE: this.stateRoot },
    }
  }

  async publish(input: ScreenActivityInput): Promise<EventDraft> {
    if (!input.app.name || !input.startedAt || !input.endedAt || input.captures.length === 0) {
      throw new Error("Screen activity requires App session and captures")
    }
    const id = input.id ?? `activity_${randomUUID()}`
    assertId(id)
    const observations = join(this.stateRoot, "activities")
    const temporary = join(this.stateRoot, `.tmp-${id}`)
    const destination = join(observations, id)
    await mkdir(join(temporary, "captures"), { recursive: true })

    const captures = []
    for (const capture of input.captures) {
      if (!capture.capturedAt) throw new Error("Screen capture requires time")
      const captureId = capture.id ?? `capture_${randomUUID()}`
      assertId(captureId)
      const image = `captures/${captureId}.png`
      await writeFile(join(temporary, image), capture.image)
      captures.push({ id: captureId, capturedAt: capture.capturedAt, image, ocr: capture.ocr })
    }

    const activity: ScreenActivity = {
      id,
      app: { ...input.app },
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      captures,
    }
    await writeFile(join(temporary, "activity.json"), `${JSON.stringify(activity, null, 2)}\n`, "utf8")
    await mkdir(observations, { recursive: true })
    await rename(temporary, destination)
    await writeFile(join(this.stateRoot, "current.json"), `${JSON.stringify({ activityId: id })}\n`, "utf8")

    return {
      type: "communication.sent",
      actor: "plugin/screen",
      scope: activeScope(),
      data: {
        from: "plugin/screen",
        to: [],
        source: { plugin: this.id, externalRef: id },
        content: [{ type: "screen.activity", activityId: id }],
      },
    }
  }
}

function assertId(id: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid Screen activity identifier: ${id}`)
}
