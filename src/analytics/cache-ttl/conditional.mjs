// Conditional next-access distribution, calibrated before a held-out time window.
// Decision features exist at request start. Cache touches and stable prefix identity
// are not logged here: same-route lineage and request starts are explicit proxies.
import {POLICIES} from './policies.mjs';
import {tierRates} from '../rates.mjs';
import {replayAdaptive} from './adaptive-replay.mjs';
const SHORT=POLICIES.anthropic['5m'].ttlSec*1000, LONG=POLICIES.anthropic['1h'].ttlSec*1000;
const W5=POLICIES.anthropic['5m'].write,W1=POLICIES.anthropic['1h'].write;
const key=(c)=>`${c.source}|${c.session}|${c.id}`;
const eligible=(c)=>c.source==='pi'&&c.purpose==='turn'&&/claude|anthropic/i.test(c.route??'');

function features(c,all){
  const prev=all.get(`${c.source}|${c.session}|${c.prev}`);
  const priorPrompt=prev?(prev.input??0)+(prev.cacheRead??0)+(prev.cacheWrite??0):null;
  const context=priorPrompt==null?'unknown':priorPrompt<64000?'under64k':priorPrompt<128000?'64-128k':'128k+';
  const cause=['tool','user','compaction','other'].includes(c.cause)?c.cause:'unknown';
  return {priorPrompt,context,cause,condition:`${c.route} | ${cause} | ${context}`};
}

export function observations({calls,window}) {
  const all=new Map(calls.map(c=>[key(c),c])),children=new Map();
  for(const c of calls){
    if(c.purpose!=='turn'||c.prev==null||c.t>=window.untilMs)continue;
    const k=`${c.source}|${c.session}|${c.prev}`;
    if(!children.has(k))children.set(k,[]);
    children.get(k).push(c);
  }
  const rows=[];let censored=0,branched=0,invalid=0;
  for(const c of calls){
    if(!eligible(c)||c.t<window.sinceMs||c.t>=window.untilMs)continue;
    if(c.t+LONG>window.untilMs){censored++;continue;}
    const successors=children.get(key(c))??[];
    if(successors.length>1){branched++;continue;}
    const n=successors[0];
    if(n&&n.t<c.t){invalid++;continue;}
    const delay=n&&n.reset==null&&n.route===c.route?n.t-c.t:Infinity;
    const label=delay<=SHORT?0:delay<=LONG?1:2;
    rows.push({t:c.t,session:c.session,route:c.route,...features(c,all),label,
      delayMs:Number.isFinite(delay)?delay:null});
  }
  return {rows,censored,branched,invalid};
}

function frequency(rows){const n=[0,0,0];for(const r of rows)n[r.label]++;return n;}
export function fit(rows,shrinkage=30){
  const counts=frequency(rows),n=rows.length;
  const pooled=counts.map(x=>(x+1)/(n+3));const groups={};
  for(const r of rows){groups[r.condition]??={n:0,counts:[0,0,0]};groups[r.condition].n++;groups[r.condition].counts[r.label]++;}
  for(const g of Object.values(groups))g.p=g.counts.map((x,i)=>(x+shrinkage*pooled[i])/(g.n+shrinkage));
  return {n,pooled,groups,shrinkage};
}
export const predict=(model,row)=>model.groups[row.condition]?.p??model.pooled;
export const choice=(p,read=.1)=>(W1-W5)<(W5-read)*p[1]?'1h':'5m';
// Input-price units for one cold write plus at most one reuse within one hour.
// Later accesses have equal follow-on costs outside this bounded objective.
export function loss(ttl,label,read=.1){return ttl==='1h'?W1+(label<2?read:0):W5+(label===0?read:label===1?W5:0);}
const brier=(p,y)=>p.reduce((s,v,i)=>s+(v-(i===y?1:0))**2,0);
function sessionCI(rows){
  const groups=new Map();for(const r of rows){if(!groups.has(r.session))groups.set(r.session,[]);groups.get(r.session).push(r.delta);}
  const blocks=[...groups.values()];if(blocks.length<5)return null;
  let seed=7291;const rand=()=>{seed=(1664525*seed+1013904223)>>>0;return seed/4294967296;};
  const estimates=[];
  for(let b=0;b<400;b++){let sum=0,n=0;for(let j=0;j<blocks.length;j++)for(const x of blocks[Math.floor(rand()*blocks.length)]){sum+=x;n++;}estimates.push(sum/n);}
  estimates.sort((a,b)=>a-b);return [estimates[10],estimates[389]];
}

