import type { SwarmDefinition } from "../../core/swarm/definition.ts"
import type { ViewExtensionLink } from "../extension.ts"
import type { DefaultViewModel, ForkView, PluginView } from "./project.ts"

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
      <div><p class="eyebrow">Human control plane</p><h1>Swarm evolution</h1><p>Ledger facts, Agent topology, and Human decisions.</p></div>
      ${active ? `<span class="status live"><i></i>Revision <code>${short(active.id)}</code></span>` : ""}
    </header>
    <div class="primary-grid">
      <section class="surface wide">
        <header class="section-head"><div><h2>Active swarm</h2><p>${active?.definition.agents.length ?? 0} Agents · ${model.plugins.length} Plugins</p></div></header>
        ${active ? topology(active.definition) : empty("No active Revision")}
      </section>
      <aside class="surface">
        <header class="section-head"><div><h2>Snapshot</h2><p>Current Main</p></div></header>
        ${active ? snapshot(model) : empty("Not bootstrapped")}
      </aside>
    </div>
    <section class="surface section">
      <header class="section-head"><div><h2>Plugin capabilities</h2><p>Inbound Events and Agent-visible CLIs</p></div></header>
      ${model.plugins.length ? `<div class="plugin-grid">${model.plugins.map(renderPlugin).join("")}</div>` : empty("No Plugins in this Revision")}
    </section>
    <section class="surface section">
      <header class="section-head"><div><h2>Evolution</h2><p>Revisions and Proposals</p></div></header>
      <div class="flow">${evolution(model)}</div>
    </section>
    <section class="surface section">
      <header class="section-head"><div><h2>Forks</h2><p>Compare evidence, then decide</p></div></header>
      ${model.forks.length ? `<div class="fork-grid">${model.forks.map(renderFork).join("")}</div>` : empty("No Forks yet")}
    </section>
    <section class="surface section">
      <header class="section-head"><div><h2>Ledger</h2><p>${model.events.length} immutable Events</p></div></header>
      <ol class="events">${model.events.slice(-80).reverse().map(renderEvent).join("")}</ol>
    </section>`,
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
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Corallum</title><style>${styles}</style></head><body><nav><a class="brand" href="/">Corallum</a><div class="nav-items"><a class="nav-link${active ? "" : " active"}" href="/">Overview</a>${extensionLinks}</div></nav><main>${content}</main></body></html>`
}

function topology(definition: SwarmDefinition): string {
  const width = 840
  const agentRows = Math.ceil(definition.agents.length / 2)
  const height = Math.max(340, agentRows * 112 + 70, definition.plugins.length * 104 + 70)
  const agents = new Map(definition.agents.map((agent, index) => [agent.id, {
    x: 390 + (index % 2) * 240,
    y: 44 + Math.floor(index / 2) * 112,
  }]))
  const plugins = new Map(definition.plugins.map((plugin, index) => [plugin.id, { x: 36, y: 44 + index * 104 }]))
  const agentRoutes = definition.routes.map((route) => edge(agents.get(route.from)!, agents.get(route.to)!, "agent-edge")).join("")
  const ingress = definition.pluginIngress.map((item) => edge(plugins.get(item.plugin)!, agents.get(item.ingressTo)!, "ingress-edge")).join("")
  const cli = definition.plugins.flatMap((plugin) => plugin.exposedTo.map((agentId) => edge(plugins.get(plugin.id)!, agents.get(agentId)!, "cli-edge"))).join("")
  const pluginNodes = definition.plugins.map((plugin) => {
    const point = plugins.get(plugin.id)!
    return `<g class="plugin-node" transform="translate(${point.x} ${point.y})"><rect width="190" height="68" rx="18"/><text class="node-title" x="16" y="27">${escapeHtml(plugin.id)}</text><text class="node-meta" x="16" y="49">${escapeHtml(plugin.command)} · ${escapeHtml(plugin.mode)}</text></g>`
  }).join("")
  const agentNodes = definition.agents.map((agent) => {
    const point = agents.get(agent.id)!
    const receivesPlugin = definition.pluginIngress.some((item) => item.ingressTo === agent.id)
    return `<g class="agent-node${receivesPlugin ? " receives-plugin" : ""}" transform="translate(${point.x} ${point.y})"><rect width="178" height="68" rx="18"/><text class="node-title" x="16" y="27">${escapeHtml(agent.id)}</text><text class="node-meta" x="16" y="49">${escapeHtml(agent.harness)}</text></g>`
  }).join("")
  return `<div class="canvas"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Active Agent and Plugin graph"><defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10Z"/></marker></defs>${agentRoutes}${ingress}${cli}${pluginNodes}${agentNodes}</svg></div><div class="legend"><span><i class="solid"></i>Agent communication</span><span><i class="blue"></i>Plugin inbound Event</span><span><i class="dash"></i>CLI exposure</span></div>`
}

