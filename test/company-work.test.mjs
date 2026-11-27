import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createWork } from '../src/company-work.mjs';
import { notificationRow } from '../src/company-notifications.mjs';
import { createConversations } from '../src/conversations.mjs';
import { makeSqliteRecords } from '../src/foundation-records.mjs';
import { createTelemetry } from '../src/telemetry.mjs';

const employees = [
  ['ceo',null],['lead','ceo'],['engineer','lead'],['designer','lead'],['sales','ceo'],['alumni','lead'],
].map(([id,managerId])=>({id,managerId,canHire:id === 'ceo',desiredState:id === 'alumni' ? 'fired' : 'active'}));
const employee = async id => employees.find(person=>person.id === id);
const event = (kind,metadata,id) => [{pk:'test:audit',sk:id,expect:null,value:{kind,...metadata}}];
const request = (extra={}) => ({requestId:randomUUID(),...extra});
const rejects = (call,code) => assert.rejects(call,{status:code});
function fixture(t) {
  const records = makeSqliteRecords({filename:':memory:'});
  t.after(()=>records.close());
  let time = 1_000_000;
  const {execute} = createWork({records,employee,event,now:()=>time,leaseMs:1000});
  const goal = async (id='lead') => (await execute('owner','goal.create',request({
    accountableId:id,outcome:'Deliver the release',successCriteria:'The acceptance test passes',
  }))).goal;
  const task = async (goalId,assigneeId,more={}) => (await execute('lead','task.create',request({
    goalId,assigneeId,title:'Run the test',acceptance:'Attach the passing test report',...more,
  }))).task;
  return {records,execute,goal,task,advance:ms=>{time+=ms;},now:()=>time};
}

test('explicit goals and tasks follow reporting lines independently of hiring authority',async t=>{
  const {execute,goal,task} = fixture(t);
  const spec = request({accountableId:'engineer',outcome:'Verify new code',successCriteria:'Report passing checks'});
  const created = await execute('lead','goal.create',spec);
  assert.equal(created.goal.accountableId,'engineer');
  assert.deepEqual(await execute('lead','goal.create',spec),created);
  await rejects(execute('lead','goal.create',{...spec,outcome:'Different outcome'}),409);
  await rejects(execute('designer','goal.create',request({...spec,accountableId:'engineer'})),403);
  await rejects(execute('engineer','goal.create',request({...spec,accountableId:'engineer'})),403);
  const g = await goal();
  await rejects(execute('owner','goal.close',request({goalId:g.id})),409);
  await rejects(task(g.id,'sales'),403);
  const assigned = await task(g.id,'engineer');
  await rejects(execute('sales','task.get',{taskId:assigned.id}),403);
  await rejects(execute('sales','task.history',{taskId:assigned.id}),403);
  await rejects(execute('sales','goal.get',{goalId:g.id}),403);
  await rejects(execute('alumni','goal.list',{}),404);
  assert.equal((await execute('engineer','goal.get',{goalId:g.id})).goal.id,g.id);
  const personal = await execute('engineer','task.create',request({goalId:g.id,assigneeId:'engineer',title:'Reproduce',acceptance:'Verified'}));
  assert.equal(personal.task.createdBy,'engineer');
  await rejects(execute('engineer','task.create',request({goalId:g.id,assigneeId:'designer',title:'Unrelated',acceptance:'Verified'})),403);
  assert.equal((await execute('engineer','task.list',{goalId:g.id})).tasks.length,2);
  await task(g.id,'designer');
  assert.equal((await execute('engineer','task.list',{goalId:g.id})).tasks.length,2);
});

