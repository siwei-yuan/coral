export const viewScript = String.raw`
const dialog = document.querySelector('[data-info-dialog]')
const openDialog = trigger => {
  dialog.querySelector('[data-dialog-title]').textContent = trigger.dataset.dialogTitle || ''
  dialog.querySelector('[data-dialog-meta]').textContent = trigger.dataset.dialogMeta || ''
  dialog.querySelector('[data-dialog-detail]').textContent = trigger.dataset.dialogDetail || ''
  dialog.showModal()
}
document.querySelectorAll('[data-dialog-title]').forEach(trigger => {
  if (!trigger.matches('[data-detail-id]')) trigger.addEventListener('click', () => openDialog(trigger))
})
document.querySelector('[data-dialog-close]')?.addEventListener('click', () => dialog.close())
dialog?.addEventListener('click', event => { if (event.target === dialog) dialog.close() })

for (const canvas of document.querySelectorAll('[data-evolution-canvas]')) {
  const viewport = canvas.querySelector('[data-evolution-viewport]')
  const plane = canvas.querySelector('[data-evolution-plane]')
  const overview = canvas.querySelector('[data-overview-layer]')
  const mode = canvas.closest('.evolution-section').querySelector('[data-evolution-mode]')
  let active = overview, scale = 1, x = 20, y = 18, drag = null, moved = false
  const size = layer => ({ width: Number(layer.dataset.width), height: Number(layer.dataset.height) })
  const draw = () => { plane.style.transform = 'translate(' + x + 'px,' + y + 'px) scale(' + scale + ')' }
  const fit = () => {
    const dimensions = size(active)
    plane.style.width = dimensions.width + 'px'; plane.style.height = dimensions.height + 'px'
    const widthScale = Math.min(1, (viewport.clientWidth - 36) / dimensions.width)
    const overviewHeight = Math.max(440, Math.min(viewport.clientWidth < 800 ? 560 : 620, dimensions.height * widthScale + 52))
    viewport.style.height = (active === overview ? overviewHeight : 620) + 'px'
    scale = Math.min(1, (viewport.clientWidth - 36) / dimensions.width, (viewport.clientHeight - 36) / dimensions.height)
    x = Math.max(18, (viewport.clientWidth - dimensions.width * scale) / 2); y = 18; draw()
  }
  const showOverview = () => { active.hidden = true; overview.hidden = false; active = overview; mode.textContent = 'Revision map'; fit() }
  const showDetail = id => {
    const detail = canvas.querySelector('[data-detail-layer="' + CSS.escape(id) + '"]')
    if (!detail) return
    active.hidden = true; detail.hidden = false; active = detail
    mode.textContent = detail.querySelector('h3').textContent + ' · Timeline'; fit()
  }
  const zoom = (factor, cx = viewport.clientWidth / 2, cy = viewport.clientHeight / 2) => {
    const next = Math.min(1.65, Math.max(.28, scale * factor))
    if (active !== overview && next < .34) { showOverview(); return }
    const worldX = (cx - x) / scale, worldY = (cy - y) / scale
    if (active === overview && next > .92) {
      const target = [...overview.querySelectorAll('[data-detail-id]')].find(node => Math.abs(worldX - Number(node.dataset.nodeX)) <= Number(node.dataset.nodeWidth) / 2 && Math.abs(worldY - Number(node.dataset.nodeY)) <= Number(node.dataset.nodeHeight) / 2)
      if (target) { showDetail(target.dataset.detailId); return }
    }
    x = cx - worldX * next; y = cy - worldY * next; scale = next; draw()
  }
  overview.querySelectorAll('[data-detail-id]').forEach(node => node.addEventListener('click', () => { if (!moved) showDetail(node.dataset.detailId) }))
  canvas.querySelectorAll('[data-detail-back]').forEach(button => button.addEventListener('click', showOverview))
  viewport.addEventListener('pointerdown', event => { if (event.target.closest('button,form,input')) return; drag = { px:event.clientX,py:event.clientY,x,y }; moved = false; viewport.setPointerCapture(event.pointerId); viewport.classList.add('dragging') })
  viewport.addEventListener('pointermove', event => { if (!drag) return; x = drag.x + event.clientX - drag.px; y = drag.y + event.clientY - drag.py; moved ||= Math.abs(event.clientX-drag.px)+Math.abs(event.clientY-drag.py)>4; draw() })
  viewport.addEventListener('pointerup', event => { drag = null; viewport.classList.remove('dragging'); if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId) })
  viewport.addEventListener('wheel', event => { event.preventDefault(); const box=viewport.getBoundingClientRect(); zoom(Math.exp(-event.deltaY*.0012),event.clientX-box.left,event.clientY-box.top) }, { passive:false })
  canvas.querySelectorAll('[data-canvas-action]').forEach(button => button.addEventListener('click', () => button.dataset.canvasAction === 'fit' ? fit() : zoom(button.dataset.canvasAction === 'in' ? 1.25 : .8)))
  new ResizeObserver(fit).observe(viewport); fit()
}

const initializeTopology = sector => {
  const graph = sector.querySelector('.topology-graph'), rows = [...sector.querySelectorAll('[data-ledger-event]')]
  const ledger = sector.querySelector('.event-ledger')
  const control = sector.previousElementSibling, start = control.querySelector('[data-range-start]'), end = control.querySelector('[data-range-end]')
  const play = control.querySelector('[data-play-routing]'), status = sector.querySelector('[data-routing-status]'), dot = graph.querySelector('[data-flow-dot]')
  let token = 0, playing = false
  const clear = () => { dot.style.opacity='0'; sector.querySelectorAll('.is-active,.is-flowing').forEach(node => node.classList.remove('is-active','is-flowing')) }
  const edgeFor = (from,to) => [...graph.querySelectorAll('[data-routes]')].find(edge => edge.dataset.routes.split(',').includes(from+'>'+to))
  const animateEdge = (edge,from,currentToken) => new Promise(resolve => {
    edge.classList.add('is-flowing'); dot.style.opacity='1'
    const reverse=edge.dataset.edgeFrom!==from,length=edge.getTotalLength(),started=performance.now(),duration=matchMedia('(prefers-reduced-motion: reduce)').matches?1:560
    const frame=now=>{ if(currentToken!==token){resolve();return} const progress=Math.min(1,(now-started)/duration),point=edge.getPointAtLength(length*(reverse?1-progress:progress));dot.setAttribute('cx',point.x);dot.setAttribute('cy',point.y);if(progress<1)requestAnimationFrame(frame);else{edge.classList.remove('is-flowing');resolve()} };requestAnimationFrame(frame)
  })
  const stop = () => { playing=false; token++; play.textContent='▶ Play routing'; play.classList.remove('playing'); clear() }
  const preview = async (row,currentToken) => {
    clear(); row.classList.add('is-active')
    const ledgerBox=ledger.getBoundingClientRect(),rowBox=row.getBoundingClientRect()
    if(rowBox.top<ledgerBox.top)ledger.scrollTop-=ledgerBox.top-rowBox.top
    else if(rowBox.bottom>ledgerBox.bottom)ledger.scrollTop+=rowBox.bottom-ledgerBox.bottom
    const from=row.dataset.actorNode,targets=row.dataset.targetNodes.split(',').filter(Boolean),owner=row.dataset.ownerNode
    const routed=targets.filter(to=>edgeFor(from,to))
    status.textContent=routed.length?'#'+row.dataset.eventSeq+' · '+from+' → '+routed.join(', '):owner?'#'+row.dataset.eventSeq+' · '+owner:'#'+row.dataset.eventSeq+' · Swarm control event'
    for(const id of [from,...targets,owner].filter(Boolean)) graph.querySelector('[data-topology-node="'+CSS.escape(id)+'"]')?.classList.add('is-active')
    if(!routed.length){await new Promise(resolve=>setTimeout(resolve,260));return}
    for(const to of routed){if(currentToken!==token)return;await animateEdge(edgeFor(from,to),from,currentToken)}
  }
  const renderRange = changed => {
    let low=Number(start.value),high=Number(end.value);if(low>high){if(changed===start)high=low;else low=high;start.value=String(low);end.value=String(high)}
    stop();const min=Number(start.min),max=Number(start.max),span=Math.max(1,max-min),left=(low-min)/span*100,right=(high-min)/span*100
    const selected=control.querySelector('[data-range-selection]');selected.style.left=left+'%';selected.style.width=(right-left)+'%'
    const visible=rows.filter(row=>{const seq=Number(row.dataset.eventSeq),show=seq>=low&&seq<=high;row.closest('li').hidden=!show;return show})
    control.querySelector('[data-range-start-label]').textContent='#'+low+' · '+(rows.find(row=>Number(row.dataset.eventSeq)===low)?.dataset.eventTime||'')
    control.querySelector('[data-range-end-label]').textContent='#'+high+' · '+(rows.find(row=>Number(row.dataset.eventSeq)===high)?.dataset.eventTime||'')
    sector.querySelector('[data-ledger-range]').textContent='#'+low+'–#'+high
    sector.closest('.topology-section').querySelector('[data-range-count]').textContent=visible.length+' Event'+(visible.length===1?'':'s');status.textContent='Ready'
  }
  start.addEventListener('input',()=>renderRange(start));end.addEventListener('input',()=>renderRange(end))
  rows.forEach(row=>row.addEventListener('click',()=>{stop();const current=++token;preview(row,current)}))
  play.addEventListener('click',async()=>{if(playing){stop();status.textContent='Stopped';return}const visible=rows.filter(row=>!row.closest('li').hidden);playing=true;const current=++token;play.textContent='■ Stop';play.classList.add('playing');for(const row of visible){if(current!==token)return;await preview(row,current)}if(current===token){playing=false;play.textContent='▶ Play routing';play.classList.remove('playing');clear();status.textContent='Complete'}})
  renderRange(start)
}
document.querySelectorAll('[data-topology-sector]').forEach(initializeTopology)

let topologyRefreshing = false
const refreshTopology = async () => {
  const current = document.querySelector('.topology-section')
  if (!current || topologyRefreshing || document.hidden || current.querySelector('.play-button.playing')) return
  topologyRefreshing = true
  try {
    const response = await fetch('/_view/topology?after=' + current.dataset.ledgerHead, { cache:'no-store' })
    if (response.status === 204) return
    if (!response.ok) throw new Error('Unable to refresh Event Ledger')
    const previousStart = current.querySelector('[data-range-start]')
    const previousEnd = current.querySelector('[data-range-end]')
    const followedHead = previousEnd?.value === previousEnd?.max
    const template = document.createElement('template')
    template.innerHTML = await response.text()
    const next = template.content.firstElementChild
    const nextStart = next.querySelector('[data-range-start]')
    const nextEnd = next.querySelector('[data-range-end]')
    if (previousStart && nextStart) nextStart.value = String(Math.min(Number(previousStart.value), Number(nextStart.max)))
    if (previousEnd && nextEnd && !followedHead) nextEnd.value = String(Math.min(Number(previousEnd.value), Number(nextEnd.max)))
    current.replaceWith(next)
    next.querySelectorAll('[data-topology-sector]').forEach(initializeTopology)
  } catch {}
  finally { topologyRefreshing = false }
}
if (document.body.classList.contains('overview-page')) setInterval(refreshTopology, 1000)
`