function edge(from: { x: number; y: number }, to: { x: number; y: number }, kind: string): string {
  return `<path class="${kind}" marker-end="url(#arrow)" d="M${from.x + 190} ${from.y + 34} C${from.x + 250} ${from.y + 34},${to.x - 70} ${to.y + 34},${to.x} ${to.y + 34}"/>`
}

function snapshot(model: DefaultViewModel): string {
  const active = model.activeRevision!
  const evolved = Object.entries(model.activeWorkspaceHeads).filter(([agent, head]) => head !== active.agentHeads[agent]).length
  return `<dl class="facts"><div><dt>Revision</dt><dd><code>${short(active.id)}</code></dd></div><div><dt>Parent</dt><dd><code>${active.parentRevision ? short(active.parentRevision) : "genesis"}</code></dd></div><div><dt>Workspace heads</dt><dd>${Object.keys(model.activeWorkspaceHeads).length}</dd></div><div><dt>Evolved since snapshot</dt><dd>${evolved}</dd></div><div><dt>Plugins</dt><dd>${model.plugins.length}</dd></div></dl><div class="panel-action"><form method="post" action="/fork"><input type="hidden" name="sourceId" value="${escapeHtml(active.id)}"><button class="button quiet" type="submit">Fork this Revision</button></form></div>`
}

function renderPlugin(plugin: PluginView): string {
  const eventRows = plugin.events.slice(-4).reverse().map((event) => `<li><span><strong>${escapeHtml(event.type)}</strong><small>#${event.seq} · ${escapeHtml(event.actor)}</small></span><span class="recipient">${event.recipients.map(shortRecipient).join(" · ") || "unrouted"}</span></li>`).join("")
  return `<article class="plugin"><header><div><p class="eyebrow">Plugin · ${escapeHtml(plugin.mode)}</p><h3>${escapeHtml(plugin.id)}</h3></div><code>${escapeHtml(plugin.command)}</code></header><div class="capability"><span>Inbound to</span><strong>${plugin.ingressTargets.map(escapeHtml).join(", ") || "Nobody"}</strong></div><div class="capability"><span>CLI exposed to</span><strong>${plugin.exposedTo.map(escapeHtml).join(", ") || "Nobody"}</strong></div><ul class="plugin-events">${eventRows || `<li class="muted">No inbound Events recorded</li>`}</ul></article>`
}

function evolution(model: DefaultViewModel): string {
  const items = [
    ...model.revisions.map((revision) => ({ seq: revision.ledgerFrontier, html: flowNode("Revision", revision.id, `${revision.definition.agents.length} Agents${revision.active ? " · Active" : ""}`, revision.id, revision.active) })),
    ...model.proposals.map((proposal) => ({ seq: proposal.seq, html: flowNode("Proposal", proposal.id, `by ${proposal.authoredBy} · ${proposal.definition.agents.length} Agents`, proposal.id, false, true) })),
  ].sort((left, right) => left.seq - right.seq)
  return items.map((item) => item.html).join("") || empty("No evolution recorded")
}

function flowNode(kind: string, id: string, detail: string, sourceId: string, active: boolean, primary = false): string {
  return `<article class="flow-node${active ? " selected" : ""}"><p class="eyebrow">${kind}</p><h3><code>${short(id)}</code></h3><p>${escapeHtml(detail)}</p><form method="post" action="/fork"><input type="hidden" name="sourceId" value="${escapeHtml(sourceId)}"><button class="button ${primary ? "" : "quiet"}" type="submit">Fork${primary ? " and run" : ""}</button></form></article>`
}

