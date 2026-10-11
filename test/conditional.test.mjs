import test from 'node:test';
import assert from 'node:assert/strict';
import {observations,fit,predict,choice,loss,analyzeConditional} from '../src/analytics/cache-ttl/conditional.mjs';
import {replayAdaptive} from '../src/analytics/cache-ttl/adaptive-replay.mjs';
const hour=3600000;
const call=(id,t,extra={})=>({id,t,source:'pi',purpose:'turn',session:'s',route:'anthropic/claude-test',cause:'tool',input:100,cacheRead:1000,...extra});

test('next-access labels respect 5m/1h, resets, forks and right censoring',()=>{
 const data={window:{sinceMs:0,untilMs:4*hour},calls:[call('a',0),call('b',300000,{prev:'a'}),call('c',900000,{prev:'b'}),call('d',hour+900000,{prev:'c',reset:'compaction'}),call('end',4*hour-1000)]};
 const o=observations(data);assert.deepEqual(o.rows.map(r=>r.label),[0,1,2,2]);assert.equal(o.censored,1);
 data.calls.push(call('fork',200000,{prev:'a'}));assert.equal(observations(data).branched,1);
});

test('future response and outcome are not decision features',()=>{
 const data={window:{sinceMs:0,untilMs:3*hour},calls:[call('a',0),call('b',1000,{prev:'a',cause:'user'})]};
 const before=observations(data).rows.map(r=>r.condition);
 data.calls[1].end=hour;data.calls[1].out=999999;data.calls[1].stop='toolUse';
 assert.deepEqual(observations(data).rows.map(r=>r.condition),before);
});

test('sparse conditions shrink and unseen conditions fall back to pooled distribution',()=>{
 const m=fit([{condition:'a',label:0},{condition:'a',label:0},{condition:'b',label:1}]);
 assert.deepEqual(predict(m,{condition:'unknown'}),m.pooled);
 assert.ok(m.groups.b.p[1]<1);assert.ok(m.groups.b.p[1]>m.pooled[1]);
});

test('cold-write decision agrees with enumeration and honors model read price',()=>{
 for(const read of [.025,.05,.1])for(let i=0;i<=100;i++){
   const p=[.1,i/100*.9,.9-i/100*.9];
   const c5=p.reduce((s,x,y)=>s+x*loss('5m',y,read),0),c1=p.reduce((s,x,y)=>s+x*loss('1h',y,read),0);
   assert.equal(choice(p,read),c1<c5?'1h':'5m');
 }
 assert.equal(loss('5m',1),2.5);assert.equal(loss('1h',1),2.1);
});

test('sequential replay charges expiry writes, refreshes hits, and charges upgrades',()=>{
 const price={'anthropic/claude-test':{input:1,cacheRead:.1}};
 const a=call('a',0,{input:1000,cacheRead:0}),b=call('b',360000,{prev:'a',input:0,cacheRead:1000});
 const data={window:{sinceMs:0,untilMs:hour},calls:[a,b]};
 const r=replayAdaptive(data,price,0,c=>c.id==='a'?'5m':'1h');
 assert.equal(r.results[0].inputCost,.0025);assert.equal(r.results[1].inputCost,.0021);
 b.t=240000;
 const q=replayAdaptive(data,price,0,c=>c.id==='a'?'5m':'1h');
 assert.ok(Math.abs(q.results[0].inputCost-.00135)<1e-12);
 assert.equal(q.results[2].upgrades,1);assert.ok(Math.abs(q.results[2].inputCost-.00325)<1e-12);
 data.calls.push(call('c',480000,{prev:'b',input:0,cacheRead:1000}));
 assert.equal(replayAdaptive(data,price,0,()=> '5m').results[0].writeTokens,1000);
});

test('temporal evaluation purges unresolved labels and ignores price-less routes',()=>{
 const calls=[];for(let i=0;i<100;i++)calls.push(call(String(i),i*hour,{session:String(i),cause:i<70?'tool':'user'}));
 const d={window:{sinceMs:0,untilMs:100*hour},calls};
 const r=analyzeConditional(d,{'anthropic/claude-test':{input:2,cacheRead:.2}});
 assert.equal(r.train,70);assert.equal(r.test,30);assert.ok(r.scored.every(s=>s.t>=r.splitAt));assert.equal(r.model.groups['anthropic/claude-test | user | unknown'],undefined);
 const no=analyzeConditional(d,{});assert.equal(no.unpriced,100);assert.equal(no.test,0);assert.equal(no.mean.conditional,null);
});
