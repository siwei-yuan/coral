export function createView({ messages, submit }) {
  return {
    plugin: "chat",
    title: "Chat",
    async render() {
      const items = await messages()
      const conversationId = items.at(-1)?.conversationId ?? "main"
      return `<style>
        .extension[data-extension="chat"]{overflow:visible;padding:0;border:0;border-radius:0;background:transparent;box-shadow:none;backdrop-filter:none}.chat-shell{max-width:920px;margin:auto}.chat-stream{height:clamp(320px,50vh,600px);min-height:320px;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;display:flex;flex-direction:column;gap:12px;padding:20px 4px 26px;scrollbar-gutter:stable}.chat-stream::-webkit-scrollbar{width:10px}.chat-stream::-webkit-scrollbar-thumb{border:3px solid transparent;border-radius:999px;background:color-mix(in srgb,var(--muted) 28%,transparent);background-clip:padding-box}
        .chat-bubble{max-width:min(72%,620px);padding:11px 15px 10px;border:1px solid color-mix(in srgb,var(--blue) 12%,var(--line));border-radius:20px 20px 20px 7px;background:color-mix(in srgb,var(--blue) 8%,var(--material-solid));align-self:flex-start;box-shadow:0 1px 2px rgba(0,0,0,.04);animation:chat-arrive .2s cubic-bezier(.2,.8,.2,1)}.chat-bubble.out{align-self:flex-end;border-color:transparent;border-radius:20px 20px 7px 20px;background:linear-gradient(145deg,#2189ff,var(--blue));color:white;box-shadow:0 8px 22px color-mix(in srgb,var(--blue) 20%,transparent)}.chat-bubble.pending{opacity:.66}
        .chat-text{font-size:15px;line-height:1.5}.chat-text p{margin:0;white-space:pre-wrap}.chat-text p+p{margin-top:.8em}.chat-bubble small{display:block;margin-top:5px;color:var(--muted);font-size:11px;letter-spacing:.01em}.chat-bubble.out small{color:rgba(255,255,255,.72)}
        .chat-compose{position:relative;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center;margin-top:12px;padding:9px 9px 9px 15px;border:1px solid var(--line);border-radius:22px;background:color-mix(in srgb,var(--material-solid) 90%,transparent);box-shadow:0 8px 26px rgba(20,42,66,.07)}.chat-compose .field{display:block}.chat-compose label{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}.chat-compose textarea{min-height:48px;max-height:160px;padding:12px 4px;border:0;background:transparent;resize:none;outline:0;line-height:1.45}.chat-compose textarea:focus-visible{outline:0}.chat-compose .button{min-width:78px;min-height:42px}.chat-status{min-height:18px;margin:7px 8px 0;color:var(--muted);font-size:11px}
        @keyframes chat-arrive{from{opacity:0;transform:translateY(4px) scale(.985)}to{opacity:1;transform:none}}
        @media(max-width:640px){.chat-stream{height:clamp(300px,52vh,480px);min-height:300px}.chat-bubble{max-width:88%}.chat-compose{grid-template-columns:1fr;padding-left:12px}.chat-compose .button{justify-self:end;position:absolute;right:17px;bottom:25px}.chat-compose textarea{padding-right:78px}}
        @media(prefers-reduced-motion:reduce){.chat-bubble{animation:none}}
      </style><div class="chat-shell" data-chat-view>
        <div class="chat-stream" data-chat-stream aria-live="polite">${items.map(renderMessage).join("") || `<p class="empty">No messages yet</p>`}</div>
        <form class="chat-compose" method="post" action="/extensions/chat/send" data-chat-form>
          <input type="hidden" name="conversationId" value="${escapeHtml(conversationId)}">
          <div class="field"><label for="chat-message">Message</label><textarea id="chat-message" name="text" required placeholder="Message your swarm"></textarea></div>
          <button class="button" type="submit">Send</button>
        </form>
        <p class="chat-status" data-chat-status role="status"></p>
      </div><script>${chatScript}</script>`
    },
    async read(resource) {
      if (resource !== "messages") throw new Error(`Unknown Chat View resource: ${resource}`)
      return json(await messages())
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

function renderMessage(item) {
  return `<article class="chat-bubble ${item.direction}" data-message-id="${escapeHtml(item.id)}"><div class="chat-text">${renderText(item.text)}</div><small>${item.direction === "in" ? "You" : "Agent"} · ${escapeHtml(formatTime(item.at))}</small></article>`
}

function renderText(value) {
  return String(value).replaceAll("\r\n", "\n").split(/\n{2,}/).map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join("")
}

function required(input, name) {
  const value = input.get(name)?.trim()
  if (!value) throw new Error(`Missing ${name}`)
  return value
}

function json(value) {
  return { contentType: "application/json; charset=utf-8", body: JSON.stringify(value) }
}

function formatTime(value) {
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString("en", { dateStyle: "medium", timeStyle: "short" })
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character])
}

const chatScript = String.raw`
(() => {
  const root = document.querySelector('[data-chat-view]')
  const stream = root.querySelector('[data-chat-stream]')
  const form = root.querySelector('[data-chat-form]')
  const button = form.querySelector('button')
  const status = root.querySelector('[data-chat-status]')
  let pending = null
  let refreshing = false

  function bubble(item) {
    const article = document.createElement('article')
    article.className = 'chat-bubble ' + item.direction + (item.pending ? ' pending' : '')
    article.dataset.messageId = item.id
    const body = document.createElement('div')
    body.className = 'chat-text'
    for (const text of String(item.text).replaceAll('\r\n', '\n').split(/\n{2,}/)) {
      const paragraph = document.createElement('p')
      paragraph.textContent = text
      body.append(paragraph)
    }
    const meta = document.createElement('small')
    const time = item.pending ? 'Sending…' : new Date(item.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
    meta.textContent = (item.direction === 'in' ? 'You' : 'Agent') + ' · ' + time
    article.append(body, meta)
    return article
  }

  function sync(items) {
    stream.querySelector('.empty')?.remove()
    const existing = new Map([...stream.querySelectorAll('.chat-bubble:not(.pending)')].map((node) => [node.dataset.messageId, node]))
    const accepted = pending && items.find((item) => item.direction === 'in' && item.text === pending.text && item.at >= pending.startedAt)
    if (accepted) {
      stream.querySelector('.chat-bubble.pending')?.replaceWith(bubble(accepted))
      existing.set(accepted.id, stream.querySelector('[data-message-id="' + accepted.id + '"]'))
      pending = null
    }
    for (const item of items) {
      if (!existing.has(item.id)) stream.append(bubble(item))
    }
    if (!items.length && !pending) {
      const empty = document.createElement('p')
      empty.className = 'empty'
      empty.textContent = 'No messages yet'
      stream.append(empty)
    }
  }

  async function refresh() {
    if (refreshing) return
    refreshing = true
    try {
      const nearBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 80
      const response = await fetch('/extensions/chat/messages', { cache: 'no-store' })
      if (!response.ok) throw new Error('Unable to refresh messages')
      const items = await response.json()
      sync(items)
      if (nearBottom) stream.scrollTop = stream.scrollHeight
      status.textContent = ''
    } catch (error) {
      status.textContent = error.message
    } finally {
      refreshing = false
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (pending) return
    const data = new URLSearchParams(new FormData(form))
    const text = String(data.get('text') || '').trim()
    if (!text) return
    const now = new Date().toISOString()
    pending = { id: 'pending', text, at: now, startedAt: now }
    form.querySelector('textarea').value = ''
    button.disabled = true
    status.textContent = 'Sending…'
    stream.append(bubble({ ...pending, direction: 'in', pending: true }))
    stream.scrollTop = stream.scrollHeight
    try {
      const response = await fetch(form.action, { method: 'POST', body: data })
      if (!response.ok) throw new Error('Message was not accepted')
    } catch (error) {
      status.textContent = error.message
      pending = null
    } finally {
      button.disabled = false
      await refresh()
    }
  })

  stream.scrollTop = stream.scrollHeight
  setInterval(refresh, 1000)
  refresh()
})()
`