function renderFork(fork: ForkView): string {
  const tests = fork.tests.map((test) => `<li><span>${escapeHtml(test.id)}</span><strong class="${test.passed ? "success" : "danger"}">${test.passed ? "Passed" : "No evidence"}</strong></li>`).join("")
  return `<article class="fork"><header><div><p class="eyebrow">${fork.sourceKind} Fork</p><h3><code>${short(fork.id)}</code></h3></div><span class="status ${fork.status}">${fork.status}</span></header><p class="metrics">${fork.eventCount} Events · ${fork.communicationCount} Communications · ${Object.keys(fork.agentHeads).length} heads</p><ul class="tests">${tests}</ul>${fork.status === "open" ? `<div class="actions"><form method="post" action="/approve"><input type="hidden" name="forkId" value="${escapeHtml(fork.id)}"><input type="hidden" name="frontier" value="${fork.frontier}"><button class="button" type="submit">Approve</button></form><form method="post" action="/deny"><input type="hidden" name="forkId" value="${escapeHtml(fork.id)}"><input type="hidden" name="frontier" value="${fork.frontier}"><button class="button danger-button" type="submit">Deny</button></form></div>` : ""}</article>`
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

export function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")
}

const styles = `
:root{color-scheme:light;--blue:#0677e8;--blue-soft:#eaf4ff;--blue-line:#b9dcff;--ink:#10243e;--muted:#61758d;--line:#dce7f2;--white:#fff;--canvas:#f5f9fd;--danger:#c93b45;--success:#16804a;--shadow:0 14px 44px rgba(22,73,122,.08)}
*{box-sizing:border-box}body{margin:0;background:var(--canvas);color:var(--ink);font:14px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",sans-serif}a{color:inherit;text-decoration:none}button,input,textarea{font:inherit}nav{position:sticky;top:0;z-index:10;display:flex;align-items:center;justify-content:space-between;gap:20px;padding:13px max(22px,calc((100vw - 1240px)/2));background:rgba(255,255,255,.9);border-bottom:1px solid var(--line);backdrop-filter:saturate(180%) blur(20px)}.brand{font-size:18px;font-weight:650;color:var(--blue)}.nav-items{display:flex;gap:5px;overflow:auto}.nav-link{padding:7px 11px;border-radius:999px;color:var(--muted);white-space:nowrap}.nav-link.active{background:var(--blue-soft);color:var(--blue)}main{max-width:1240px;margin:auto;padding:40px 22px 72px}.hero{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;margin-bottom:24px}.hero.compact{margin-bottom:18px}.hero h1{margin:2px 0 4px;font-size:34px;line-height:1.12;letter-spacing:-.035em}.hero>div>p:last-child{margin:0;color:var(--muted);font-size:16px}.eyebrow{margin:0;color:var(--blue);font-size:11px;font-weight:650;letter-spacing:.08em;text-transform:uppercase}.status{display:inline-flex;align-items:center;gap:7px;padding:6px 10px;border-radius:999px;background:var(--blue-soft);color:var(--blue);font-size:12px;text-transform:capitalize}.status i{width:7px;height:7px;border-radius:50%;background:var(--blue)}.status.denied{background:#fff0f1;color:var(--danger)}.status.approved{background:#eaf8f1;color:var(--success)}.notice{padding:12px 14px;border:1px solid #ffc8cc;border-radius:14px;background:#fff4f5;color:var(--danger)}.primary-grid{display:grid;grid-template-columns:minmax(0,1.65fr) minmax(280px,.72fr);gap:18px}.surface{background:var(--white);border:1px solid var(--line);border-radius:22px;box-shadow:var(--shadow);overflow:hidden}.section{margin-top:18px}.section-head{display:flex;justify-content:space-between;align-items:center;padding:18px 20px;border-bottom:1px solid var(--line)}.section-head h2{margin:0;font-size:17px;letter-spacing:-.01em}.section-head p{margin:2px 0 0;color:var(--muted);font-size:12px}.canvas{padding:16px 18px 4px;overflow:auto}.canvas svg{display:block;width:100%;min-width:700px}.agent-edge,.ingress-edge,.cli-edge{fill:none;stroke:var(--muted);stroke-width:1.4;opacity:.55}.ingress-edge{stroke:var(--blue);stroke-width:2;opacity:.82}.cli-edge{stroke:var(--blue);stroke-dasharray:5 5;opacity:.5}.canvas marker path{fill:var(--blue)}.agent-node rect,.plugin-node rect{fill:var(--white);stroke:var(--line)}.agent-node.receives-plugin rect,.plugin-node rect{stroke:var(--blue-line);fill:var(--blue-soft)}.node-title{fill:var(--ink);font-size:14px;font-weight:650}.node-meta{fill:var(--muted);font-size:11px}.legend{display:flex;gap:18px;flex-wrap:wrap;padding:8px 20px 18px;color:var(--muted);font-size:12px}.legend i{display:inline-block;width:20px;margin-right:6px;border-top:2px solid var(--muted);vertical-align:middle}.legend .blue{border-color:var(--blue)}.legend .dash{border-color:var(--blue);border-top-style:dashed}.facts{margin:0;padding:7px 20px}.facts div{display:flex;justify-content:space-between;gap:16px;padding:12px 0;border-bottom:1px solid var(--line)}.facts div:last-child{border:0}.facts dt{color:var(--muted)}.facts dd{margin:0;font-weight:600}.panel-action{padding:4px 20px 20px}.button{appearance:none;border:0;border-radius:999px;padding:9px 14px;background:var(--blue);color:white;font-weight:650;cursor:pointer}.button.quiet{background:var(--blue-soft);color:var(--blue)}.button.danger-button{background:white;color:var(--danger);border:1px solid #f0bfc3}.plugin-grid,.fork-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px;padding:18px}.plugin,.fork{padding:17px;border:1px solid var(--line);border-radius:18px;background:var(--white)}.plugin header,.fork header{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}.plugin h3,.fork h3,.flow-node h3{margin:4px 0 0;font-size:16px}.plugin header>code{padding:5px 8px;border-radius:8px;background:var(--blue-soft);color:var(--blue)}.capability{display:flex;justify-content:space-between;gap:14px;padding:11px 0;border-top:1px solid var(--line)}.capability:first-of-type{margin-top:14px}.capability span{color:var(--muted)}.plugin-events,.tests{list-style:none;margin:8px 0 0;padding:0}.plugin-events li,.tests li{display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-top:1px solid var(--line)}.plugin-events strong,.plugin-events small{display:block}.plugin-events small,.recipient,.muted,.metrics{color:var(--muted);font-size:12px}.flow{display:flex;gap:12px;align-items:stretch;overflow:auto;padding:18px}.flow-node{position:relative;flex:0 0 220px;padding:16px;border:1px solid var(--line);border-radius:18px}.flow-node.selected{border-color:var(--blue);background:var(--blue-soft)}.flow-node p:not(.eyebrow){color:var(--muted)}.flow-node:not(:last-child)::after{content:"→";position:absolute;right:-10px;top:50%;color:var(--blue);z-index:2}.tests .success{color:var(--success)}.tests .danger{color:var(--danger)}.actions{display:flex;gap:8px;margin-top:14px}.events{list-style:none;margin:0;padding:5px 20px 16px}.events li{display:grid;grid-template-columns:55px minmax(190px,1fr) minmax(130px,.7fr) minmax(100px,.5fr);gap:12px;padding:11px 0;border-bottom:1px solid var(--line);align-items:center}.events li:last-child{border:0}.events span{color:var(--muted);font-size:12px}.sequence{font-variant-numeric:tabular-nums}.empty{margin:0;padding:48px 20px;color:var(--muted);text-align:center}.extension{padding:20px}.field{display:grid;gap:6px}.field label{font-weight:600}.field input,.field textarea{width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:12px;background:white;color:var(--ink)}.field textarea{min-height:90px;resize:vertical}
@media(max-width:780px){main{padding:28px 16px 56px}.primary-grid{grid-template-columns:1fr}.hero{align-items:flex-start;flex-direction:column}.events li{grid-template-columns:44px 1fr}.events li span:nth-child(n+3){display:none}nav{align-items:flex-start;flex-direction:column;gap:7px}.nav-items{width:100%}}
`
