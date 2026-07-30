import type { ViewExtensionLink } from "../extension.ts"
import { styles, viewScript } from "./assets.ts"
import { evolutionCanvas } from "./evolution.ts"
import { escapeHtml, shortId } from "./html.ts"
import type { DefaultViewModel } from "./project.ts"
import { topologySector } from "./topology.ts"

export function renderDefaultView(
  model: DefaultViewModel,
  extensions: ViewExtensionLink[] = [],
  notice?: string,
): string {
  const active = model.activeRevision
  return page(
    "Overview",
    `${notice ? `<p class="notice">${escapeHtml(notice)}</p>` : ""}
    <header class="hero">
      <div><p class="eyebrow">Human control plane</p><h1>Swarm evolution</h1><p>Every state and route is projected from the immutable Event Ledger.</p></div>
      ${active ? `<span class="status active"><i></i>Active · <code>${escapeHtml(shortId(active.id))}</code></span>` : ""}
    </header>
    <section class="surface evolution-section">
      <header class="section-head"><div><h2>Evolution Canvas</h2><p>Zoom into a running state to inspect its Agent and Plugin commit timeline.</p></div><span class="section-badge" data-evolution-mode>Revision map</span></header>
      ${model.evolution.length ? evolutionCanvas(model) : empty("No evolution recorded")}
    </section>
    ${renderTopologySection(model)}
    ${infoDialog()}`,
    extensions,
  )
}

export function renderTopologySection(model: DefaultViewModel): string {
  const active = model.activeRevision
  const head = model.events.at(-1)?.seq ?? 0
  return `<section class="surface topology-section" data-ledger-head="${head}">
    <header class="section-head"><div><h2>Swarm Topology</h2><p>Configured Agent routes and Plugin access, replayed directly from Ledger Events.</p></div><span class="section-badge" data-range-count>${model.events.length} Events</span></header>
    ${active ? topologySector(active.definition, model.events) : empty("No active Revision")}
  </section>`
}

export function renderExtensionPage(
  extension: ViewExtensionLink,
  content: string,
  extensions: ViewExtensionLink[],
  notice?: string,
): string {
  return page(
    extension.title,
    `${notice ? `<p class="notice">${escapeHtml(notice)}</p>` : ""}<header class="hero compact"><div><p class="eyebrow">Plugin view</p><h1>${escapeHtml(extension.title)}</h1></div></header><section class="surface extension" data-extension="${escapeHtml(extension.plugin)}">${content}</section>`,
    extensions,
    extension.plugin,
  )
}

function page(title: string, content: string, extensions: ViewExtensionLink[], active?: string): string {
  const links = extensions.map((item) => `<a class="nav-link${item.plugin === active ? " active" : ""}" href="/extensions/${encodeURIComponent(item.plugin)}"${item.plugin === active ? ` aria-current="page"` : ""}>${escapeHtml(item.title)}</a>`).join("")
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Corallum</title><style>${styles}</style></head><body class="${active ? "extension-page" : "overview-page"}"><nav><a class="brand" href="/">Corallum</a><div class="nav-items"><a class="nav-link${active ? "" : " active"}" href="/"${active ? "" : ` aria-current="page"`}>Overview</a>${links}</div></nav><main>${content}</main><script>${viewScript}</script></body></html>`
}

function infoDialog(): string {
  return `<dialog class="info-dialog" data-info-dialog><button class="dialog-close" type="button" data-dialog-close aria-label="Close">×</button><p class="eyebrow" data-dialog-meta></p><h2 data-dialog-title></h2><p data-dialog-detail></p></dialog>`
}

function empty(message: string): string {
  return `<p class="empty">${escapeHtml(message)}</p>`
}
