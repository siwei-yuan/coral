import type { SwarmDefinition } from "../../core/swarm/definition.ts"
import type { DefaultViewModel, ForkView } from "./project.ts"

export function renderDefaultView(model: DefaultViewModel, notice?: string): string {
  const active = model.activeRevision
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Corallum View</title>
<style>
:root{color-scheme:light dark;--bg:#f5f5f7;--surface:rgba(255,255,255,.82);--text:#1d1d1f;--muted:#6e6e73;--line:rgba(0,0,0,.1);--blue:#0071e3;--red:#d70015;--green:#16873e;--shadow:0 10px 35px rgba(0,0,0,.07)}
@media(prefers-color-scheme:dark){:root{--bg:#000;--surface:rgba(28,28,30,.84);--text:#f5f5f7;--muted:#a1a1a6;--line:rgba(255,255,255,.14);--blue:#2997ff;--red:#ff453a;--green:#30d158;--shadow:none}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif}button{font:inherit}code{font-family:"SF Mono",ui-monospace,monospace;font-size:.88em}nav{position:sticky;top:0;z-index:10;display:flex;align-items:center;justify-content:space-between;padding:14px max(20px,calc((100vw - 1240px)/2));background:color-mix(in srgb,var(--bg) 72%,transparent);border-bottom:1px solid var(--line);backdrop-filter:saturate(180%) blur(20px)}nav strong{font-size:17px;font-weight:600}nav span{color:var(--muted)}main{max-width:1240px;margin:auto;padding:28px 20px 64px}.hero{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;margin-bottom:24px}.hero h1{margin:0;font-size:32px;line-height:1.1;letter-spacing:-.03em}.hero p{margin:8px 0 0;color:var(--muted)}.pill{display:inline-flex;align-items:center;gap:7px;padding:6px 10px;border-radius:999px;background:var(--surface);border:1px solid var(--line);white-space:nowrap}.dot{width:8px;height:8px;border-radius:50%;background:var(--green)}.notice{margin:0 0 20px;padding:12px 14px;border-radius:12px;background:color-mix(in srgb,var(--red) 9%,var(--surface));color:var(--red)}.grid{display:grid;grid-template-columns:minmax(0,1.65fr) minmax(280px,.8fr);gap:18px}.card{background:var(--surface);border:1px solid var(--line);border-radius:20px;box-shadow:var(--shadow);overflow:hidden}.section-head{display:flex;align-items:center;justify-content:space-between;padding:18px 20px;border-bottom:1px solid var(--line)}.section-head h2{margin:0;font-size:17px}.section-head span{color:var(--muted);font-size:12px}.canvas{padding:8px 14px 16px;min-height:310px}.canvas svg{width:100%;height:auto;display:block}.route{stroke:var(--muted);stroke-width:1.5;opacity:.65;fill:none}.agent rect{fill:var(--surface);stroke:var(--line)}.agent .name{fill:var(--text);font-size:14px;font-weight:600}.agent .meta{fill:var(--muted);font-size:11px}.agent.external rect{stroke:var(--blue)}.legend{display:flex;gap:16px;flex-wrap:wrap;padding:0 20px 18px;color:var(--muted);font-size:12px}.legend i{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;background:var(--muted)}.legend .external{background:var(--blue)}.details{padding:6px 20px 18px}.detail-row{display:flex;justify-content:space-between;gap:16px;padding:11px 0;border-bottom:1px solid var(--line)}.detail-row:last-child{border:0}.detail-row span:first-child{color:var(--muted)}.detail-row code{max-width:62%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.evolution{margin-top:18px}.flow{display:flex;gap:12px;align-items:stretch;overflow-x:auto;padding:18px 20px 22px}.flow-node{position:relative;flex:0 0 210px;padding:14px;border:1px solid var(--line);border-radius:14px;background:color-mix(in srgb,var(--surface) 92%,transparent)}.flow-node.active{border-color:var(--blue)}.flow-node:not(:last-child)::after{content:"→";position:absolute;right:-10px;top:50%;z-index:2;color:var(--muted)}.eyebrow{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.06em}.flow-node strong{display:block;margin:5px 0}.flow-node p{margin:0;color:var(--muted);font-size:12px}.btn{appearance:none;border:0;border-radius:999px;padding:8px 13px;background:var(--blue);color:white;cursor:pointer;font-weight:600}.btn.secondary{background:color-mix(in srgb,var(--text) 8%,transparent);color:var(--text)}.btn.danger{background:transparent;color:var(--red);border:1px solid color-mix(in srgb,var(--red) 30%,transparent)}.btn:hover{filter:brightness(.96)}form{display:inline}.source-actions{margin-top:12px}.forks{margin-top:18px}.fork-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px;padding:18px}.fork{padding:16px;border:1px solid var(--line);border-radius:16px}.fork header{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}.fork h3{margin:3px 0 0;font-size:15px}.status{font-size:11px;text-transform:capitalize;color:var(--muted)}.status.approved{color:var(--green)}.status.denied{color:var(--red)}.metrics{display:flex;gap:16px;margin:14px 0;color:var(--muted);font-size:12px}.test{display:flex;justify-content:space-between;padding:8px 0;border-top:1px solid var(--line)}.pass{color:var(--green)}.fail{color:var(--red)}.actions{display:flex;gap:8px;margin-top:14px}.timeline{margin-top:18px}.events{list-style:none;margin:0;padding:4px 20px 16px}.events li{display:grid;grid-template-columns:54px minmax(170px,1fr) minmax(120px,.7fr) minmax(100px,.5fr);gap:12px;padding:11px 0;border-bottom:1px solid var(--line);align-items:center}.events li:last-child{border:0}.events .seq,.events .actor,.events .scope{color:var(--muted);font-size:12px}.empty{padding:48px 20px;color:var(--muted);text-align:center}@media(max-width:760px){.grid{grid-template-columns:1fr}.hero{align-items:flex-start;flex-direction:column}.events li{grid-template-columns:44px 1fr}.events .actor,.events .scope{display:none}.canvas{overflow-x:auto}.canvas svg{min-width:620px}}
</style>
</head>
<body>
<nav><strong>Corallum</strong><span>Default View · Ledger projection</span></nav>
<main>
${notice ? `<p class="notice">${escapeHtml(notice)}</p>` : ""}
<div class="hero"><div><h1>Swarm evolution</h1><p>One immutable ledger. Workspaces evolve locally; humans activate swarm revisions.</p></div>${active ? `<span class="pill"><i class="dot"></i>Revision <code>${short(active.id)}</code></span>` : ""}</div>
<div class="grid">
  <section class="card"><div class="section-head"><h2>Active swarm</h2><span>${active?.definition.agents.length ?? 0} agents · ${active?.definition.routes.length ?? 0} routes</span></div>${active ? topology(active.definition) : `<div class="empty">No active revision</div>`}</section>
  <aside class="card"><div class="section-head"><h2>Snapshot</h2><span>Current main</span></div>${active ? snapshot(model) : `<div class="empty">Not bootstrapped</div>`}</aside>
</div>
<section class="card evolution"><div class="section-head"><h2>Evolution</h2><span>Revisions and proposals</span></div><div class="flow">${evolution(model)}</div></section>
<section class="card forks"><div class="section-head"><h2>Forks</h2><span>Compare evidence, then decide</span></div>${model.forks.length ? `<div class="fork-grid">${model.forks.map(renderFork).join("")}</div>` : `<div class="empty">No forks yet</div>`}</section>
<section class="card timeline"><div class="section-head"><h2>Ledger</h2><span>${model.events.length} immutable events</span></div><ol class="events">${model.events.slice(-80).reverse().map(renderEvent).join("")}</ol></section>
</main>
</body>
</html>`
}

function topology(definition: SwarmDefinition): string {
  const width = 760
  const height = 340
  const positions = new Map(definition.agents.map((agent, index) => {
    const angle = definition.agents.length === 1 ? 0 : (Math.PI * 2 * index) / definition.agents.length - Math.PI / 2
    return [agent.id, { x: width / 2 + Math.cos(angle) * 245, y: height / 2 + Math.sin(angle) * 105 }] as const
  }))
  const routes = definition.routes.map((route) => {
    const from = positions.get(route.from)!
    const to = positions.get(route.to)!
    return `<path class="route" marker-end="url(#arrow)" d="M ${from.x} ${from.y} L ${to.x} ${to.y}"/>`
  }).join("")
  const agents = definition.agents.map((agent) => {
    const point = positions.get(agent.id)!
    const external = definition.externalChannels.some((channel) => channel.ingressTo === agent.id || channel.egressFrom.includes(agent.id))
    const pluginCount = definition.plugins.filter((plugin) => plugin.exposedTo.includes(agent.id)).length
    return `<g class="agent${external ? " external" : ""}" transform="translate(${point.x - 78} ${point.y - 31})"><rect width="156" height="62" rx="17"/><text class="name" x="16" y="25">${escapeHtml(agent.id)}</text><text class="meta" x="16" y="44">${escapeHtml(agent.harness)} · ${pluginCount} tools</text></g>`
  }).join("")
  return `<div class="canvas"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Active swarm agent graph"><defs><marker id="arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="var(--muted)"/></marker></defs>${routes}${agents}</svg></div><div class="legend"><span><i></i>Agent</span><span><i class="external"></i>External-facing</span><span>Arrow = communication route</span></div>`
}

function snapshot(model: DefaultViewModel): string {
  const active = model.activeRevision!
  const evolved = Object.entries(model.activeWorkspaceHeads).filter(([agent, head]) => head !== active.agentHeads[agent]).length
  return `<div class="details"><div class="detail-row"><span>Revision</span><code title="${escapeHtml(active.id)}">${short(active.id)}</code></div><div class="detail-row"><span>Parent</span><code>${active.parentRevision ? short(active.parentRevision) : "genesis"}</code></div><div class="detail-row"><span>Workspace heads</span><strong>${Object.keys(model.activeWorkspaceHeads).length}</strong></div><div class="detail-row"><span>Evolved after snapshot</span><strong>${evolved}</strong></div><div class="detail-row"><span>Plugins</span><strong>${active.definition.plugins.length}</strong></div></div><div class="details source-actions"><form method="post" action="/fork"><input type="hidden" name="sourceId" value="${escapeHtml(active.id)}"><button class="btn secondary" type="submit">Fork this revision</button></form></div>`
}

function evolution(model: DefaultViewModel): string {
  const items = [
    ...model.revisions.map((revision) => ({ seq: revision.ledgerFrontier, html: `<article class="flow-node${revision.active ? " active" : ""}"><span class="eyebrow">Revision</span><strong><code>${short(revision.id)}</code></strong><p>${revision.definition.agents.length} agents${revision.active ? " · active" : ""}</p><div class="source-actions"><form method="post" action="/fork"><input type="hidden" name="sourceId" value="${escapeHtml(revision.id)}"><button class="btn secondary" type="submit">Fork</button></form></div></article>` })),
    ...model.proposals.map((proposal) => ({ seq: proposal.seq, html: `<article class="flow-node"><span class="eyebrow">Proposal</span><strong><code>${short(proposal.id)}</code></strong><p>by ${escapeHtml(proposal.authoredBy)} · ${proposal.definition.agents.length} agents</p><div class="source-actions"><form method="post" action="/fork"><input type="hidden" name="sourceId" value="${escapeHtml(proposal.id)}"><button class="btn" type="submit">Fork and run</button></form></div></article>` })),
  ].sort((left, right) => left.seq - right.seq)
  return items.map((item) => item.html).join("") || `<div class="empty">No evolution recorded</div>`
}

function renderFork(fork: ForkView): string {
  return `<article class="fork"><header><div><span class="eyebrow">${fork.sourceKind} fork</span><h3><code>${short(fork.id)}</code></h3></div><span class="status ${fork.status}">${fork.status}</span></header><div class="metrics"><span>${fork.eventCount} events</span><span>${fork.communicationCount} communications</span><span>${Object.keys(fork.agentHeads).length} heads</span></div>${fork.tests.map((test) => `<div class="test"><span>${escapeHtml(test.id)}</span><span class="${test.passed ? "pass" : "fail"}">${test.passed ? "Passed" : "No evidence"}</span></div>`).join("")}${fork.status === "open" ? `<div class="actions"><form method="post" action="/approve"><input type="hidden" name="forkId" value="${escapeHtml(fork.id)}"><input type="hidden" name="frontier" value="${fork.frontier}"><button class="btn" type="submit">Approve</button></form><form method="post" action="/deny"><input type="hidden" name="forkId" value="${escapeHtml(fork.id)}"><input type="hidden" name="frontier" value="${fork.frontier}"><button class="btn danger" type="submit">Deny</button></form></div>` : ""}</article>`
}

function renderEvent(event: DefaultViewModel["events"][number]): string {
  const scope = event.scope.kind === "active" ? "main" : short(event.scope.forkId)
  return `<li><span class="seq">#${event.seq}</span><strong>${escapeHtml(event.type)}</strong><span class="actor">${escapeHtml(event.actor)}</span><span class="scope">${escapeHtml(scope)}</span></li>`
}

function short(id: string): string {
  return escapeHtml(id.length > 18 ? `${id.slice(0, 9)}…${id.slice(-6)}` : id)
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")
}
