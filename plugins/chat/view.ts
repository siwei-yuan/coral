import type { EventDraft, LedgerEvent } from "../../src/core/ledger/ledger.ts"
import type { ViewExtension } from "../../src/view/extension.ts"
import { escapeHtml } from "../../src/view/default/render.ts"
import type { ChatReply } from "./runtime.ts"
import { ChatRuntime } from "./runtime.ts"

interface ChatViewInput {
  runtime: ChatRuntime
  events: () => LedgerEvent[]
  submit: (event: EventDraft) => Promise<void>
  userId: string
}

interface ChatItem {
  direction: "in" | "out"
  conversationId: string
  text: string
  at: string
}

export class ChatView implements ViewExtension {
  readonly plugin = "chat"
  readonly title = "Chat"
  readonly runtime: ChatRuntime
  readonly events: () => LedgerEvent[]
  readonly submit: (event: EventDraft) => Promise<void>
  readonly userId: string

  constructor({ runtime, events, submit, userId }: ChatViewInput) {
    this.runtime = runtime
    this.events = events
    this.submit = submit
    this.userId = userId
  }

  async render(): Promise<string> {
    const items = [...inbound(this.events()), ...outbound(await this.runtime.replies())]
      .sort((left, right) => left.at.localeCompare(right.at))
    const conversationId = items.at(-1)?.conversationId ?? "main"
    const messages = items.map((item) => `
      <article class="chat-bubble ${item.direction}">
        <p>${escapeHtml(item.text)}</p>
        <small>${item.direction === "in" ? "You" : "Agent"} · ${escapeHtml(formatTime(item.at))}</small>
      </article>`).join("")
    return `<style>
      .chat-shell{max-width:780px;margin:auto}.chat-stream{min-height:300px;display:flex;flex-direction:column;gap:10px;padding:8px 0 24px}
      .chat-bubble{max-width:76%;padding:12px 15px;border-radius:19px;background:#eef5fc;align-self:flex-start}.chat-bubble.out{align-self:flex-end;background:#0677e8;color:white}
      .chat-bubble p{margin:0;white-space:pre-wrap}.chat-bubble small{display:block;margin-top:5px;color:#6a7f96}.chat-bubble.out small{color:#d8ebff}
      .chat-compose{display:grid;grid-template-columns:1fr auto;gap:10px;align-items:end;padding-top:18px;border-top:1px solid #dce7f2}.chat-compose textarea{min-height:70px}
      @media(max-width:640px){.chat-bubble{max-width:90%}.chat-compose{grid-template-columns:1fr}.chat-compose .button{justify-self:end}}
    </style><div class="chat-shell">
      <div class="chat-stream">${messages || `<p class="empty">No messages yet</p>`}</div>
      <form class="chat-compose" method="post" action="/extensions/chat/send">
        <input type="hidden" name="conversationId" value="${escapeHtml(conversationId)}">
        <div class="field"><label for="chat-message">Message</label><textarea id="chat-message" name="text" required placeholder="Message your swarm"></textarea></div>
        <button class="button" type="submit">Send</button>
      </form>
    </div>`
  }

  async handle(action: string, input: URLSearchParams): Promise<void> {
    if (action !== "send") throw new Error(`Unknown Chat View action: ${action}`)
    const conversationId = required(input, "conversationId")
    const text = required(input, "text")
    await this.submit(this.runtime.ingress({ userId: this.userId, conversationId, text }))
  }
}

function inbound(events: LedgerEvent[]): ChatItem[] {
  return events.flatMap((event): ChatItem[] => {
    if (event.type !== "communication.sent" || !event.data || typeof event.data !== "object") return []
    const data = event.data as {
      conversationId?: unknown
      source?: { plugin?: unknown }
      content?: Array<{ type?: unknown; text?: unknown }>
    }
    if (data.source?.plugin !== "chat" || typeof data.conversationId !== "string") return []
    const text = data.content?.find((item) => item.type === "text" && typeof item.text === "string")?.text
    return typeof text === "string"
      ? [{ direction: "in", conversationId: data.conversationId, text, at: event.recordedAt }]
      : []
  })
}

function outbound(replies: ChatReply[]): ChatItem[] {
  return replies.map((reply) => ({
    direction: "out",
    conversationId: reply.conversationId,
    text: reply.text,
    at: reply.sentAt,
  }))
}

function required(input: URLSearchParams, name: string): string {
  const value = input.get(name)?.trim()
  if (!value) throw new Error(`Missing ${name}`)
  return value
}

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString("en", { dateStyle: "medium", timeStyle: "short" })
}
