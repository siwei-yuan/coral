import type { EventDraft, LedgerEvent } from "../core/ledger/ledger.ts"
import { activeScope } from "../core/ledger/ledger.ts"
import type { PluginBinding } from "../core/swarm/definition.ts"

interface ChatMessage {
  recipients: string[]
  conversationId: string
  content: Array<{ type: string; text: string }>
}

interface CommunicationData {
  conversationId: string
  from: string
  to: string[]
  content: Array<{ type: string; text: string }>
  source?: { plugin: string; externalRef?: string }
}

export class ChatPlugin {
  readonly id: string
  readonly send: (message: ChatMessage) => Promise<unknown>

  constructor({ id = "chat", send }: { id?: string; send: (message: ChatMessage) => Promise<unknown> }) {
    this.id = id
    this.send = send
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

  async egress(event: LedgerEvent, binding: PluginBinding): Promise<unknown> {
    if (event.type !== "communication.sent") throw new Error("Chat egress consumes communication.sent")
    if (event.scope.kind !== "active" || binding.mode !== "live") {
      throw new Error("Only active Swarm Events may use live Chat egress")
    }
    const data = event.data as CommunicationData
    const externalRecipients = data.to.filter((recipient) => recipient.startsWith("external/"))
    if (externalRecipients.length === 0) throw new Error("Chat egress requires an external recipient")
    return this.send({ recipients: externalRecipients, conversationId: data.conversationId, content: data.content })
  }
}
