import { readFile } from "node:fs/promises"

export function createView({ captures, capture }) {
  return {
    plugin: "screen",
    title: "Screen",
    async render() {
      return `<style>
        .extension[data-extension="screen"]{padding:18px}.screen-shell{min-height:520px}.screen-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:18px}.screen-card{display:block;padding:0;overflow:hidden;border:1px solid var(--line);border-radius:20px;background:var(--material-solid);color:inherit;text-align:left;cursor:pointer;box-shadow:0 1px 2px rgba(0,0,0,.04);transition:transform .2s cubic-bezier(.2,.8,.2,1),border-color .18s ease,box-shadow .2s ease;-webkit-tap-highlight-color:transparent}.screen-card:hover{border-color:color-mix(in srgb,var(--blue) 48%,var(--line));box-shadow:0 14px 34px rgba(25,54,82,.13);transform:translateY(-2px)}.screen-card:active{transform:scale(.98)}
        .screen-card img{display:block;width:100%;aspect-ratio:16/10;object-fit:cover;background:linear-gradient(145deg,var(--canvas),var(--canvas-soft));transition:transform .28s cubic-bezier(.2,.8,.2,1)}.screen-card:hover img{transform:scale(1.018)}.screen-card span{position:relative;display:block;padding:12px 14px 13px;background:var(--material-solid)}.screen-card strong,.screen-card small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.screen-card strong{font-size:14px;letter-spacing:-.01em}.screen-card small{margin-top:3px;color:var(--muted);font-size:11px}.screen-sentinel{height:1px}.screen-status{margin:20px 0 4px;color:var(--muted);font-size:12px;text-align:center}
        .screen-dialog{width:min(1160px,calc(100vw - 32px));height:min(760px,calc(100vh - 32px));padding:0;overflow:hidden;border:1px solid var(--material-edge);border-radius:28px;background:var(--material);color:var(--ink);box-shadow:0 36px 110px rgba(0,0,0,.38);backdrop-filter:saturate(170%) blur(30px)}.screen-dialog[open]{animation:screen-materialize .24s cubic-bezier(.2,.8,.2,1)}.screen-dialog::backdrop{background:rgba(5,9,15,.34);backdrop-filter:blur(18px);animation:screen-fade .2s ease-out}.screen-detail{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(330px,.72fr);height:100%;min-height:0}.screen-detail-image{display:flex;min-height:0;align-items:center;justify-content:center;padding:26px;background:radial-gradient(circle at 50% 42%,#24262a,#0a0b0d 68%)}.screen-detail-image img{max-width:100%;max-height:100%;border-radius:14px;box-shadow:0 18px 48px rgba(0,0,0,.35)}.screen-detail-copy{display:grid;grid-template-rows:auto minmax(0,1fr);min-height:0;padding:34px}.screen-detail-copy h2{margin:5px 44px 6px 0;font-size:28px;line-height:1.08;letter-spacing:-.035em}.screen-detail-panels{display:grid;grid-template-rows:repeat(2,minmax(0,1fr));min-height:0;gap:18px;margin-top:24px}.screen-detail-panel{display:grid;grid-template-rows:auto minmax(0,1fr);min-height:0}.screen-detail-copy h3{margin:0 0 9px;color:var(--muted);font-size:11px;font-weight:650;letter-spacing:.08em;text-transform:uppercase}.screen-detail-copy pre{min-height:0;margin:0;padding:14px;overflow:auto;overscroll-behavior:contain;border:1px solid color-mix(in srgb,var(--line) 74%,transparent);border-radius:14px;background:var(--canvas-soft);white-space:pre-wrap;word-break:break-word;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}.screen-close{position:absolute;right:18px;top:18px;z-index:2;width:34px;height:34px;border:1px solid color-mix(in srgb,var(--line) 70%,transparent);border-radius:50%;background:color-mix(in srgb,var(--material-solid) 82%,transparent);color:var(--ink);font-size:21px;line-height:1;cursor:pointer;backdrop-filter:blur(16px)}
        @keyframes screen-materialize{from{opacity:0;transform:scale(.965) translateY(8px)}to{opacity:1;transform:none}}@keyframes screen-fade{from{opacity:0}to{opacity:1}}
        @media(max-width:760px){.extension[data-extension="screen"]{padding:10px}.screen-grid{grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px}.screen-card{border-radius:16px}.screen-card span{padding:10px 11px}.screen-dialog{width:calc(100vw - 20px);height:calc(100vh - 20px);border-radius:22px}.screen-detail{grid-template-columns:1fr;grid-template-rows:minmax(180px,32%) minmax(0,1fr)}.screen-detail-image{padding:14px}.screen-detail-copy{padding:20px}.screen-detail-copy h2{font-size:24px}.screen-detail-panels{gap:12px;margin-top:16px}}
        @media(prefers-reduced-motion:reduce){.screen-card,.screen-card img,.screen-dialog[open],.screen-dialog::backdrop{animation:none;transition:none}.screen-card:hover,.screen-card:hover img{transform:none}}
        @media(prefers-reduced-transparency:reduce){.screen-dialog,.screen-close{background:var(--material-solid);backdrop-filter:none}.screen-dialog::backdrop{backdrop-filter:none}}
      </style><div class="screen-shell" data-screen-view><div class="screen-grid" data-screen-grid aria-label="Screen activity history"></div><p class="screen-status" data-screen-status role="status">Loading activity…</p><div class="screen-sentinel" data-screen-sentinel></div><dialog class="screen-dialog" data-screen-dialog aria-labelledby="screen-detail-title"><button class="screen-close" type="button" aria-label="Close">×</button><div class="screen-detail"><div class="screen-detail-image"><img data-screen-detail-image alt="Screen preview"></div><div class="screen-detail-copy"><header><p class="eyebrow" data-screen-detail-time></p><h2 id="screen-detail-title" data-screen-detail-app></h2></header><div class="screen-detail-panels"><section class="screen-detail-panel"><h3>OCR</h3><pre data-screen-detail-ocr></pre></section><section class="screen-detail-panel"><h3>Raw Ledger Event</h3><pre data-screen-detail-event></pre></section></div></div></div></dialog></div><script>${screenScript}</script>`
    },
    async read(resource, input, context) {
      if (resource === "captures") return json(await captures(input.get("before") || undefined))
      const activityId = required(input, "activity")
      const captureId = required(input, "capture")
      const item = await capture(activityId, captureId)
      if (resource === "preview") return { contentType: "image/jpeg", body: await readFile(item.preview) }
      if (resource === "capture") return json({
        activityId: item.activityId,
        app: item.app,
        capturedAt: item.capturedAt,
        ocr: item.ocr,
        previewUrl: previewUrl(item.activityId, item.id),
        event: context.events.find((event) => externalRef(event) === item.activityId) ?? null,
      })
      throw new Error(`Unknown Screen View resource: ${resource}`)
    },
  }
}

