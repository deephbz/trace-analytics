// Sequential session-prefix counterfactual. Each policy starts cold at the test
// boundary. Prefix identity is approximated by lineage and observed reuse bounds.
// Segment lifetimes preserve a longer-lived old prefix when a shorter tail is added.
import {POLICIES,actualPolicy} from './policies.mjs';
import {tierRates} from '../rates.mjs';
const prompt=c=>(c.input??0)+(c.cacheRead??0)+(c.cacheWrite??0);
const key=c=>`${c.source}|${c.session}|${c.id}`;

export function replayAdaptive(data,prices,splitAt,decide) {
  const all=new Map(data.calls.map(c=>[key(c),c]));
  const calls=data.calls.filter(c=>c.source==='pi'&&c.purpose==='turn'&&/claude|anthropic/i.test(c.route??'')&&c.t>=splitAt&&c.t<data.window.untilMs).sort((a,b)=>a.t-b.t);
  const results=[];
  for(const policy of ['5m','1h','conditional']){
    const states=new Map();let cost=0,readTokens=0,writeTokens=0,upgrades=0,n=0,unpriced=0;
    const bySession={},byRoute={};
    for(const c of calls){
      const price=prices[c.route];if(!price){unpriced++;continue;}
      const size=prompt(c),rate=tierRates(price,size);
      if(!(rate.input>0)||!Number.isFinite(rate.cacheRead)){unpriced++;continue;}
      const ttl=policy==='conditional'?decide(c):policy;
      const selected=POLICIES.anthropic[ttl];
      const prev=all.get(`${c.source}|${c.session}|${c.prev}`);
      let reuse=prev&&prev.route===c.route&&!c.reset?Math.min(size,prompt(prev)):0;
      const actual=POLICIES.anthropic[actualPolicy(c.route,'anthropic')];
      if(prev&&c.t-prev.t<=actual.ttlSec*1000)reuse=Math.min(reuse,c.cacheRead??0);
      const old=prev&&reuse>0?states.get(key(prev))??[]:[];
      let read=0;const kept=[];
      for(const segment of old){
        if(segment.end<=read)continue;
        if(segment.until<c.t||segment.ttl<selected.ttlSec){if(segment.until>=c.t&&segment.ttl<selected.ttlSec)upgrades++;break;}
        const end=Math.min(segment.end,reuse);if(end<=read)break;
        kept.push({end,ttl:segment.ttl,until:c.t+segment.ttl*1000});read=end;
        if(read>=reuse)break;
      }
      const written=Math.max(0,size-read);
      if(written)kept.push({end:size,ttl:selected.ttlSec,until:c.t+selected.ttlSec*1000});
      states.set(key(c),kept);
      const usd=(read*rate.cacheRead+written*rate.input*selected.write)/1e6;
      cost+=usd;readTokens+=read;writeTokens+=written;n++;
      bySession[c.session]=(bySession[c.session]??0)+usd;
      byRoute[c.route]??={requests:0,inputCost:0};byRoute[c.route].requests++;byRoute[c.route].inputCost+=usd;
    }
    results.push({policy,inputCost:cost,readTokens,writeTokens,upgrades,requests:n,unpriced,bySession,byRoute});
  }
  return {results,notes:[
    'Held-out sequential replay begins with empty caches at the split; all policies share the same boundary.',
    'Cost includes input reads/writes only, at API prices. Output cost is unchanged and omitted. These are not bills.',
    'Lineage and observed reads bound reuse. Exact prefix hashes, capacity eviction, cross-session sharing, and global/project marker sizes are unavailable.',
    'An unexpired longer-lived prefix retains its lifetime when a shorter tail is added. Upgrading a short segment rewrites that suffix at the longer write price.',
    'Each hit refreshes its retained segment. Touch times use request starts. Native warmer requests and costs are not replayed.',
    'This is a session-prefix proxy, not a validated mixed-marker Cache Goblin simulator. Route retention overrides may prevent a suggested policy from taking effect.',
  ]};
}
