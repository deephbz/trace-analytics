// Presentation only. All fitted probabilities, decisions, and scores come from analytics.
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmt=n=>n==null?'unavailable':Number(n).toFixed(4);
const percent=n=>(100*n).toFixed(1)+'%';

export function renderConditional(D) {
  const node=document.getElementById('conditional');const C=D.conditional;
  if(!C){node.textContent='Conditional model unavailable in this older report payload.';return;}
  const scores=[['Conditional',C.mean.conditional],['Pooled decision',C.mean.pooled],['Always 5m',C.mean.always5m],['Always 1h',C.mean.always1h]];
  const replayRoutes=[...new Set(C.sequential.results.flatMap(r=>Object.keys(r.byRoute)))];
  const bars=p=>`<span style="display:inline-flex;width:170px;height:16px">${p.map((v,i)=>`<span title="${['≤5m','5m–1h','no compatible access by 1h'][i]}: ${percent(v)}" style="width:${100*v}%;background:${['#398e83','#b38435','#8b799d'][i]}"></span>`).join('')}</span>`;
  node.innerHTML=`<h2>Conditional next-prefix-access model</h2>
  <p><b>${esc(C.recommendation)}</b></p>
  <p class="notes">${C.bridgeTestRequests} of ${C.test} held-out probability observations use the Magpie bridge. Bridge retention controls differ from a native Messages request. This is not a calibrated native Cache Goblin treatment effect.</p>
  <p class="sub">Training minimizes a bounded next-access objective. The held-out sequential replay then checks whether those decisions survive repeated accesses, refreshes, prefix growth, and upgrade writes. Neither calculation predicts your bill.</p>
  <h3>Held-out sequential session-prefix replay</h3>
  <table><tr><th>Policy</th><th>Input cost (API-price proxy)</th><th>Requests</th><th>Upgrade rewrites</th></tr>${C.sequential.results.map(r=>`<tr><td>${esc(r.policy)}</td><td>$${r.inputCost.toFixed(2)}</td><td>${r.requests}</td><td>${r.upgrades}</td></tr>`).join('')}</table>
  <details><summary>Sequential costs by route (controls may differ)</summary><table><tr><th>Route</th><th>Requests</th><th>5m</th><th>1h</th><th>Conditional</th></tr>${replayRoutes.map(route=>`<tr><td>${esc(route)}</td><td>${C.sequential.results[0].byRoute[route]?.requests??0}</td>${C.sequential.results.map(r=>`<td>$${(r.byRoute[route]?.inputCost??0).toFixed(2)}</td>`).join('')}</tr>`).join('')}</table><p>Routing through a bridge can override payload TTL. A route's counterfactual does not prove that Cache Goblin controls its provider cache. Inspect the physical Messages route and placement/usage evidence first.</p></details>
  <p class="notes">Best proxy: ${esc(C.sequentialBest??'unavailable')}. Cold-started at the test boundary; excludes warming and exact mixed-marker behavior. This is a check against both static baselines, not proof of a globally optimal policy.</p>
  <p class="notes">1h minus 5m mean input-cost difference per test session, session-bootstrap 95% interval: ${C.sequential.meanSessionDeltaCI?C.sequential.meanSessionDeltaCI.map(x=>'$'+x.toFixed(2)).join(' to '):'insufficient sessions'}. Negative favors 1h. This uncertainty does not cover missing marker or warming telemetry.</p>
  <details><summary>Sequential replay assumptions</summary><ul>${C.sequential.notes.map(s=>`<li>${esc(s)}</li>`).join('')}</ul></details>
  <h3>Probability calibration and cold-write decision objective</h3>
  <p>${C.train} training observations / ${C.test} later held-out observations; ${C.testSessions} test sessions. Split: ${new Date(C.splitAt).toISOString()}. Purged: ${C.purged}; right-censored: ${C.censored}; ambiguous forks: ${C.branched}; unpriced: ${C.unpriced}.</p>
  <p>Multiclass Brier score (lower is better): conditional <b>${fmt(C.mean.brierConditional)}</b>; pooled <b>${fmt(C.mean.brierPooled)}</b>.</p>
  <table><tr><th>Decision</th><th>Mean input-price units / cold-prefix opportunity</th></tr>${scores.map(([k,v])=>`<tr><td>${k}</td><td>${fmt(v)}</td></tr>`).join('')}</table>
  <p class="notes">Conditional minus pooled cost, session-bootstrap 95% interval: ${C.deltaVsPooledCI?C.deltaVsPooledCI.map(fmt).join(' to '):'insufficient sessions'}. Negative favors conditional. Catalog prices at calibration are fixed for this panel; price/policy edits below only update the static replay.</p>
  <h3>Does the predicted middle-band probability match later observations?</h3>
  <table><tr><th>Predicted probability bin</th><th>n</th><th>Mean prediction</th><th>Observed 5m–1h</th></tr>${C.calibration.map(b=>`<tr><td>${percent(b.from)}–${percent(b.to)}</td><td>${b.n}</td><td>${percent(b.predicted)}</td><td>${percent(b.observed)}</td></tr>`).join('')}</table>
  <details><summary>Fitted conditions (all mature observations; descriptive, not held-out scores)</summary><p>Green ≤5m · amber 5m–1h · purple no compatible access by 1h. Sparse conditions shrink toward the pooled distribution.</p><table><tr><th>Route | current input | prior context</th><th>n</th><th>Next access</th><th>P(5m–1h)</th></tr>${C.groups.map(g=>`<tr><td>${esc(g.condition)}</td><td>${g.n}</td><td>${bars(g.p)}</td><td>${percent(g.p[1])}</td></tr>`).join('')}</table></details>
  <details><summary>Decision model and limits</summary><ul>${C.assumptions.map(s=>`<li>${esc(s)}</li>`).join('')}</ul></details>
  <p class="notes"><b>Cache Goblin:</b> global/project markers already use 1h; the session tail and held pin use the selected session TTL. A 5m→1h upgrade can rewrite the whole prefix. Native warming eligibility changes with TTL and route. These logs do not supply exact marker survival or provider-touch times, so the conditional fit does not validate automatic Goblin switching. Placement events prove local layout, not provider cache hits.</p>`;
}

