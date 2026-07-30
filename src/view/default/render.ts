import type { SwarmDefinition } from "../../core/swarm/definition.ts"
import type { ViewExtensionLink } from "../extension.ts"
import type {
  AgentStateView,
  DefaultViewModel,
  EvolutionNodeView,
  ForkView,
  PluginView,
  TurnView,
} from "./project.ts"

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
      <div><p class="eyebrow">Human control plane</p><h1>Swarm evolution</h1><p>Every branch is projected from immutable Ledger facts.</p></div>
      ${active ? `<span class="status active"><i></i>Active · <code>${short(active.id)}</code></span>` : ""}
    </header>
    <section class="surface evolution-section">
      <header class="section-head"><div><h2>Evolution tree</h2><p>Drag to move · scroll or use controls to zoom · select a node for evidence</p></div></header>
      ${model.evolution.length ? evolutionCanvas(model.evolution) : empty("No evolution recorded")}
    </section>
    <div class="primary-grid section">
      <section class="surface wide">
        <header class="section-head"><div><h2>Active swarm</h2><p>${active?.definition.agents.length ?? 0} Agents · ${model.plugins.length} Plugins</p></div></header>
        ${active ? topology(active.definition) : empty("No active Revision")}
      </section>
      <aside class="surface">
        <header class="section-head"><div><h2>Main snapshot</h2><p>Revision and current heads</p></div></header>
        ${active ? snapshot(model) : empty("Not bootstrapped")}
      </aside>
    </div>
    <section class="surface section">
      <header class="section-head"><div><h2>Agent state</h2><p>Workspace head + resumable Harness checkpoint</p></div></header>
      ${model.agents.length ? `<div class="agent-grid">${model.agents.map(renderAgent).join("")}</div>` : empty("No active Agents")}
    </section>
    <section class="surface section">
      <header class="section-head"><div><h2>Fork comparison</h2><p>Recorded evidence at each isolated frontier</p></div></header>
      ${model.forks.length ? `<div class="fork-grid">${model.forks.map(renderFork).join("")}</div>` : empty("No Forks yet")}
    </section>
    <section class="surface section">
      <header class="section-head"><div><h2>Agent turns</h2><p>Input Events → trajectory → committed effects</p></div></header>
      ${model.turns.length ? `<div class="turn-list">${model.turns.slice(-20).reverse().map(renderTurn).join("")}</div>` : empty("No Agent turns recorded")}
    </section>
    <section class="surface section">
      <header class="section-head"><div><h2>Plugin capabilities</h2><p>Inbound Events and Agent-visible CLIs</p></div></header>
      ${model.plugins.length ? `<div class="plugin-grid">${model.plugins.map(renderPlugin).join("")}</div>` : empty("No Plugins in this Revision")}
    </section>
    <details class="surface section ledger-disclosure">
      <summary><span><strong>Ledger</strong><small>${model.events.length} immutable Events</small></span><span class="disclosure-label">Show events</span></summary>
      <ol class="events">${model.events.slice(-100).reverse().map(renderEvent).join("")}</ol>
    </details>`,
    extensions,
  )
}

export function renderExtensionPage(
  extension: ViewExtensionLink,
  content: string,
  extensions: ViewExtensionLink[],
  notice?: string,
): string {
  return page(
    extension.title,
    `${notice ? `<p class="notice">${escapeHtml(notice)}</p>` : ""}<header class="hero compact"><div><p class="eyebrow">${escapeHtml(extension.plugin)} extension</p><h1>${escapeHtml(extension.title)}</h1></div></header><section class="surface extension">${content}</section>`,
    extensions,
    extension.plugin,
  )
}

function page(title: string, content: string, extensions: ViewExtensionLink[], active?: string): string {
  const extensionLinks = extensions.map((item) => `<a class="nav-link${item.plugin === active ? " active" : ""}" href="/extensions/${encodeURIComponent(item.plugin)}">${escapeHtml(item.title)}</a>`).join("")
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Corallum</title><style>${styles}</style></head><body><nav><a class="brand" href="/">Corallum</a><div class="nav-items"><a class="nav-link${active ? "" : " active"}" href="/">Overview</a>${extensionLinks}</div></nav><main>${content}</main><script>${canvasScript}</script></body></html>`
}

