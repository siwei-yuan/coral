import { readFile } from "node:fs/promises"

export function createView({ current }) {
  return {
    plugin: "screen",
    title: "Screen",
    async render() {
      const activity = await current()
      if (!activity) return `<p class="empty">No screen activity yet</p>`
      const captures = await Promise.all(activity.captures.map(async (capture) => {
        const image = (await readFile(capture.image)).toString("base64")
        return `<article class="screen-capture">
          <img src="data:image/jpeg;base64,${image}" alt="Screen captured at ${escapeHtml(capture.capturedAt)}">
          <div><p class="eyebrow">${escapeHtml(formatTime(capture.capturedAt))}</p><h3>Recognized text</h3><pre>${escapeHtml(capture.ocr || "No text recognized")}</pre></div>
        </article>`
      }))
      return `<style>
        .screen-head{display:flex;justify-content:space-between;gap:18px;align-items:flex-start;padding-bottom:18px;border-bottom:1px solid rgba(60,60,67,.16)}.screen-head h2{margin:3px 0}.screen-meta{text-align:right;color:#6e6e73}
        .screen-grid{display:grid;gap:18px;margin-top:20px}.screen-capture{display:grid;grid-template-columns:minmax(260px,1.35fr) minmax(220px,1fr);gap:18px;padding:14px;border:1px solid rgba(60,60,67,.16);border-radius:18px;background:#f5f5f7}
        .screen-capture img{width:100%;border-radius:12px;border:1px solid rgba(60,60,67,.16);background:white}.screen-capture h3{margin:4px 0 9px}.screen-capture pre{margin:0;white-space:pre-wrap;font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;color:#3a3a3c}
        @media(max-width:760px){.screen-head,.screen-capture{display:block}.screen-meta{text-align:left;margin-top:8px}.screen-capture>div{margin-top:14px}}
      </style><header class="screen-head"><div><p class="eyebrow">Current App session</p><h2>${escapeHtml(activity.app.name)}</h2><p>${escapeHtml(activity.app.bundleId ?? "Unknown bundle")}</p></div><p class="screen-meta">${escapeHtml(formatTime(activity.startedAt))}<br>to ${escapeHtml(formatTime(activity.endedAt))}</p></header><div class="screen-grid">${captures.join("")}</div>`
    },
  }
}

function formatTime(value) {
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString("en", { dateStyle: "medium", timeStyle: "short" })
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character])
}