export function mountPrefixDemo() {
  const host=document.getElementById('prefix-demo');
  host.innerHTML=`<h2>A marker caches everything before it</h2>
  <p class="sub">Illustration, not a trace. A marker closes a prefix; it does not cache just the labeled block. Reuse requires the same prefix content. TTL sets how long an entry remains eligible after its last cache touch.</p>
  <svg viewBox="0 0 900 125" role="img" aria-label="Tools and global instructions end at G, project instructions end at P, a held history prefix ends at a pin, and newer messages end at the tail." style="width:100%;max-width:900px">
    <rect x="10" y="15" width="260" height="40" fill="#94cbbd"/><rect x="272" y="15" width="160" height="40" fill="#c0d4a6"/><rect x="434" y="15" width="235" height="40" fill="#e2c185"/><rect x="671" y="15" width="210" height="40" fill="#d7c7e5"/>
    <g fill="#222" text-anchor="middle"><text x="140" y="40">tools + global system</text><text x="352" y="40">project system</text><text x="550" y="40">held history</text><text x="776" y="40">newer messages</text></g>
    <g stroke="#666"><path d="M270 10V70 M432 10V70 M669 10V70 M881 10V70"/></g>
    <text x="235" y="88">G · 1h</text><text x="399" y="88">P · 1h</text><text x="605" y="88">pin · session</text><text x="794" y="88">tail · session</text>
    <path d="M10 105H881" stroke="#666"/><text x="10" y="121">prefix grows → a changed block invalidates prefixes that include it</text>
  </svg>
  <label>Next access after <input id="prefix-gap" type="range" min="0" max="90" value="12" style="width:220px"> <output id="prefix-gap-value"></output></label>
  <label style="margin-left:20px">Session TTL <select id="prefix-ttl"><option value="5">5m</option><option value="60">1h</option></select></label>
  <p id="prefix-state" style="padding:12px;border-left:4px solid #b38435"></p>
  <p class="notes">No intervening refresh in this illustration. Hits can refresh a matching entry; eviction and minimum size still apply. Global/project layers use 1h in Cache Goblin. Pins preserve a history boundary as the tail advances; they cannot preserve a prefix whose content changes.</p>`;
  const draw=()=>{const gap=Number(document.getElementById('prefix-gap').value),ttl=Number(document.getElementById('prefix-ttl').value);document.getElementById('prefix-gap-value').textContent=gap+' min';document.getElementById('prefix-state').textContent=`System prefixes: ${gap<=60?'within 1h retention':'expired in this illustration'}. Session prefix: ${gap<=ttl?'within selected retention; eligible for a read':'past selected retention; needs a new write'}. Eligibility is not a provider-hit guarantee.`;};
  document.getElementById('prefix-gap').addEventListener('input',draw);document.getElementById('prefix-ttl').addEventListener('change',draw);draw();
}