function evolutionCanvas(nodes: EvolutionNodeView[]): string {
  const laneWidth = 58
  const rowHeight = 112
  const railWidth = Math.max(152, (Math.max(...nodes.map((node) => node.lane)) + 1) * laneWidth + 48)
  const width = Math.max(980, railWidth + 720)
  const height = Math.max(430, nodes.length * rowHeight + 52)
  const positions = new Map(nodes.map((node, index) => [node.id, {
    x: 34 + node.lane * laneWidth,
    y: 34 + index * rowHeight,
  }]))
  const lines = nodes.flatMap((node) => {
    if (!node.parentId) return []
    const from = positions.get(node.parentId)
    const to = positions.get(node.id)
    if (!from || !to) return []
    const middle = from.y + Math.max(28, (to.y - from.y) / 2)
    const kind = node.kind === "fork" ? "branch" : node.kind === "revision" ? "merge" : node.status === "denied" ? "denied" : "continue"
    return [`<path class="tree-edge ${kind}" d="M${from.x} ${from.y} C${from.x} ${middle},${to.x} ${middle},${to.x} ${to.y}"/>`]
  }).join("")
  const dots = nodes.map((node) => {
    const point = positions.get(node.id)!
    return `<g class="tree-dot ${escapeHtml(node.kind)} ${escapeHtml(node.status)}" transform="translate(${point.x} ${point.y})"><circle r="8"/><circle class="core" r="3"/></g>`
  }).join("")
  const cards = nodes.map((node, index) => evolutionCard(node, railWidth + 20, 10 + index * rowHeight)).join("")
  return `<div class="canvas-shell">
    <div class="canvas-tools" aria-label="Evolution canvas controls">
      <button type="button" data-canvas-action="out" aria-label="Zoom out">−</button>
      <button type="button" data-canvas-action="in" aria-label="Zoom in">+</button>
      <button type="button" data-canvas-action="fit">Fit</button>
    </div>
    <div class="evolution-viewport" data-evolution-viewport tabindex="0" aria-label="Interactive Swarm evolution tree">
      <div class="evolution-plane" data-evolution-plane style="width:${width}px;height:${height}px">
        <svg viewBox="0 0 ${railWidth} ${height}" width="${railWidth}" height="${height}" aria-hidden="true">${lines}${dots}</svg>
        ${cards}
      </div>
    </div>
  </div>`
}

function evolutionCard(node: EvolutionNodeView, left: number, top: number): string {
  const canFork = Boolean(node.sourceId)
  return `<details class="tree-card ${escapeHtml(node.kind)} ${escapeHtml(node.status)}" style="left:${left}px;top:${top}px">
    <summary>
      <span><span class="node-kind">${escapeHtml(node.kind)}</span><strong><code>${short(node.id)}</code></strong></span>
      <span class="node-copy"><b>${escapeHtml(node.status)}</b><small>${escapeHtml(node.detail)}</small></span>
      <span class="node-metrics">${node.metrics.map((metric) => `<small>${escapeHtml(metric)}</small>`).join("")}</span>
    </summary>
    <div class="node-detail">
      <dl><div><dt>Node</dt><dd><code>${escapeHtml(node.id)}</code></dd></div><div><dt>Ledger Event</dt><dd><code>${escapeHtml(node.eventId)}</code> · #${node.seq}</dd></div>${node.parentId ? `<div><dt>Parent</dt><dd><code>${escapeHtml(node.parentId)}</code></dd></div>` : ""}</dl>
      ${canFork ? `<form method="post" action="/fork"><input type="hidden" name="sourceId" value="${escapeHtml(node.sourceId!)}"><button class="button quiet" type="submit">Fork and run</button></form>` : ""}
    </div>
  </details>`
}

