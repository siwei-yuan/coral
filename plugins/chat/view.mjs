export function createView({ messages, submit }) {
  return {
    plugin: "chat",
    title: "Chat",
    async render() {
      const items = await messages()
      const conversationId = items.at(-1)?.conversationId ?? "main"
      const content = items.map((item) => `
        <article class="chat-bubble ${item.direction}">
          <p>${escapeHtml(item.text)}</p>
          <small>${item.direction === "in" ? "You" : "Agent"} · ${escapeHtml(formatTime(item.at))}</small>
        </article>`).join("")
      return `<style>
        .chat-shell{max-width:780px;margin:auto}.chat-stream{min-height:300px;display:flex;flex-direction:column;gap:10px;padding:8px 0 24px}
        .chat-bubble{max-width:76%;padding:12px 15px;border-radius:19px;background:#eef5fc;align-self:flex-start}.chat-bubble.out{align-self:flex-end;background:#007aff;color:white}
        .chat-bubble p{margin:0;white-space:pre-wrap}.chat-bubble small{display:block;margin-top:5px;color:#6e6e73}.chat-bubble.out small{color:#d8ebff}
        .chat-compose{display:grid;grid-template-columns:1fr auto;gap:10px;align-items:end;padding-top:18px;border-top:1px solid rgba(60,60,67,.16)}.chat-compose textarea{min-height:70px}
        @media(max-width:640px){.chat-bubble{max-width:90%}.chat-compose{grid-template-columns:1fr}.chat-compose .button{justify-self:end}}
      </style><div class="chat-shell">
        <div class="chat-stream">${content || `<p class="empty">No messages yet</p>`}</div>
        <form class="chat-compose" method="post" action="/extensions/chat/send">
          <input type="hidden" name="conversationId" value="${escapeHtml(conversationId)}">
          <div class="field"><label for="chat-message">Message</label><textarea id="chat-message" name="text" required placeholder="Message your swarm"></textarea></div>
          <button class="button" type="submit">Send</button>
        </form>
      </div>`
    },
    async handle(action, input) {
      if (action !== "send") throw new Error(`Unknown Chat View action: ${action}`)
      await submit({
        userId: "local",
        conversationId: required(input, "conversationId"),
        text: required(input, "text"),
      })
    },
  }
}

function required(input, name) {
  const value = input.get(name)?.trim()
  if (!value) throw new Error(`Missing ${name}`)
  return value
}

function formatTime(value) {
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString("en", { dateStyle: "medium", timeStyle: "short" })
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character])
}