test('concurrent planners and workers are fenced; expired workers cannot publish',async t=>{
  const f = fixture(t), g = await f.goal();
  assert.deepEqual((await f.execute('lead','goal.list',{accountableId:'lead',unplanned:true})).goals.map(x=>x.id),[g.id]);
  const contenders = await Promise.allSettled([f.task(g.id,'engineer',{ifUnplanned:true}),f.task(g.id,'engineer',{ifUnplanned:true})]);
  assert.equal(contenders.filter(r=>r.status==='fulfilled').length,1);
  const work = contenders.find(r=>r.status==='fulfilled').value;
  assert.equal((await f.execute('lead','goal.list',{accountableId:'lead',unplanned:true})).goals.length,0);
  const own = (op,params)=>f.execute('engineer','task.'+op,request({taskId:work.id,...params}));
  const claimRequest = request({taskId:work.id});
  const [first,replayed] = await Promise.all([own('claim',claimRequest),own('claim',claimRequest)]);
  assert.deepEqual(replayed,first);
  await rejects(own('claim',{}),409);
  assert.equal((await f.execute('engineer','task.list',{available:true})).tasks.length,0);
  f.advance(1000);
  assert.equal((await f.execute('engineer','task.list',{available:true})).tasks.length,1);
  const fresh = await own('claim',{});
  assert.notEqual(first.claimToken,fresh.claimToken);
  assert.equal(fresh.task.attempt,2);
  assert.equal(fresh.task.workStep,first.task.workStep);
  await rejects(own('progress',{claimToken:first.claimToken,note:'stale'}),409);
  const current = await own('progress',{claimToken:fresh.claimToken,note:'New checkpoint',release:true});
  assert.equal(current.task.workStep,1);
  for (const op of ['task.get','task.history']) {
    const output=JSON.stringify(await f.execute('owner',op,{taskId:work.id}));
    assert.ok(!output.includes(fresh.claimToken) && !output.includes('claimDigest') && !output.includes('claimToken'));
  }
  const claim = await own('claim',{});
  await own('wait',{claimToken:claim.claimToken,note:'Awaiting response',wakeAt:f.now()+500});
  assert.equal((await f.execute('engineer','task.list',{available:true})).tasks.length,0);
  f.advance(500);
  assert.equal((await f.execute('engineer','task.list',{available:true})).tasks.length,1);
  const again = await own('claim',{});
  await own('block',{claimToken:again.claimToken,note:'Needs access'});
  await rejects(own('claim',{}),409);
  await f.execute('lead','task.resume',request({taskId:work.id}));
  assert.equal((await own('claim',{})).task.status,'running');
});

test('evidence and independent review gate completion, dependencies, and atomic goal closure',async t=>{
  const {execute,goal,task,records} = fixture(t), g=await goal();
  const a=await task(g.id,'engineer'), b=await task(g.id,'designer',{dependencies:[a.id]});
  const claim = async (actor,id) => (await execute(actor,'task.claim',request({taskId:id}))).claimToken;
  const act = (actor,op,id,params={})=>execute(actor,'task.'+op,request({taskId:id,...params}));
  await rejects(claim('designer',b.id),409);
  assert.equal((await execute('designer','task.list',{available:true})).tasks.length,0);
  let token=await claim('engineer',a.id);
  await rejects(act('engineer','submit',a.id,{claimToken:token,evidence:[]}),400);
  await act('engineer','submit',a.id,{claimToken:token,evidence:['s3://example/artifact-1']});
  await rejects(act('engineer','review',a.id,{decision:'accept',note:'Self-approval'}),403);
  await rejects(act('sales','review',a.id,{decision:'accept',note:'Peer approval'}),403);
  assert.equal((await execute('lead','task.list',{reviewerId:'lead',status:'submitted',limit:1})).tasks[0].id,a.id);
  await act('lead','review',a.id,{decision:'changes',note:'Attach the test output'});
  token=await claim('engineer',a.id);
  await act('engineer','submit',a.id,{claimToken:token,evidence:['s3://example/artifact-2']});
  await act('lead','review',a.id,{decision:'accept',note:'Test output matches'});
  assert.equal((await execute('designer','task.list',{available:true})).tasks[0].id,b.id);
  token=await claim('designer',b.id);
  await act('designer','submit',b.id,{claimToken:token,evidence:['s3://example/preview']});
  await rejects(execute('lead','goal.close',request({goalId:g.id})),409);
  const reviewRequest=request({taskId:b.id,decision:'accept',note:'Reviewed preview'});
  await Promise.all([execute('lead','task.review',reviewRequest),execute('lead','task.review',reviewRequest)]);
  assert.deepEqual((await execute('lead','goal.list',{accountableId:'lead',closable:true})).goals.map(x=>x.id),[g.id]);
  const history=(await execute('owner','task.history',{taskId:a.id})).entries;
  assert.deepEqual(history.filter(e=>e.kind==='task.submitted').map(e=>e.evidence),[['s3://example/artifact-1'],['s3://example/artifact-2']]);
  assert.deepEqual(history.filter(e=>e.kind==='task.reviewed').map(e=>e.decision),['changes','accept']);
  const closure=request({goalId:g.id});
  const [closed,duplicate]=await Promise.all([execute('lead','goal.close',closure),execute('lead','goal.close',closure)]);
  assert.equal(closed.goal.status,'done');assert.equal(closed.goal.openTaskCount,0);assert.deepEqual(duplicate,closed);
  assert.equal((await execute('lead','goal.list',{accountableId:'lead',closable:true})).goals.length,0);
  await rejects(task(g.id,'engineer'),409);
  const events=(await records.list('test:audit')).items;
  assert.equal(events.filter(e=>e.kind==='goal.closed').length,1);
  assert.ok(!JSON.stringify(events).includes('s3://') && !JSON.stringify(events).includes('Test output'));
});

