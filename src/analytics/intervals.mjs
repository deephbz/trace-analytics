// Session-local elapsed accounting. Parallel intervals count once; concurrent
// sessions remain separate. Tool waits are response-to-result proxies, not CPU time.
import { quantile } from './stats.mjs';

export const PHASES = ['model', 'compaction', 'tool', 'awaitUser', 'harness', 'unclassified'];

/** Partition [start,end) by priority. Overlap is disclosed, never added twice. */
export function partition(spans, start, end) {
  const events = [[start, null, 0], [end, null, 0]];
  for (const {phase, from, to} of spans) {
    const a=Math.max(start,from),b=Math.min(end,to);
    if (Number.isFinite(a)&&Number.isFinite(b)&&b>a) events.push([a,phase,1],[b,phase,-1]);
  }
  events.sort((a,b)=>a[0]-b[0]);
  const active=Object.fromEntries(PHASES.map(p=>[p,0]));
  const ms=Object.fromEntries(PHASES.map(p=>[p,0]));
  let last=start,overlapMs=0;
  for(const [t,phase,delta] of events){
    const present=PHASES.filter(p=>active[p]>0);
    ms[present[0]??'unclassified']+=t-last;
    if(present.length>1)overlapMs+=t-last;
    if(phase)active[phase]+=delta;
    last=t;
  }
  return {ms,overlapMs};
}

export function analyzeIntervals({window,calls,tools=[],compactions=[],coverage},ctx={}) {
  const sessions=new Map(), byId=new Map();
  const session=(s)=>{if(!sessions.has(s))sessions.set(s,{spans:[],bounds:[]});return sessions.get(s);};
  const supported=c=>c.source==='pi'||c.source==='codex';
  const sessionKey=c=>`${c.source}|${c.session}`;
  const observed=(s,phase,from,to)=>{
    if(!Number.isFinite(from)||!Number.isFinite(to)||to<from||to<=window.sinceMs||from>=window.untilMs)return;
    const item=session(s);item.spans.push({phase,from,to});item.bounds.push(Math.max(from,window.sinceMs),Math.min(to,window.untilMs));
  };
  for(const c of calls)if(supported(c))byId.set(`${sessionKey(c)}|${c.id}`,c);
  let missingCallTiming=0;
  for(const c of calls){
    if(!supported(c)||c.t>=window.untilMs)continue;
    if(c.end==null){if(c.t>=window.sinceMs&&c.t<window.untilMs)missingCallTiming++;continue;}
    observed(sessionKey(c),'model',c.t,c.end);
    const p=byId.get(`${sessionKey(c)}|${c.prev}`);
    if(p?.end!=null && c.cause==='user' && c.inputAt!=null && c.inputAt>=p.end && c.inputAt<=c.t){
      observed(sessionKey(c),'awaitUser',p.end,c.inputAt);
      observed(sessionKey(c),'harness',c.inputAt,c.t);
    }
  }
  const outcomes={};let unknownToolTiming=0;
  for(const tool of tools){
    if(!supported(tool)||tool.end<window.sinceMs||tool.end>=window.untilMs)continue;
    if(tool.duration!=null)observed(sessionKey(tool),'tool',tool.t,tool.end);else unknownToolTiming++;
    const kind=['bash','shell'].includes(tool.name)?tool.name:'other';
    const key=`${tool.source}:${kind}:${tool.timing}:${tool.outcome}`;
    const entry=outcomes[key]??={source:tool.source,kind,timing:tool.timing,outcome:tool.outcome,n:0,durations:[]};
    entry.n++;if(tool.duration!=null)entry.durations.push(tool.duration);
  }
  for(const c of compactions)if(supported(c)&&c.wall!=null)observed(sessionKey(c),'compaction',c.t-c.wall,c.t);
  const totals=Object.fromEntries(PHASES.map(p=>[p,0]));const rows=[];let overlapMs=0;
  for(const [id,item]of sessions){
    const from=Math.min(...item.bounds),to=Math.max(...item.bounds);
    const part=partition(item.spans,from,to);
    for(const p of PHASES)totals[p]+=part.ms[p];overlapMs+=part.overlapMs;
    rows.push({session:id,from,to,...part});
  }
  const totalMs=Object.values(totals).reduce((a,b)=>a+b,0);
  return {kind:'trace-analytics/intervals',window,codeVersion:ctx.codeVersion,scope:'Pi and Codex session-local elapsed coverage',
    totalMs,totals,bySource:['pi','codex'].map(source=>({source,sessions:rows.filter(r=>r.session.startsWith(source+'|')).length,totals:Object.fromEntries(PHASES.map(p=>[p,rows.filter(r=>r.session.startsWith(source+'|')).reduce((s,r)=>s+r.ms[p],0)]))})),overlapMs,sessions:rows.length,missingCallTiming,unknownToolTiming,coverage,
    outcomes:Object.values(outcomes).map(({durations,...r})=>({...r,timed:durations.length,
      sumProxyMs:durations.reduce((a,b)=>a+b,0),p50Ms:quantile(durations,.5),p90Ms:quantile(durations,.9)})),
    rows,notes:[
      'Pi tool waiting uses response-end to result proxies; Codex uses tool item start/end events. Neither is CPU time; parallel tools can overlap.',
      'Elapsed totals partition each observed session envelope. They are not operator wall-clock time or a sum of CPU execution times.',
      'Await-user is a logged user-input gap proxy, not proof of human inactivity. Other gaps remain unclassified.',
      'No idle tail is invented after the last observed event. Missing timing is not zero.',
      'Timeout classification requires an explicit timeout status or wrapper message. A signal exit alone remains a failure; timeout counts are lower bounds when the source omits the reason.',
      'Outcome-table duration sums are per-tool proxies and can overlap; use the phase partition for elapsed totals.',
    ]};
}