function topology(definition: SwarmDefinition): string {
  const width = 840
  const agentRows = Math.ceil(definition.agents.length / 2)
  const height = Math.max(300, agentRows * 104 + 64, definition.plugins.length * 96 + 64)
  const agents = new Map(definition.agents.map((agent, index) => [agent.id, {
    x: 390 + (index % 2) * 240,
    y: 36 + Math.floor(index / 2) * 104,
  }]))
  const plugins = new Map(definition.plugins.map((plugin, index) => [plugin.id, { x: 36, y: 36 + index * 96 }]))
  const agentRoutes = definition.routes.map((route) => edge(agents.get(route.from)!, agents.get(route.to)!, "agent-edge")).join("")
  const ingress = definition.pluginIngress.map((item) => edge(plugins.get(item.plugin)!, agents.get(item.ingressTo)!, "ingress-edge")).join("")
  const cli = definition.plugins.flatMap((plugin) => plugin.exposedTo.map((agentId) => edge(plugins.get(plugin.id)!, agents.get(agentId)!, "cli-edge"))).join("")
  const pluginNodes = definition.plugins.map((plugin) => {
    const point = plugins.get(plugin.id)!
    return `<g class="plugin-node" transform="translate(${point.x} ${point.y})"><rect width="190" height="68" rx="16"/><text class="node-title" x="16" y="27">${escapeHtml(plugin.id)}</text><text class="node-meta" x="16" y="49">${escapeHtml(plugin.command)} · ${escapeHtml(plugin.mode)}</text></g>`
  }).join("")
  const agentNodes = definition.agents.map((agent) => {
    const point = agents.get(agent.id)!
    const receivesPlugin = definition.pluginIngress.some((item) => item.ingressTo === agent.id)
    return `<g class="agent-node${receivesPlugin ? " receives-plugin" : ""}" transform="translate(${point.x} ${point.y})"><rect width="178" height="68" rx="16"/><text class="node-title" x="16" y="27">${escapeHtml(agent.id)}</text><text class="node-meta" x="16" y="49">${escapeHtml(agent.harness)}</text></g>`
  }).join("")
  return `<div class="topology"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Active Agent and Plugin graph"><defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10Z"/></marker></defs>${agentRoutes}${ingress}${cli}${pluginNodes}${agentNodes}</svg></div><div class="legend"><span><i></i>Agent communication</span><span><i class="blue"></i>Plugin ingress</span><span><i class="dash"></i>CLI exposure</span></div>`
}

function edge(from: { x: number; y: number }, to: { x: number; y: number }, kind: string): string {
  return `<path class="${kind}" marker-end="url(#arrow)" d="M${from.x + 190} ${from.y + 34} C${from.x + 250} ${from.y + 34},${to.x - 70} ${to.y + 34},${to.x} ${to.y + 34}"/>`
}

function snapshot(model: DefaultViewModel): string {
  const active = model.activeRevision!
  const evolved = model.agents.filter((agent) => agent.evolved).length
  return `<dl class="facts"><div><dt>Revision</dt><dd><code>${short(active.id)}</code></dd></div><div><dt>Parent</dt><dd><code>${active.parentRevision ? short(active.parentRevision) : "genesis"}</code></dd></div><div><dt>Workspace heads</dt><dd>${model.agents.length}</dd></div><div><dt>Evolved since snapshot</dt><dd>${evolved}</dd></div><div><dt>Plugins</dt><dd>${model.plugins.length}</dd></div></dl><div class="panel-action"><form method="post" action="/fork"><input type="hidden" name="sourceId" value="${escapeHtml(active.id)}"><button class="button quiet" type="submit">Fork this Revision</button></form></div>`
}

function renderAgent(agent: AgentStateView): string {
  const checkpoint = agent.checkpoint
  const state = !checkpoint ? "not started" : checkpoint.outcome !== "completed" ? checkpoint.outcome : checkpoint.pendingFork ? "fork next turn" : "resumable"
  return `<article class="agent-state">
    <header><div><p class="eyebrow">${escapeHtml(agent.harness)}</p><h3>${escapeHtml(agent.id)}</h3></div><span class="state-label ${checkpoint?.pendingFork || checkpoint?.outcome === "failed" ? "pending" : ""}">${escapeHtml(state)}</span></header>
    <dl><div><dt>Workspace</dt><dd><code>${short(agent.workspaceHead)}</code>${agent.evolved ? `<small>evolved</small>` : ""}</dd></div><div><dt>Session</dt><dd>${checkpoint ? `<code>${short(checkpoint.sessionId)}</code>` : "—"}</dd></div><div><dt>Checkpoint</dt><dd>${checkpoint ? `<code>${short(checkpoint.turnId)}</code>` : "—"}</dd></div></dl>
  </article>`
}