test('work survives reopening the database; list cursors and claim retries remain deterministic',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'company-work-')); t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=join(dir,'work.db');
  const open=()=>{ const records=makeSqliteRecords({filename:file}); return {records,...createWork({records,employee,event})}; };
  const first=open();
  const spec=request({accountableId:'engineer',outcome:'Produce a report',successCriteria:'Two checks pass'});
  const {goal}=await first.execute('owner','goal.create',spec);
  const seed=title=>request({goalId:goal.id,assigneeId:'engineer',title,acceptance:'Verified'});
  const {task}=await first.execute('engineer','task.create',seed('First'));
  await first.execute('engineer','task.create',seed('Second'));
  const claim=request({taskId:task.id});
  const acquired=await first.execute('engineer','task.claim',claim);
  first.records.close();
  const second=open(); t.after(()=>second.records.close());
  assert.deepEqual(await second.execute('engineer','task.claim',claim),acquired);
  const one=await second.execute('owner','task.list',{goalId:goal.id,limit:1});
  const two=await second.execute('owner','task.list',{goalId:goal.id,limit:1,after:one.next});
  assert.notEqual(one.tasks[0].id,two.tasks[0].id);assert.equal(two.next,undefined);
});

test('a released task rotates behind other ready work for the same assignee',async t=>{
  const f=fixture(t), g=await f.goal();
  const first=await f.task(g.id,'engineer');
  f.advance(10);
  const second=await f.task(g.id,'engineer');
  const next=async ()=>(await f.execute('engineer','task.list',{available:true,limit:1})).tasks[0].id;
  assert.equal(await next(),first.id);
  const {claimToken}=await f.execute('engineer','task.claim',request({taskId:first.id}));
  f.advance(10);
  await f.execute('engineer','task.progress',request({taskId:first.id,claimToken,note:'Validated the schema',release:true}));
  assert.equal(await next(),second.id);
});