export function analyzeConditional(data,pricesByRoute={}) {
  const obs=observations(data);
  let unpriced=0;
  obs.rows=obs.rows.filter(r=>{
    const price=pricesByRoute[r.route];
    if(!price){unpriced++;return false;}
    const rates=tierRates(price,r.priorPrompt??0);
    if(!(rates.input>0)||!Number.isFinite(rates.cacheRead)){unpriced++;return false;}
    r.readRatio=rates.cacheRead/rates.input;
    return true;
  });
  const cut=Math.round(data.window.sinceMs+.7*(data.window.untilMs-data.window.sinceMs));
  const train=obs.rows.filter(r=>r.t+LONG<=cut),test=obs.rows.filter(r=>r.t>=cut);
  const model=fit(train),full=fit(obs.rows),pooledChoice=choice(model.pooled);
  const totals={conditional:0,pooled:0,always5m:0,always1h:0,brierConditional:0,brierPooled:0};
  const scored=[],bins=Array.from({length:5},(_,i)=>({from:i/5,to:(i+1)/5,n:0,predicted:0,observed:0}));
  for(const r of test){
    const p=predict(model,r),action=choice(p,r.readRatio),a=loss(action,r.label,r.readRatio),baseline=loss(choice(model.pooled,r.readRatio),r.label,r.readRatio);
    totals.conditional+=a;totals.pooled+=baseline;totals.always5m+=loss('5m',r.label,r.readRatio);totals.always1h+=loss('1h',r.label,r.readRatio);
    totals.brierConditional+=brier(p,r.label);totals.brierPooled+=brier(model.pooled,r.label);
    const bin=bins[Math.min(4,Math.floor(p[1]*5))];bin.n++;bin.predicted+=p[1];bin.observed+=r.label===1?1:0;
    scored.push({...r,p,action,delta:a-baseline});
  }
  const ci=sessionCI(scored),n=test.length;
  const mean=Object.fromEntries(Object.entries(totals).map(([k,v])=>[k,n?v/n:null]));
  const all=new Map(data.calls.map(c=>[key(c),c]));
  const sequential=replayAdaptive(data,pricesByRoute,cut,c=>{
    const f=features(c,all),rate=tierRates(pricesByRoute[c.route],f.priorPrompt??0);
    return choice(predict(model,f),rate.cacheRead/rate.input);
  });
  const shortCost=sequential.results[0].bySession,longCost=sequential.results[1].bySession;
  sequential.meanSessionDeltaCI=sessionCI([...new Set([...Object.keys(shortCost),...Object.keys(longCost)])].map(session=>({session,delta:(longCost[session]??0)-(shortCost[session]??0)})));
  const sequentialBest=sequential.results.reduce((a,b)=>a.inputCost<=b.inputCost?a:b);
  const conditionalSupported=!!(sequentialBest.policy==='conditional'&&n>=100&&ci&&ci[1]<0&&mean.brierConditional<mean.brierPooled&&mean.conditional<Math.min(mean.always5m,mean.always1h));
  return {kind:'conditional-prefix-reuse',window:data.window,splitAt:cut,train:train.length,test:n,
    trainSessions:new Set(train.map(r=>r.session)).size,testSessions:new Set(test.map(r=>r.session)).size,
    bridgeTestRequests:test.filter(r=>r.route.startsWith('magpie/')).length,
    unpriced,purged:obs.rows.length-train.length-test.length,censored:obs.censored,branched:obs.branched,invalid:obs.invalid,
    referenceThreshold:(W1-W5)/(W5-.1),mean,sequential,
    sequentialBest:sequentialBest.requests?sequentialBest.policy:null,deltaVsPooledCI:ci,pooledChoice,conditionalSupported,
    recommendation:conditionalSupported?'Conditional policy is a candidate for a controlled marker-level trial.':`No validated advantage for conditional TTL switching. Best held-out sequential proxy: ${sequentialBest.requests?sequentialBest.policy:'unavailable'}. Verify route control and marker-level economics before changing Cache Goblin.`, 
    calibration:bins.filter(b=>b.n).map(b=>({...b,predicted:b.predicted/b.n,observed:b.observed/b.n})),
    groups:Object.entries(full.groups).map(([condition,g])=>({condition,n:g.n,p:g.p,choiceAtReadRatioPointOne:choice(g.p)})).sort((a,b)=>b.n-a.n),
    pooled:full.pooled,model,scored,
    assumptions:[
      'All probabilities refer to the next compatible lineage request, using request-start times as cache-touch proxies.',
      'Labels: <=5m, (5m,1h], or no compatible access within 1h. Recent right-censored calls and ambiguous forks are excluded.',
      'Features: current route and input cause; previous completed request context band. No current response duration, tool result, or future state is used.',
      '70% chronological training; one-hour purge before test. The same session may span both periods; uncertainty resamples test sessions.',
      'Cold-write objective only: write multipliers come from policies.mjs; read/input ratios come from the model catalog using the prior known context tier. At a 0.1x read price, the threshold is 65.2%; it varies by route.',
      'Each evaluation unit is a hypothetical equal-sized cold prefix, not a claim that every logged request wrote the whole prompt. Scores are input-price units, not account savings.',
      'No repeated-access lifetime optimization, mixed-prefix accounting, warming cost, or exact provider cache-touch evidence. Cache Goblin integration remains a suggested experiment, not an automatic setting change.',
    ]};
}