function renderPlugin(plugin: PluginView): string {
  const eventRows = plugin.events.slice(-4).reverse().map((event) => `<li><span><strong>${escapeHtml(event.type)}</strong><small>#${event.seq} · ${escapeHtml(event.actor)} · ${escapeHtml(event.scope)}</small></span><span class="recipient">${event.recipients.map(shortRecipient).join(" · ") || "unrouted"}</span></li>`).join("")
  return `<article class="plugin"><header><div><p class="eyebrow">Plugin · ${escapeHtml(plugin.mode)}</p><h3>${escapeHtml(plugin.id)}</h3></div><code>${escapeHtml(plugin.command)}</code></header><div class="capability"><span>Active pin</span><strong><code>${short(plugin.activeCommit)}</code></strong></div><div class="capability"><span>Draft head</span><strong><code>${short(plugin.draftCommit)}</code></strong></div><div class="capability"><span>Inbound to</span><strong>${plugin.ingressTargets.map(escapeHtml).join(", ") || "Nobody"}</strong></div><div class="capability"><span>CLI exposed to</span><strong>${plugin.exposedTo.map(escapeHtml).join(", ") || "Nobody"}</strong></div><ul class="plugin-events">${eventRows || `<li class="muted">No inbound Events recorded</li>`}</ul></article>`
}

function renderFork(fork: ForkView): string {
  const tests = fork.tests.map((test) => `<li><span>${escapeHtml(test.id)}</span><strong class="${test.passed ? "success" : "danger"}">${test.passed ? "Passed" : "No evidence"}</strong></li>`).join("")
  const changed = fork.changedAgents.length ? fork.changedAgents.map(escapeHtml).join(", ") : "No workspace changes"
  return `<article class="fork" id="fork-${escapeHtml(fork.id)}"><header><div><p class="eyebrow">${fork.sourceKind} Fork</p><h3><code>${short(fork.id)}</code></h3></div><span class="status ${fork.status}">${fork.status}</span></header><div class="metric-row"><span><b>${fork.turnCount}</b> turns</span><span><b>${fork.workspaceCommitCount}</b> commits</span><span><b>${fork.communicationCount}</b> messages</span></div><p class="changed">${changed}</p><ul class="tests">${tests}</ul>${fork.status === "open" ? `<div class="actions"><form method="post" action="/approve"><input type="hidden" name="forkId" value="${escapeHtml(fork.id)}"><input type="hidden" name="frontier" value="${fork.frontier}"><button class="button" type="submit">Approve</button></form><form method="post" action="/deny"><input type="hidden" name="forkId" value="${escapeHtml(fork.id)}"><input type="hidden" name="frontier" value="${fork.frontier}"><button class="button danger-button" type="submit">Deny</button></form></div>` : ""}</article>`
}

function renderTurn(turn: TurnView): string {
  const refs = (items: TurnView["inputs"]) => items.map((item) => `<span class="event-chip"><b>${escapeHtml(item.type)}</b><code>${short(item.id)}</code></span>`).join("")
  return `<details class="turn"><summary><span class="turn-agent"><b>${escapeHtml(turn.agentId)}</b><small>${escapeHtml(turn.scope)} · #${turn.seq}</small></span><span class="turn-route">${turn.inputs.map((item) => escapeHtml(item.type)).join(" + ") || "no input"}<i>→</i>${escapeHtml(turn.outcome)}<i>→</i>${turn.outputs.length} effects</span><span class="disclosure-label">Details</span></summary><div class="turn-detail"><div><p class="eyebrow">Inputs</p>${refs(turn.inputs) || "—"}</div><div><p class="eyebrow">Committed effects</p>${refs(turn.outputs) || "—"}</div>${turn.checkpoint ? `<div><p class="eyebrow">Trajectory</p><span class="event-chip"><b>${escapeHtml(turn.checkpoint.harness)}</b><code>${short(turn.checkpoint.sessionId)} · ${short(turn.checkpoint.turnId)}</code></span></div>` : ""}</div></details>`
}

