import { mkdir, readFile, readdir, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { EventDraft, LedgerEvent } from "../../src/core/ledger/ledger.ts"
import { activeScope } from "../../src/core/ledger/ledger.ts"
import type { PluginBinding } from "../../src/core/swarm/definition.ts"
import type { PluginExecutable } from "../../src/harness/adapter.ts"

interface ChatMessage {
  recipients: string[]
  conversationId: string
  content: Array<{ type: string; text: string }>
}

interface QueuedReply {
  conversationId: string
  to: string
  text: string
  causedBy: string
}

interface CommunicationData {
  conversationId: string
  from: string
  to: string[]
  content: Array<{ type: string; text: string }>
}

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

  async takeReplies(agentId: string): Promise<EventDraft[]> {
    if (!agentId) throw new Error("Chat reply requires an Agent")
    const outbox = join(this.stateRoot, "outbox")
    await mkdir(outbox, { recursive: true })
    const files = (await readdir(outbox)).filter((file) => file.endsWith(".json")).sort()
    const replies: EventDraft[] = []
    for (const file of files) {
      const path = join(outbox, file)
      const reply = validateReply(JSON.parse(await readFile(path, "utf8")))
      replies.push({
        type: "communication.sent",
        actor: `agent/${agentId}`,
        scope: activeScope(),
        causation: [reply.causedBy],
        data: {
          conversationId: reply.conversationId,
          from: `agent/${agentId}`,
          to: [reply.to],
          content: [{ type: "text", text: reply.text }],
        },
      })
      await rm(path)
    }
    return replies
  }

  async deliver(event: LedgerEvent, binding: PluginBinding): Promise<unknown> {
    if (event.type !== "communication.sent") throw new Error("Chat delivery consumes communication.sent")
    if (event.scope.kind !== "active" || binding.mode !== "live") {
      throw new Error("Only active Swarm Events may use live Chat delivery")
    }
    const data = event.data as CommunicationData
    const recipients = data.to.filter((recipient) => recipient.startsWith("external/"))
    if (recipients.length === 0) throw new Error("Chat delivery requires an external recipient")
    return this.send({ recipients, conversationId: data.conversationId, content: data.content })
  }
}

function validateReply(value: unknown): QueuedReply {
  if (!value || typeof value !== "object") throw new Error("Invalid Chat reply")
  const reply = value as Partial<QueuedReply>
  if (!reply.conversationId || !reply.to?.startsWith("external/") || !reply.text || !reply.causedBy) {
    throw new Error("Invalid Chat reply")
  }
  return reply as QueuedReply
}