function previewUrl(activityId, captureId) {
  return `/extensions/screen/preview?activity=${encodeURIComponent(activityId)}&capture=${encodeURIComponent(captureId)}`
}

function externalRef(event) {
  return event.data && typeof event.data === "object" ? event.data.source?.externalRef : undefined
}

function required(input, name) {
  const value = input.get(name)
  if (!value) throw new Error(`Missing ${name}`)
  return value
}

function json(value) {
  return { contentType: "application/json; charset=utf-8", body: JSON.stringify(value) }
}

const screenScript = String.raw`
(() => {
  const root = document.querySelector('[data-screen-view]')
  const grid = root.querySelector('[data-screen-grid]')
  const status = root.querySelector('[data-screen-status]')
  const sentinel = root.querySelector('[data-screen-sentinel]')
  const dialog = root.querySelector('[data-screen-dialog]')
  const seen = new Set()
  let cursor = null
  let loading = false
  let complete = false

  function preview(item) {
    return '/extensions/screen/preview?activity=' + encodeURIComponent(item.activityId) + '&capture=' + encodeURIComponent(item.id)
  }

  function card(item) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'screen-card'
    button.dataset.capture = item.id
    const image = document.createElement('img')
    image.loading = 'lazy'
    image.src = preview(item)
    image.alt = 'Screen captured at ' + item.capturedAt
    const copy = document.createElement('span')
    const app = document.createElement('strong')
    const time = document.createElement('small')
    app.textContent = item.app.name
    time.textContent = new Date(item.capturedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
    copy.append(app, time)
    button.append(image, copy)
    button.addEventListener('click', () => open(item))
    return button
  }

  function append(items) {
    for (const item of items) {
      if (seen.has(item.id)) continue
      seen.add(item.id)
      grid.append(card(item))
    }
  }

  async function load() {
    if (loading || complete) return
    loading = true
    status.textContent = 'Loading…'
    try {
      const path = '/extensions/screen/captures' + (cursor ? '?before=' + encodeURIComponent(cursor) : '')
      const response = await fetch(path, { cache: 'no-store' })
      if (!response.ok) throw new Error('Unable to load Screen history')
      const page = await response.json()
      append(page.items)
      cursor = page.nextCursor
      complete = !cursor
      status.textContent = complete ? (seen.size ? 'End of history' : 'No screen activity yet') : ''
    } catch (error) {
      status.textContent = error.message
    } finally {
      loading = false
    }
  }

  async function open(item) {
    status.textContent = 'Loading detail…'
    try {
      const path = '/extensions/screen/capture?activity=' + encodeURIComponent(item.activityId) + '&capture=' + encodeURIComponent(item.id)
      const response = await fetch(path, { cache: 'no-store' })
      if (!response.ok) throw new Error('Unable to load Screen detail')
      const detail = await response.json()
      root.querySelector('[data-screen-detail-image]').src = detail.previewUrl
      root.querySelector('[data-screen-detail-time]').textContent = new Date(detail.capturedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
      root.querySelector('[data-screen-detail-app]').textContent = detail.app.name
      root.querySelector('[data-screen-detail-ocr]').textContent = detail.ocr || 'No text recognized'
      root.querySelector('[data-screen-detail-event]').textContent = detail.event ? JSON.stringify(detail.event, null, 2) : 'No matching Ledger Event'
      dialog.showModal()
      status.textContent = ''
    } catch (error) {
      status.textContent = error.message
    }
  }

  dialog.querySelector('.screen-close').addEventListener('click', () => dialog.close())
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close()
  })
  new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) load()
  }).observe(sentinel)
})()
`
