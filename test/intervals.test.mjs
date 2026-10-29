import "./home.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import {partition,analyzeIntervals} from '../src/analytics/intervals.mjs';
import {pi,toolOutcome} from '../src/sources/pi.mjs';
import {codex} from '../src/sources/codex.mjs';

test('overlapping tools and model spans partition elapsed time once',()=>{
 const r=partition([{phase:'model',from:0,to:10},{phase:'tool',from:10,to:30},{phase:'tool',from:15,to:40},{phase:'model',from:35,to:45}],0,50);
 assert.deepEqual(r.ms,{model:20,compaction:0,tool:25,awaitUser:0,harness:0,unclassified:5});
 assert.equal(r.overlapMs,5);
 assert.equal(Object.values(r.ms).reduce((a,b)=>a+b,0),50);
});

test('tool status distinguishes timeout, cancellation, exit failure, and unknown',()=>{
 for(const [text,expected]of [['Command timed out after 30 seconds','timeout'],['Command aborted','cancelled'],['Command exited with code 2','failure'],['Process exited with code 0','success'],['some output','unknown']])assert.equal(toolOutcome({content:text}),expected);
 assert.equal(toolOutcome({isError:false,content:'some output'}),'success');
 assert.equal(toolOutcome({isError:true,content:'timeout is documented here, not a terminal event'}),'failure');
});

test('Pi retains proxy anchors and input time without tool content or arguments',()=>{
 const st=pi.init('synthetic.jsonl'),out=[];
 const send=d=>{const b=Buffer.from(JSON.stringify(d));pi.line(st,b,0,b.length,r=>out.push(r));};
 send({type:'message',id:'u',parentId:null,timestamp:new Date(1000).toISOString(),message:{role:'user',content:'synthetic'}});
 send({type:'message',id:'a',parentId:'u',timestamp:new Date(3000).toISOString(),message:{role:'assistant',timestamp:2000,provider:'p',model:'claude-test',usage:{input:10,output:10},content:[{type:'toolCall',id:'tc',name:'bash',arguments:{command:'never retained',timeout:60}}]}});
 send({type:'message',id:'r',parentId:'a',timestamp:new Date(9000).toISOString(),message:{role:'toolResult',toolCallId:'tc',toolName:'bash',isError:true,content:[{type:'text',text:'Command timed out after 60 seconds'}]}});
 const tool=out.find(r=>r.kind==='tool');assert.equal(tool.duration,6000);assert.equal(tool.outcome,'timeout');assert.equal(tool.timing,'response-to-result-proxy');
 assert.equal(out.find(r=>r.kind==='call').inputAt,1000);
 assert.ok(!JSON.stringify(tool).includes('never retained'));
});

test('Codex tool items retain observed execution events and explicit exit status',()=>{
 const st=codex.init('synthetic.jsonl'),out=[];
 const b=Buffer.from(JSON.stringify({timestamp:new Date(8000).toISOString(),type:'event_msg',payload:{type:'item_completed',item:{type:'CommandExecution',id:'t',command:'not retained',stdout:'not retained',status:'failed',exit_code:143},started_at_ms:2000,completed_at_ms:8000}}));
 codex.line(st,b,0,b.length,r=>out.push(r));
 assert.equal(out.length,1);assert.equal(out[0].timing,'execution-events');assert.equal(out[0].duration,6000);assert.equal(out[0].outcome,'failure');
 assert.ok(!JSON.stringify(out).includes('not retained')); // exit 143 alone does not prove timeout
});

test('Codex preserves task-input anchors without carrying them into later tool turns',()=>{
 const st=codex.init('synthetic.jsonl'),out=[];
 const send=(t,type,payload)=>{const b=Buffer.from(JSON.stringify({timestamp:new Date(t).toISOString(),type,payload}));codex.line(st,b,0,b.length,r=>out.push(r));};
 send(100,'turn_context',{model:'synthetic'});
 send(1000,'event_msg',{type:'task_started'});
 send(2000,'event_msg',{type:'item_completed',item:{type:'AgentMessage',id:'a'},started_at_ms:1500,completed_at_ms:2000});
 send(2100,'token_usage_record',{response_id:'r',usage:{input_tokens:100,output_tokens:10}});
 const c=out.find(r=>r.kind==='call');assert.equal(c.inputAt,1000);assert.equal(st.userInputAt,null);
});

test('session envelopes do not invent idle tails; user-input gaps remain proxies',()=>{
 const r=analyzeIntervals({window:{sinceMs:0,untilMs:1000},calls:[
  {source:'pi',session:'s',id:'a',t:0,end:10},
  {source:'pi',session:'s',id:'b',prev:'a',t:50,end:60,cause:'user',inputAt:40},
  {source:'pi',session:'s',id:'c',t:70,end:null},
  {source:'pi',session:'s',id:'future',prev:'b',t:1100,end:1200,cause:'user',inputAt:1050},
 ],tools:[{source:'pi',session:'s',id:'t',t:10,end:30,duration:20,name:'bash',outcome:'success'}]});
 assert.equal(r.totalMs,60);assert.equal(r.totals.model,20);assert.equal(r.totals.tool,20);assert.equal(r.totals.awaitUser,10);assert.equal(r.totals.harness,10);assert.equal(r.missingCallTiming,1);
});