function renderEvent(event: DefaultViewModel["events"][number]): string {
  const scope = event.scope.kind === "active" ? "main" : short(event.scope.forkId)
  return `<li><span class="sequence">#${event.seq}</span><strong>${escapeHtml(event.type)}</strong><span>${escapeHtml(event.actor)}</span><span>${escapeHtml(scope)}</span></li>`
}

function empty(message: string): string {
  return `<p class="empty">${escapeHtml(message)}</p>`
}

function shortRecipient(value: string): string {
  return escapeHtml(value.replace(/^agent\//, ""))
}

function short(id: string): string {
  return escapeHtml(id.length > 18 ? `${id.slice(0, 9)}…${id.slice(-6)}` : id)
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")
}

const canvasScript = String.raw`
for (const viewport of document.querySelectorAll('[data-evolution-viewport]')) {
  const plane = viewport.querySelector('[data-evolution-plane]')
  let scale = 1, x = 24, y = 18, drag = null, moved = false
  const draw = () => { plane.style.transform = 'translate(' + x + 'px,' + y + 'px) scale(' + scale + ')' }
  const zoom = (factor, cx = viewport.clientWidth / 2, cy = viewport.clientHeight / 2) => {
    const next = Math.min(1.7, Math.max(.42, scale * factor))
    x = cx - (cx - x) * next / scale
    y = cy - (cy - y) * next / scale
    scale = next
    draw()
  }
  const fit = () => {
    scale = Math.min(1, (viewport.clientWidth - 36) / plane.offsetWidth, (viewport.clientHeight - 36) / plane.offsetHeight)
    x = Math.max(18, (viewport.clientWidth - plane.offsetWidth * scale) / 2)
    y = 18
    draw()
  }
  viewport.addEventListener('pointerdown', event => {
    if (event.target.closest('summary,button,input,a')) return
    drag = { x: event.clientX, y: event.clientY, ox: x, oy: y }
    moved = false
    viewport.setPointerCapture(event.pointerId)
    viewport.classList.add('dragging')
  })
  viewport.addEventListener('pointermove', event => {
    if (!drag) return
    x = drag.ox + event.clientX - drag.x
    y = drag.oy + event.clientY - drag.y
    moved ||= Math.abs(event.clientX - drag.x) + Math.abs(event.clientY - drag.y) > 4
    draw()
  })
  viewport.addEventListener('pointerup', () => { drag = null; viewport.classList.remove('dragging') })
  viewport.addEventListener('wheel', event => {
    event.preventDefault()
    const box = viewport.getBoundingClientRect()
    zoom(Math.exp(-event.deltaY * .0012), event.clientX - box.left, event.clientY - box.top)
  }, { passive: false })
  viewport.closest('.canvas-shell').querySelectorAll('[data-canvas-action]').forEach(button => button.addEventListener('click', () => {
    if (button.dataset.canvasAction === 'in') zoom(1.2)
    else if (button.dataset.canvasAction === 'out') zoom(1 / 1.2)
    else fit()
  }))
  viewport.addEventListener('click', event => { if (moved) { event.preventDefault(); moved = false } }, true)
  fit()
}
`

const styles = `
:root{color-scheme:light;--blue:#007aff;--blue-soft:#eaf4ff;--blue-line:#b8d9ff;--ink:#1d1d1f;--muted:#6e6e73;--line:rgba(60,60,67,.16);--surface:#fff;--canvas:#f5f5f7;--danger:#d70015;--success:#248a3d;--shadow:0 1px 2px rgba(0,0,0,.04),0 12px 32px rgba(0,0,0,.055)}
*{box-sizing:border-box}html{background:var(--canvas)}body{margin:0;color:var(--ink);font:14px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",sans-serif;-webkit-font-smoothing:antialiased}a{color:inherit;text-decoration:none}button,input,textarea{font:inherit}button:focus-visible,a:focus-visible,summary:focus-visible,[tabindex]:focus-visible{outline:3px solid rgba(0,122,255,.28);outline-offset:2px}code{font-family:"SFMono-Regular",ui-monospace,Menlo,monospace;font-size:.92em}nav{position:sticky;top:0;z-index:20;display:flex;align-items:center;justify-content:space-between;gap:20px;padding:12px max(22px,calc((100vw - 1280px)/2));background:rgba(250,250,252,.82);border-bottom:1px solid var(--line);backdrop-filter:saturate(180%) blur(22px)}.brand{font-size:18px;font-weight:680;letter-spacing:-.02em;color:var(--blue)}.nav-items{display:flex;gap:4px;overflow:auto}.nav-link{padding:7px 11px;border-radius:999px;color:var(--muted);white-space:nowrap}.nav-link.active{background:rgba(0,122,255,.1);color:var(--blue)}main{max-width:1280px;margin:auto;padding:42px 22px 76px}.hero{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;margin-bottom:24px}.hero.compact{margin-bottom:18px}.hero h1{margin:3px 0 5px;font-size:38px;line-height:1.08;letter-spacing:-.045em}.hero>div>p:last-child{margin:0;color:var(--muted);font-size:16px}.eyebrow{margin:0;color:var(--blue);font-size:11px;font-weight:680;letter-spacing:.075em;text-transform:uppercase}.status,.state-label{display:inline-flex;align-items:center;gap:7px;padding:6px 10px;border-radius:999px;background:var(--blue-soft);color:#0062cc;font-size:12px;text-transform:capitalize}.status i{width:7px;height:7px;border-radius:50%;background:var(--blue)}.status.denied,.state-label.pending{background:#fff0f1;color:var(--danger)}.status.approved{background:#eaf8ee;color:var(--success)}.notice{padding:12px 14px;border:1px solid #ffc8cc;border-radius:14px;background:#fff4f5;color:var(--danger)}.surface{background:var(--surface);border:1px solid var(--line);border-radius:22px;box-shadow:var(--shadow);overflow:hidden}.section{margin-top:18px}.section-head{display:flex;justify-content:space-between;align-items:center;padding:18px 20px;border-bottom:1px solid var(--line)}.section-head h2{margin:0;font-size:17px;letter-spacing:-.015em}.section-head p{margin:2px 0 0;color:var(--muted);font-size:12px}.primary-grid{display:grid;grid-template-columns:minmax(0,1.62fr) minmax(280px,.72fr);gap:18px}
.canvas-shell{position:relative}.canvas-tools{position:absolute;right:14px;top:14px;z-index:8;display:flex;gap:2px;padding:4px;border:1px solid var(--line);border-radius:13px;background:rgba(255,255,255,.86);box-shadow:0 4px 18px rgba(0,0,0,.08);backdrop-filter:blur(18px)}.canvas-tools button{min-width:34px;height:30px;padding:0 9px;border:0;border-radius:9px;background:transparent;color:var(--ink);font-weight:650;cursor:pointer}.canvas-tools button:hover{background:var(--blue-soft);color:var(--blue)}.evolution-viewport{height:560px;overflow:hidden;position:relative;touch-action:none;cursor:grab;background-color:#fbfbfd;background-image:radial-gradient(rgba(60,60,67,.18) .7px,transparent .7px);background-size:18px 18px}.evolution-viewport.dragging{cursor:grabbing}.evolution-plane{position:absolute;left:0;top:0;transform-origin:0 0;will-change:transform}.evolution-plane>svg{position:absolute;left:0;top:0;overflow:visible}.tree-edge{fill:none;stroke:#aeb4bc;stroke-width:2}.tree-edge.branch{stroke:var(--blue)}.tree-edge.merge{stroke:var(--success)}.tree-edge.denied{stroke:var(--danger);stroke-dasharray:5 5}.tree-dot circle{fill:white;stroke:#8e8e93;stroke-width:2}.tree-dot .core{fill:#8e8e93;stroke:0}.tree-dot.proposal circle,.tree-dot.fork circle{stroke:var(--blue)}.tree-dot.proposal .core,.tree-dot.fork .core{fill:var(--blue)}.tree-dot.revision circle{stroke:var(--success)}.tree-dot.revision .core{fill:var(--success)}.tree-dot.denied circle{stroke:var(--danger)}.tree-dot.denied .core{fill:var(--danger)}.tree-card{position:absolute;width:660px;border:1px solid var(--line);border-radius:16px;background:rgba(255,255,255,.96);box-shadow:0 5px 18px rgba(0,0,0,.06);z-index:2}.tree-card[open]{z-index:12;box-shadow:0 16px 42px rgba(0,0,0,.14)}.tree-card.active{border-color:rgba(0,122,255,.52);box-shadow:0 0 0 3px rgba(0,122,255,.08),0 8px 24px rgba(0,0,0,.08)}.tree-card summary{height:88px;display:grid;grid-template-columns:155px minmax(180px,1fr) minmax(170px,.75fr);gap:16px;align-items:center;padding:14px 16px;cursor:pointer;list-style:none}.tree-card summary::-webkit-details-marker{display:none}.tree-card summary>span{min-width:0}.tree-card summary strong,.node-copy b,.node-copy small{display:block}.node-kind{display:block;color:var(--blue);font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}.node-copy b{text-transform:capitalize}.node-copy small,.node-metrics small{color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.node-metrics{display:flex;flex-direction:column;align-items:flex-end}.node-detail{padding:0 16px 16px;border-top:1px solid var(--line)}.node-detail dl{margin:7px 0 14px}.node-detail dl div{display:grid;grid-template-columns:92px 1fr;gap:12px;padding:8px 0;border-bottom:1px solid var(--line)}.node-detail dt{color:var(--muted)}.node-detail dd{margin:0;overflow-wrap:anywhere}
.topology{padding:16px 18px 2px;overflow:auto}.topology svg{display:block;width:100%;min-width:700px}.agent-edge,.ingress-edge,.cli-edge{fill:none;stroke:#8e8e93;stroke-width:1.35;opacity:.56}.ingress-edge{stroke:var(--blue);stroke-width:2;opacity:.82}.cli-edge{stroke:var(--blue);stroke-dasharray:5 5;opacity:.48}.topology marker path{fill:var(--blue)}.agent-node rect,.plugin-node rect{fill:white;stroke:var(--line)}.agent-node.receives-plugin rect,.plugin-node rect{stroke:var(--blue-line);fill:#f3f8ff}.node-title{fill:var(--ink);font-size:14px;font-weight:650}.node-meta{fill:var(--muted);font-size:11px}.legend{display:flex;gap:18px;flex-wrap:wrap;padding:8px 20px 18px;color:var(--muted);font-size:12px}.legend i{display:inline-block;width:20px;margin-right:6px;border-top:2px solid #8e8e93;vertical-align:middle}.legend .blue{border-color:var(--blue)}.legend .dash{border-color:var(--blue);border-top-style:dashed}.facts{margin:0;padding:7px 20px}.facts div{display:flex;justify-content:space-between;gap:16px;padding:12px 0;border-bottom:1px solid var(--line)}.facts div:last-child{border:0}.facts dt{color:var(--muted)}.facts dd{margin:0;font-weight:600}.panel-action{padding:4px 20px 20px}.button{appearance:none;min-height:36px;border:0;border-radius:999px;padding:8px 15px;background:var(--blue);color:white;font-weight:650;cursor:pointer}.button:hover{filter:brightness(.96)}.button.quiet{background:var(--blue-soft);color:#0062cc}.button.danger-button{background:white;color:var(--danger);border:1px solid rgba(215,0,21,.3)}
.agent-grid,.plugin-grid,.fork-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px;padding:18px}.agent-state,.plugin,.fork{padding:17px;border:1px solid var(--line);border-radius:18px;background:white}.agent-state header,.plugin header,.fork header{display:flex;justify-content:space-between;gap:14px;align-items:flex-start}.agent-state h3,.plugin h3,.fork h3{margin:4px 0 0;font-size:16px}.agent-state dl{margin:15px 0 0}.agent-state dl div{display:flex;justify-content:space-between;gap:12px;padding:9px 0;border-top:1px solid var(--line)}.agent-state dt{color:var(--muted)}.agent-state dd{margin:0;text-align:right}.agent-state dd small{display:block;color:var(--blue)}.plugin header>code{padding:5px 8px;border-radius:8px;background:var(--blue-soft);color:#0062cc}.capability{display:flex;justify-content:space-between;gap:14px;padding:11px 0;border-top:1px solid var(--line)}.capability:first-of-type{margin-top:14px}.capability span{color:var(--muted)}.plugin-events,.tests{list-style:none;margin:8px 0 0;padding:0}.plugin-events li,.tests li{display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-top:1px solid var(--line)}.plugin-events strong,.plugin-events small{display:block}.plugin-events small,.recipient,.muted,.changed{color:var(--muted);font-size:12px}.metric-row{display:flex;gap:8px;flex-wrap:wrap;margin:15px 0 10px}.metric-row span{padding:6px 9px;border-radius:10px;background:#f5f5f7;color:var(--muted);font-size:12px}.metric-row b{color:var(--ink)}.tests .success{color:var(--success)}.tests .danger{color:var(--danger)}.actions{display:flex;gap:8px;margin-top:14px}
.turn-list{padding:6px 20px 14px}.turn{border-bottom:1px solid var(--line)}.turn:last-child{border:0}.turn>summary{display:grid;grid-template-columns:160px 1fr auto;gap:16px;align-items:center;min-height:62px;padding:10px 0;cursor:pointer;list-style:none}.turn>summary::-webkit-details-marker{display:none}.turn-agent b,.turn-agent small{display:block}.turn-agent small,.disclosure-label{color:var(--muted);font-size:12px}.turn-route{display:flex;align-items:center;gap:9px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.turn-route i{color:var(--blue);font-style:normal}.turn-detail{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:14px;padding:4px 0 16px}.turn-detail>div{padding:12px;border-radius:14px;background:#f7f7f9}.event-chip{display:block;margin-top:7px}.event-chip b,.event-chip code{display:block}.event-chip code{color:var(--muted);overflow-wrap:anywhere}.ledger-disclosure>summary{display:flex;justify-content:space-between;align-items:center;padding:18px 20px;cursor:pointer;list-style:none}.ledger-disclosure>summary::-webkit-details-marker{display:none}.ledger-disclosure>summary strong,.ledger-disclosure>summary small{display:block}.ledger-disclosure>summary small{color:var(--muted);font-weight:400}.events{list-style:none;margin:0;padding:5px 20px 16px;border-top:1px solid var(--line)}.events li{display:grid;grid-template-columns:55px minmax(190px,1fr) minmax(130px,.7fr) minmax(100px,.5fr);gap:12px;padding:11px 0;border-bottom:1px solid var(--line);align-items:center}.events li:last-child{border:0}.events span{color:var(--muted);font-size:12px}.sequence{font-variant-numeric:tabular-nums}.empty{margin:0;padding:48px 20px;color:var(--muted);text-align:center}.extension{padding:20px}.field{display:grid;gap:6px}.field label{font-weight:600}.field input,.field textarea{width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:12px;background:white;color:var(--ink)}.field textarea{min-height:90px;resize:vertical}
@media(max-width:800px){main{padding:28px 14px 56px}.primary-grid{grid-template-columns:1fr}.hero{align-items:flex-start;flex-direction:column}.evolution-viewport{height:500px}.tree-card{width:560px}.tree-card summary{grid-template-columns:130px minmax(160px,1fr) 150px}.events li{grid-template-columns:44px 1fr}.events li span:nth-child(n+3){display:none}.turn>summary{grid-template-columns:120px 1fr}.turn>summary>.disclosure-label{display:none}nav{align-items:flex-start;flex-direction:column;gap:7px}.nav-items{width:100%}}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}.evolution-plane{will-change:auto}}
`