export const styles = `
:root{color-scheme:light dark;--blue:#007aff;--blue-soft:#eaf4ff;--blue-line:#90c5ff;--ink:#1d1d1f;--muted:#6e6e73;--line:rgba(60,60,67,.18);--surface:#fff;--node:#fff;--canvas:#f5f5f7;--canvas-soft:#fbfbfd;--page:#f4f7fb;--material:rgba(255,255,255,.78);--material-solid:#fff;--material-edge:rgba(255,255,255,.82);--danger:#d70015;--success:#248a3d;--shadow:0 1px 2px rgba(25,39,58,.04),0 18px 48px rgba(32,62,92,.09)}
@media(prefers-color-scheme:dark){:root{--blue:#0a84ff;--blue-soft:rgba(10,132,255,.14);--blue-line:#4da3ff;--ink:#f5f5f7;--muted:#a1a1a6;--line:rgba(255,255,255,.14);--surface:#1c1c1e;--node:#222225;--canvas:#000;--canvas-soft:#161618;--page:#07090c;--material:rgba(29,29,31,.76);--material-solid:#1c1c1e;--material-edge:rgba(255,255,255,.12);--danger:#ff453a;--success:#30d158;--shadow:0 22px 58px rgba(0,0,0,.34)}}
*{box-sizing:border-box}html{min-height:100%;background:var(--page)}body{min-height:100vh;margin:0;color:var(--ink);background:radial-gradient(circle at 18% -8%,color-mix(in srgb,var(--blue) 10%,transparent),transparent 34rem),var(--page);font:14px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",sans-serif;font-optical-sizing:auto;-webkit-font-smoothing:antialiased}a{color:inherit;text-decoration:none}button,input,textarea{font:inherit}button,a{-webkit-tap-highlight-color:transparent}button:focus-visible,a:focus-visible,[tabindex]:focus-visible,input:focus-visible,textarea:focus-visible{outline:3px solid color-mix(in srgb,var(--blue) 32%,transparent);outline-offset:3px}button:active,.button:active,.nav-link:active{transform:scale(.97);transition:transform 90ms ease-out}code{font-family:"SFMono-Regular",ui-monospace,Menlo,monospace;font-size:.92em}nav{position:sticky;top:0;z-index:20;display:flex;align-items:center;justify-content:space-between;gap:20px;padding:11px max(22px,calc((100vw - 1280px)/2));background:color-mix(in srgb,var(--material) 88%,transparent);box-shadow:0 1px 0 var(--line),0 8px 28px rgba(25,42,66,.045);backdrop-filter:saturate(180%) blur(24px)}.brand{display:flex;align-items:center;gap:9px;font-size:18px;font-weight:650;letter-spacing:-.025em;color:var(--ink)}.brand:before{content:"";width:17px;height:17px;border-radius:6px;background:linear-gradient(145deg,#58a9ff,var(--blue));box-shadow:inset 0 1px 1px rgba(255,255,255,.55),0 3px 9px color-mix(in srgb,var(--blue) 22%,transparent)}.nav-items{display:flex;gap:3px;padding:3px;overflow:auto;border:1px solid color-mix(in srgb,var(--line) 76%,transparent);border-radius:999px;background:color-mix(in srgb,var(--canvas-soft) 70%,transparent)}.nav-link{padding:6px 12px;border-radius:999px;color:var(--muted);font-size:13px;font-weight:500;white-space:nowrap;transition:background .16s ease,color .16s ease,box-shadow .16s ease}.nav-link:hover{color:var(--ink)}.nav-link.active{background:var(--material-solid);color:var(--blue);box-shadow:0 1px 2px rgba(0,0,0,.08),0 3px 10px rgba(0,0,0,.05)}main{max-width:1280px;margin:auto;padding:52px 22px 84px}.hero{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;margin-bottom:26px}.hero.compact{margin-bottom:22px}.hero h1{margin:4px 0 7px;font-size:clamp(2.5rem,5vw,3.5rem);line-height:1.04;letter-spacing:-.052em;font-weight:650}.hero>div>p:last-child{max-width:680px;margin:0;color:var(--muted);font-size:16px;line-height:1.5}.eyebrow{margin:0;color:var(--blue);font-size:11px;font-weight:650;letter-spacing:.1em;text-transform:uppercase}.status{display:inline-flex;align-items:center;gap:8px;padding:7px 11px;border:1px solid color-mix(in srgb,var(--blue) 16%,transparent);border-radius:999px;background:var(--blue-soft);color:var(--blue);font-size:12px;font-weight:550}.status i{width:7px;height:7px;border-radius:50%;background:var(--blue);box-shadow:0 0 0 4px color-mix(in srgb,var(--blue) 12%,transparent)}.notice{padding:13px 15px;border:1px solid color-mix(in srgb,var(--danger) 30%,transparent);border-radius:16px;background:color-mix(in srgb,var(--danger) 8%,var(--material-solid));color:var(--danger)}.surface{overflow:hidden;border:1px solid var(--material-edge);border-radius:26px;background:var(--material);box-shadow:var(--shadow);backdrop-filter:saturate(160%) blur(28px)}.topology-section{margin-top:26px}.section-head{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:20px 24px;border-bottom:1px solid var(--line);background:linear-gradient(180deg,color-mix(in srgb,var(--material-solid) 48%,transparent),transparent)}.section-head h2{margin:0;font-size:18px;line-height:1.2;letter-spacing:-.025em;font-weight:630}.section-head p{margin:4px 0 0;color:var(--muted);font-size:12px}.section-badge{padding:6px 10px;border:1px solid color-mix(in srgb,var(--blue) 12%,transparent);border-radius:999px;background:var(--blue-soft);color:var(--blue);font-size:11px;font-weight:550;white-space:nowrap}
.canvas-shell{position:relative}.canvas-tools{position:absolute;right:14px;top:14px;z-index:8;display:flex;gap:2px;padding:4px;border:1px solid var(--line);border-radius:13px;background:color-mix(in srgb,var(--surface) 88%,transparent);box-shadow:0 4px 18px rgba(0,0,0,.12);backdrop-filter:blur(18px)}.canvas-tools button{min-width:34px;height:30px;padding:0 9px;border:0;border-radius:9px;background:transparent;color:var(--ink);font-weight:600;cursor:pointer}.canvas-tools button:hover{background:var(--blue-soft);color:var(--blue)}.evolution-viewport{height:520px;overflow:hidden;position:relative;touch-action:none;cursor:grab;background-color:var(--canvas-soft);background-image:radial-gradient(color-mix(in srgb,var(--muted) 22%,transparent) .7px,transparent .7px);background-size:18px 18px}.evolution-viewport.dragging{cursor:grabbing}.evolution-plane{position:absolute;left:0;top:0;transform-origin:0 0;will-change:transform}.overview-layer,.timeline-detail{position:absolute;inset:0}.overview-layer[hidden],.timeline-detail[hidden]{display:none}.overview-layer>svg{position:absolute;inset:0;width:100%;height:100%}.evolution-edge{fill:none;stroke:color-mix(in srgb,var(--muted) 46%,transparent);stroke-width:2}.evolution-node{position:absolute;border:0;color:var(--ink);font:inherit;cursor:pointer}.state-node{display:flex;flex-direction:column;align-items:flex-start;justify-content:center;width:200px;height:120px;padding:16px 18px;border:1.5px solid var(--blue-line);border-radius:22px;background:color-mix(in srgb,var(--blue) 5%,var(--node));box-shadow:0 8px 20px rgba(0,0,0,.09);text-align:left}.state-node.fork{border-color:color-mix(in srgb,var(--muted) 52%,var(--line));background:var(--node)}.state-node.denied{border-color:var(--danger)}.state-node.active{box-shadow:0 0 0 3px color-mix(in srgb,var(--blue) 13%,transparent),0 10px 24px rgba(0,0,0,.12)}.node-kind{color:var(--blue);font-size:10px;font-weight:600;letter-spacing:.08em;text-transform:uppercase}.state-node strong{margin-top:7px;font-size:17px}.state-node small,.node-metrics{color:var(--muted)}.node-metrics{display:block;max-width:100%;margin-top:8px;overflow:hidden;font-size:10px;text-overflow:ellipsis;white-space:nowrap}.control-node{width:86px;height:86px;padding:0;background:transparent;transform:rotate(45deg)}.control-node:before{content:"";position:absolute;inset:3px;border:2px solid var(--blue);border-radius:14px;background:var(--node);box-shadow:0 7px 16px rgba(0,0,0,.09)}.control-node>span{position:relative;z-index:1;display:flex;flex-direction:column;align-items:center;justify-content:center;width:100%;height:100%;transform:rotate(-45deg)}.control-node b{font-size:15px}.control-node small{color:var(--muted);font-size:9px}.control-node.denied:before{border-color:var(--danger)}
.timeline-detail>header{position:absolute;left:180px;top:78px;right:180px}.timeline-detail h3{margin:5px 0 4px;font-size:34px;letter-spacing:-.035em}.timeline-detail header>p:last-of-type{margin:0;color:var(--muted)}.timeline-detail header form,.decision-actions{position:absolute;right:0;top:8px}.decision-actions{display:flex;gap:8px}.back-button{position:absolute;left:180px;top:34px;border:0;background:transparent;color:var(--blue);cursor:pointer}.timeline-columns{position:absolute;left:180px;right:180px;top:240px;display:grid;grid-template-columns:260px 210px 1fr auto;color:var(--muted);font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase}.timeline-columns strong{color:var(--ink)}.timeline-axis{position:absolute;left:650px;right:230px;top:273px;border-top:1.5px solid var(--ink)}.timeline-next{position:absolute;right:230px;top:273px;bottom:80px;border-left:2px solid var(--blue)}.timeline-lane{position:absolute;left:180px;right:180px;height:1px}.resource-label{position:absolute;left:0;top:-20px;width:240px}.resource-label small,.resource-label strong{display:block}.resource-label small{color:var(--blue);font-size:9px;letter-spacing:.08em;text-transform:uppercase}.resource-label strong{margin-top:2px;font-size:15px}.initial-head{position:absolute;left:260px;top:-8px;width:190px;overflow:hidden;color:var(--muted);text-overflow:ellipsis}.lane-line{position:absolute;left:470px;right:50px;border-top:1px solid color-mix(in srgb,var(--muted) 30%,transparent)}.initial-mark{position:absolute;left:466px;top:-4px;width:9px;height:9px;border-radius:50%;background:var(--blue)}.commit-node{position:absolute;width:20px;height:20px;padding:0;border:3px solid var(--blue);border-radius:50%;background:var(--node);cursor:pointer}.commit-node i{display:none}.commit-node span{position:absolute;left:50%;bottom:24px;width:110px;transform:translateX(-50%);overflow:hidden;color:var(--ink);font:10px "SFMono-Regular",ui-monospace,monospace;text-overflow:ellipsis;white-space:nowrap}.commit-node:hover{background:var(--blue-soft);box-shadow:0 0 0 5px color-mix(in srgb,var(--blue) 12%,transparent)}
.time-control{padding:16px 20px 18px;border-bottom:1px solid var(--line)}.range-meta{display:flex;justify-content:space-between;margin-bottom:8px;color:var(--muted);font-size:11px}.range-meta strong{color:var(--ink)}.range-row{display:flex;align-items:center;gap:18px}.dual-range{position:relative;flex:1;height:34px}.range-track{position:absolute;left:0;right:0;top:15px;height:4px;border-radius:999px;background:color-mix(in srgb,var(--muted) 22%,transparent)}.range-track b{position:absolute;height:100%;border-radius:inherit;background:var(--blue)}.dual-range input{position:absolute;inset:0;width:100%;height:34px;margin:0;appearance:none;background:transparent;pointer-events:none}.dual-range input::-webkit-slider-runnable-track{height:4px;background:transparent}.dual-range input::-webkit-slider-thumb{width:18px;height:18px;margin-top:-7px;border:3px solid var(--surface);border-radius:50%;appearance:none;background:var(--blue);box-shadow:0 0 0 1px var(--blue-line);pointer-events:auto}.play-button{min-width:132px}.topology-layout{display:grid;grid-template-columns:minmax(0,1fr) 390px}.ledger-pane{border-left:1px solid var(--line)}.pane-head{height:51px;display:flex;align-items:center;justify-content:space-between;padding:0 18px;border-bottom:1px solid var(--line)}.pane-head small{color:var(--muted)}.topology-graph{display:block;width:100%;height:568px;background:linear-gradient(180deg,color-mix(in srgb,var(--blue) 3%,var(--canvas-soft)),var(--canvas-soft) 55%)}.topology-edge{fill:none;stroke:color-mix(in srgb,var(--muted) 38%,transparent);stroke-linecap:round;stroke-width:1.5;transition:stroke .16s,stroke-width .16s}.topology-edge.is-flowing{stroke:var(--blue);stroke-width:4;filter:drop-shadow(0 0 5px color-mix(in srgb,var(--blue) 60%,transparent))}.topology-graph marker path{fill:color-mix(in srgb,var(--muted) 55%,transparent)}.topology-node rect{fill:var(--node);stroke:var(--line);stroke-width:1.5}.topology-node.agent rect{stroke:color-mix(in srgb,var(--blue) 52%,var(--line))}.topology-node.plugin rect{stroke:color-mix(in srgb,var(--success) 52%,var(--line))}.topology-node text{fill:var(--ink)}.node-type{font-size:10px;font-weight:600;letter-spacing:.09em;fill:var(--muted)!important}.node-title{font-size:15px;font-weight:600}.node-relation{font-size:10px;fill:var(--muted)!important}.topology-node.is-active rect{stroke:var(--blue);stroke-width:5}.flow-dot{fill:var(--blue);stroke:var(--surface);stroke-width:3;opacity:0;filter:drop-shadow(0 0 6px var(--blue))}.event-ledger{height:568px;overflow:auto;list-style:none;margin:0;padding:0}.event-ledger li[hidden]{display:none}.event-ledger button{display:grid;width:100%;grid-template-columns:42px 54px minmax(0,1fr);gap:8px;padding:10px 14px;border:0;border-bottom:1px solid var(--line);background:transparent;color:inherit;text-align:left;cursor:pointer}.event-ledger button:hover,.event-ledger button.is-active{background:var(--blue-soft)}.event-ledger .sequence,.event-ledger time{color:var(--muted);font:10px "SFMono-Regular",ui-monospace,monospace}.event-ledger strong,.event-ledger small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.event-ledger strong{font-size:11px}.event-ledger small{margin-top:3px;color:var(--muted);font-size:10px}
.button{appearance:none;min-height:38px;border:0;border-radius:999px;padding:8px 16px;background:var(--blue);color:#fff;font-weight:620;cursor:pointer;box-shadow:inset 0 1px 0 rgba(255,255,255,.2),0 5px 14px color-mix(in srgb,var(--blue) 22%,transparent);transition:filter .16s ease,transform 90ms ease-out}.button:hover{filter:brightness(1.04)}.button:disabled{cursor:default;filter:saturate(.55);opacity:.6}.button.quiet{background:var(--blue-soft);color:var(--blue);box-shadow:none}.button.danger-button{border:1px solid color-mix(in srgb,var(--danger) 30%,transparent);background:transparent;color:var(--danger);box-shadow:none}.info-dialog{width:min(560px,calc(100vw - 32px));padding:30px;border:1px solid var(--material-edge);border-radius:26px;background:var(--material);color:var(--ink);box-shadow:0 34px 100px rgba(0,0,0,.34);backdrop-filter:saturate(170%) blur(28px)}.info-dialog[open]{animation:material-in .22s cubic-bezier(.2,.8,.2,1)}.info-dialog::backdrop{background:rgba(8,12,18,.32);backdrop-filter:blur(14px);animation:fade-in .18s ease-out}.info-dialog h2{margin:7px 40px 6px;font-size:24px;letter-spacing:-.025em}.info-dialog>p:last-child{color:var(--muted)}.dialog-close{position:absolute;right:17px;top:15px;width:34px;height:34px;border:0;border-radius:50%;background:color-mix(in srgb,var(--muted) 11%,var(--material-solid));color:var(--ink);font-size:22px;cursor:pointer}.empty{margin:0;padding:56px 20px;color:var(--muted);text-align:center}.extension{padding:24px}.field{display:grid;gap:7px}.field label{font-weight:620}.field input,.field textarea{width:100%;padding:12px 13px;border:1px solid var(--line);border-radius:14px;background:var(--node);color:var(--ink)}.field textarea{min-height:90px;resize:vertical}@keyframes material-in{from{opacity:0;transform:scale(.97) translateY(6px)}to{opacity:1;transform:none}}@keyframes fade-in{from{opacity:0}to{opacity:1}}
button:active{transform:none}
@media(max-width:1000px){.topology-layout{grid-template-columns:1fr}.ledger-pane{border-top:1px solid var(--line);border-left:0}.event-ledger{height:420px}}
@media(max-width:800px){main{padding:36px 14px 60px}.hero,.section-head{align-items:flex-start;flex-direction:column}.hero h1{font-size:2.55rem}.range-row{align-items:stretch;flex-direction:column}.play-button{align-self:flex-end}nav{gap:12px;padding:10px 14px}.nav-items{min-width:0}.extension{padding:14px}}
@media(max-width:520px){.brand:before{display:none}.brand{font-size:17px}.nav-link{padding:6px 10px}.hero h1{font-size:2.25rem}.surface{border-radius:22px}}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}.evolution-plane{will-change:auto}.topology-edge{transition:none}}
@media(prefers-reduced-transparency:reduce){nav,.surface,.info-dialog{background:var(--material-solid);backdrop-filter:none}.info-dialog::backdrop{backdrop-filter:none}}
@media(prefers-contrast:more){:root{--line:color-mix(in srgb,var(--ink) 34%,transparent);--material-edge:color-mix(in srgb,var(--ink) 44%,transparent)}nav,.surface,.info-dialog{background:var(--material-solid)}}
`
