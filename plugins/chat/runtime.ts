import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { EventDraft } from "../../src/core/ledger/ledger.ts"
import { activeScope } from "../../src/core/ledger/ledger.ts"
import type { PluginBinding } from "../../src/core/swarm/definition.ts"
import type { PluginExecutable } from "../../src/harness/adapter.ts"

export interface ChatMessage {
  recipients: string[]
  conversationId: string
  content: Array<{ type: string; text: string }>
}

export interface ChatReply {
  conversationId: string
  to: string
  text: string
  causedBy: string
  queuedAt: string
  sentAt: string
}

type QueuedReply = Omit<ChatReply, "sentAt">

export class ChatRuntime {
  readonly id = "chat"
  readonly stateRoot: string
  readonly send: (message: ChatMessage) => Promise<unknown>

  constructor({ stateRoot, send }: { stateRoot: string; send: (message: ChatMessage) => Promise<unknown> }) {
    this.stateRoot = resolve(stateRoot)
    this.send = send
  }

  executable(): PluginExecutable {
    return {
      id: this.id,
      executable: fileURLToPath(new URL("bin/chat.mjs", import.meta.url)),
      env: { CORALLUM_PLUGIN_STATE: this.stateRoot },
    }
  }

  ingress({
    userId,
    conversationId,
    text,
    externalRef,
  }: {
    userId: string
    conversationId: string
    text: string
    externalRef?: string
  }): EventDraft {
    if (!userId || !conversationId || !text) throw new Error("Chat ingress requires user, conversation, and text")
    return {
      type: "communication.sent",
      actor: `external/user/${userId}`,
      scope: activeScope(),
      data: {
        conversationId,
        from: `external/user/${userId}`,
        to: [],
        content: [{ type: "text", text }],
        source: { plugin: this.id, externalRef },
      },
    }
  }

  async flushReplies(binding: PluginBinding): Promise<ChatReply[]> {
    if (binding.id !== this.id || binding.mode !== "live") throw new Error("Chat Plugin must be live to send replies")
    const outbox = join(this.stateRoot, "outbox")
    const sent = join(this.stateRoot, "sent")
    await Promise.all([mkdir(outbox, { recursive: true }), mkdir(sent, { recursive: true })])
    const files = (await readdir(outbox)).filter((file) => file.endsWith(".json")).sort()
    const delivered: ChatReply[] = []
    for (const file of files) {
      const path = join(outbox, file)
      const reply = validateReply(JSON.parse(await readFile(path, "utf8")))
      await this.send({
        recipients: [reply.to],
        conversationId: reply.conversationId,
        content: [{ type: "text", text: reply.text }],
      })
      const record = { ...reply, sentAt: new Date().toISOString() }
      await writeFile(join(sent, file), `${JSON.stringify(record)}\n`, { flag: "wx" })
      await rm(path)
      delivered.push(record)
    }
    return delivered
  }

  async replies(): Promise<ChatReply[]> {
    const sent = join(this.stateRoot, "sent")
    await mkdir(sent, { recursive: true })
    const files = (await readdir(sent)).filter((file) => file.endsWith(".json")).sort()
    return Promise.all(files.map(async (file) => validateSent(JSON.parse(await readFile(join(sent, file), "utf8")))))
  }
}

function validateReply(value: unknown): QueuedReply {
  if (!value || typeof value !== "object") throw new Error("Invalid Chat reply")
  const reply = value as Partial<QueuedReply>
  if (
    !reply.conversationId ||
    !reply.to?.startsWith("external/") ||
    !reply.text ||
    !reply.causedBy ||
    !reply.queuedAt
  ) {
    throw new Error("Invalid Chat reply")
  }
  return reply as QueuedReply
}

function validateSent(value: unknown): ChatReply {
  const reply = validateReply(value)
  const sentAt = (value as Partial<ChatReply>).sentAt
  if (!sentAt) throw new Error("Invalid sent Chat reply")
  return { ...reply, sentAt }
}