test('trusted spans follow the work through delegation, submission and closure independently of visible history',async t=>{
  const records=makeSqliteRecords({filename:':memory:'}); t.after(()=>records.close());
  const telemetry=createTelemetry({mode:'test',write:()=>{},exporter:{
    export(spans,callback){callback({code:0});},async shutdown(){},
  }});
  t.after(()=>telemetry.shutdown());
  const {execute}=createWork({records,employee,currentTrace:telemetry.traceCarrier});
  const forged={traceparent:'00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01'};
  const spec=request({accountableId:'lead',outcome:'Secure work',successCriteria:'Report is signed',traceContext:forged});
  let origin,submission,approved;
  const created=await telemetry.withSpan('company.command',{},async ()=>{
    origin=telemetry.traceCarrier(); return execute('owner','goal.create',spec);
  });
  const goalId=created.goal.id;
  const queue=async(op,actor,input,field)=>(await execute(actor,op,input))[field][0];
  assert.deepEqual((await queue('goal.list','lead',{unplanned:true},'goals')).traceContext,origin);
  const {task}=await execute('lead','task.create',request({goalId,assigneeId:'engineer',title:'Sign report',acceptance:'Valid signature',traceparent:forged.traceparent}));
  const claimSpec=request({taskId:task.id});
  const claim=await execute('engineer','task.claim',claimSpec);
  assert.deepEqual(claim.task.traceContext,origin);
  await telemetry.withSpan('company.command',{},async ()=>{
    submission=telemetry.traceCarrier();
    await execute('engineer','task.submit',request({taskId:task.id,claimToken:claim.claimToken,evidence:['Verified signature']}));
  },{links:[origin]});
  assert.deepEqual((await queue('task.list','lead',{reviewerId:'lead'},'tasks')).traceContext,submission);
  await telemetry.withSpan('company.command',{},async ()=>{
    approved=telemetry.traceCarrier();
    await execute('lead','task.review',request({taskId:task.id,decision:'accept',note:'Verified'}));
  },{links:[submission]});
  assert.deepEqual((await queue('goal.list','lead',{closable:true},'goals')).traceContext,approved);
  assert.deepEqual(await execute('engineer','task.claim',claimSpec),claim);
  assert.deepEqual(await execute('owner','goal.create',spec),created);
  for(const result of [created,task,await execute('owner','task.get',{taskId:task.id}),await execute('owner','task.history',{taskId:task.id})]) {
    assert.ok(!JSON.stringify(result).includes('traceparent'));
  }
  const audit=(await records.list('work-events')).items;
  assert.ok(audit.some(row=>row.kind==='task.reviewed'&&row.taskId===task.id));
  assert.ok(!JSON.stringify(audit).includes('Verified signature'));
});

test('goal closure queues one private source notification atomically; both creator and accountable must have source access',async t=>{
  const records=makeSqliteRecords({filename:':memory:'});
  t.after(()=>records.close());
  const chat=createConversations({records,employee});
  const {conversation}=await chat.execute('owner','conversations.dm',{peerId:'ceo'});
  const {message}=await chat.execute('owner','messages.post',request({conversationId:conversation.id,text:'Please prepare a report.',responders:[]}));
  const source={conversationId:conversation.id,messageId:message.id};
  const canReadSource=async(actor,ref)=>{
    try { await chat.execute(actor,'messages.get',ref); return true; }
    catch(error) { if ([403,404].includes(error.status)) return false; throw error; }
  };
  const {execute}=createWork({records,employee,canReadSource});
  const spec={outcome:'Prepare a report',successCriteria:'Deliver the accepted result',accountableId:'ceo',source};
  await rejects(execute('ceo','goal.create',request({...spec,source:{...source,messageId:'m-'+'0'.repeat(40)}})),404);
  await rejects(execute('lead','goal.create',request({...spec,accountableId:'engineer'})),404);
  await rejects(execute('owner','goal.create',request({...spec,accountableId:'engineer'})),404);
  const {goal}=await execute('owner','goal.create',request(spec));
  const {task}=await execute('ceo','task.create',request({goalId:goal.id,assigneeId:'engineer',title:'Find the independent data',acceptance:'Data provided'}));
  const {claimToken}=await execute('engineer','task.claim',request({taskId:task.id}));
  await execute('engineer','task.submit',request({taskId:task.id,claimToken,evidence:['Sensitive individual data']}));
  const notification=notificationRow({...goal,closedBy:'ceo',source,status:'done'});
  assert.equal(await records.get(notification.pk,notification.sk),null);
  await rejects(execute('ceo','goal.close',request({goalId:goal.id})),409);
  assert.equal(await records.get(notification.pk,notification.sk),null);
  await execute('ceo','task.review',request({taskId:task.id,decision:'accept',note:'Reviewed'}));
  const ready=(await execute('ceo','goal.list',{closable:true})).goals[0];
  const close=request({goalId:goal.id});
  const [result,replay]=await Promise.all([execute('ceo','goal.close',close),execute('ceo','goal.close',close)]);
  assert.deepEqual(result,replay);
  for(const view of [goal,task,ready,result,await execute('owner','goal.get',{goalId:goal.id}),await execute('engineer','goal.get',{goalId:goal.id})]) {
    assert.ok(!JSON.stringify(view).includes(source.messageId));
  }
  const queued=await records.get(notification.pk,notification.sk);
  assert.ok(queued);
  assert.ok(!JSON.stringify(queued).includes('Sensitive individual data'));
  assert.ok(!JSON.stringify((await records.list('work-events')).items).includes(source.messageId));
});
