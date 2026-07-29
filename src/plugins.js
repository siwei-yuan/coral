import { activeScope } from "./ledger.js"

export class ChatPlugin {
  constructor({ id = "chat", send }) {
    this.id = id
    this.send = send
  }

  ingress({ userId, conversationId, text, externalRef }) {
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

  async egress(event, binding) {
    if (event.type !== "communication.sent") throw new Error("Chat egress consumes communication.sent")
    if (event.scope.kind !== "active" || binding.mode !== "live") {
      throw new Error("Only active Swarm Events may use live Chat egress")
    }
    const externalRecipients = event.data.to.filter((recipient) => recipient.startsWith("external/"))
    if (externalRecipients.length === 0) throw new Error("Chat egress requires an external recipient")
    return this.send({
      recipients: externalRecipients,
      conversationId: event.data.conversationId,
      content: event.data.content,
    })
  }
}
