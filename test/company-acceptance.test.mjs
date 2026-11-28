import assert from 'node:assert/strict';
import {fork,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'node:test';

async function server(dataDir,offset=0) {
  const child=fork(new URL('./support/company-acceptance-process.mjs',import.meta.url),[dataDir,String(offset)],{
    execArgv:[],stdio:['ignore','pipe','pipe','ipc'],
    env:{...process.env,PEROTTINO_AGENT_MODE:'local',PEROTTINO_MAIL_DOMAIN:'company.invalid',PEROTTINO_EMPLOYEE_LIMIT:'4'}
  });
  const exit=once(child,'exit'),steps=[],messages=[];
  let output='',fatal,origin,closing;
  for (const pipe of [child.stdout,child.stderr]) pipe.on('data',chunk=>{output=(output+chunk).slice(-3000);});
  child.on('message',m=>{
    if (m.origin) origin=m.origin;
    if (m.step) {steps.push(m.step);if(steps.length>12)steps.shift();}
    if (m.received) messages.push(m.received);
    if (m.failure) fatal=m.failure;
  });
  async function until(read,label) {
    const deadline=Date.now()+45_000;
    while(Date.now()<deadline) {
      if(fatal || child.exitCode!==null || child.signalCode) break;
      const value=await read();
      if(value) return value;
      await delay(100);
    }
    assert.fail(label+'; '+(fatal ?? output)+'; recent decisions '+JSON.stringify(steps));
  }
  async function close() {
    if(child.exitCode!==null || child.signalCode) return;
    if(!closing) {
      child.send({close:true});
      const timer=setTimeout(()=>child.kill(),5000);
      closing=exit.finally(()=>clearTimeout(timer));
    }
    await closing;
  }
  try {await until(()=>origin,'Local app startup');}
  catch(error){await close();throw error;}
  async function api(op,input={}) {
    const response=await fetch(origin+'/api/company/'+op,{method:'POST',headers:{
      authorization:'Basic '+Buffer.from('owner:acceptance-owner').toString('base64'),origin,'content-type':'application/json'},
      body:JSON.stringify(input)});
    const result=await response.json();
    assert.equal(response.status,200,op+' '+JSON.stringify(result));
    return result;
  }
  async function email(input) {
    child.send(input);
    assert.deepEqual(await until(()=>messages.shift(),'Email ingress'),{delivered:1,ignored:0});
  }
  async function completion(number) {
    return until(async()=>{
      const {threads}=await api('mail.list');
      const thread=threads.find(t=>t.contact==='founder@example.invalid');
      if(!thread) return;
      const {messages}=await api('mail.get',{threadId:thread.id});
      const reply=messages.find(m=>m.direction==='outbound' && m.status==='sent' && m.inReplyTo==='<brief-'+number+'@example.invalid>' && m.text.startsWith('The app is ready.'));
      if(reply) return {thread,messages,reply};
    },'Owner completion notice #'+number);
  }
  return {api,email,completion,close,pid:child.pid,until};
}

test('founder email funds and delegates a tested preview, then a fresh company maintains it a week later',
  {skip:process.env.PEROTTINO_DELIVERY_E2E!=='1',timeout:150_000},async t=>{
    const dataDir=await mkdtemp(join(tmpdir(),'company-delivery-acceptance-'));
    let app;
    t.after(async()=>{await app?.close();await rm(dataDir,{recursive:true,force:true});});
    app=await server(dataDir);
    const firstPid=app.pid;
    assert.equal((await app.api('directory')).agents.length,1);
    await app.api('policy.set',{requestId:'founder-policy',totalBudgetCents:20,allowCeoPromotions:true,maxDirectReports:3,maxAllocationCents:20});
    const brief={number:1,text:'Build a small public reference app showing the ISO country codes for Canada and the United States.'};
    await app.email(brief); await app.email(brief);
    const first=await app.completion(1);
    const {agents}=await app.api('directory');
    assert.equal(agents.length,2);
    const engineer=agents.find(p=>p.role==='Engineer');
    assert.equal(engineer.managerId,'ceo');
    const initial=await app.api('company.overview');
    const initialTask=initial.tasks.find(t=>t.assigneeId===engineer.id);
    assert.equal(initialTask.status,'done');
    const {projects:[project]}=await app.api('project.list');
    const v1=project.latestHandoff;
    const firstStatus=await app.api('delivery.status',{projectId:project.id,taskId:initialTask.id,commitSha:v1.sha});
    const firstUrl=firstStatus.preview.url;
    assert.ok(first.reply.text.includes(firstUrl));
    assert.equal(first.messages.filter(m=>m.direction==='inbound').length,1);
    assert.equal(firstStatus.build.testsPassed,1);
    assert.equal(v1.pr.local,true);
    assert.equal(v1.pr.url,null);
    const git=(...args)=>execFileSync('git',['--git-dir',join(dataDir,'projects.git'),...args],{encoding:'utf8'}).trim();
    assert.equal(git('rev-parse','refs/perottino/reviews/'+v1.jobId),v1.sha);
    assert.equal(git('rev-parse','refs/heads/'+v1.branch),v1.sha);
    assert.ok((await (await fetch(firstUrl)).text()).includes('CA, US'));
    const internal=(await app.api('mail.list')).threads.find(thread=>thread.subject==='Country data handoff');
    const forwarded=(await app.api('mail.get',{threadId:internal.id})).messages.find(m=>m.direction==='internal');
    assert.equal(forwarded.from,engineer.handle+'@company.invalid');
    assert.equal(forwarded.to,'mara@company.invalid');
    await app.close();
    app=await server(dataDir,7*24*60*60*1000);
    assert.notEqual(app.pid,firstPid);
    await app.until(async()=>{try {return (await fetch(firstUrl)).status===404;} catch {return false;}},'Week-old preview expires');
    const change={number:2,reference:'<capture-'+first.reply.id+'@email.amazonses.com>',text:'Add the region to each existing country code on the same app.'};
    await app.email(change);
    const second=await app.completion(2);
    assert.equal(second.thread.id,first.thread.id);
    assert.equal(second.messages.filter(m=>m.direction==='inbound').length,2);
    assert.ok(Date.parse(second.reply.createdAt)-Date.parse(first.reply.createdAt)>=7*86400_000);
    const current=(await app.api('project.get',{projectId:project.id})).project;
    const v2=current.latestHandoff;
    assert.deepEqual([v1.agentId,v2.agentId],[engineer.id,engineer.id]);
    assert.equal(v2.baseSha,v1.sha);
    assert.notEqual(v1.taskId,v2.taskId);assert.notEqual(v1.pr.number,v2.pr.number);
    assert.equal(git('rev-parse',v2.sha+'^'),v1.sha);
    assert.equal(git('rev-parse','refs/perottino/reviews/'+v2.jobId),v2.sha);
    assert.equal(git('show',v2.sha+':'+project.path+'/README.md'),'Public reference sample from ISO 3166-1.');
    const status=await app.api('delivery.status',{projectId:project.id,taskId:v2.taskId,commitSha:v2.sha});
    assert.ok(second.reply.text.includes(status.preview.url));
    assert.equal(status.build.testsPassed,1);
    const preview=await fetch(status.preview.url);
    assert.equal(preview.status,200);assert.match(await preview.text(),/CA \/ Americas, US \/ Americas/);
    const {versions}=await app.api('files.versions',{path:'projects/country-sample/release.json'});
    assert.deepEqual(versions.map(v=>v.version).sort(),[1,2]);
    assert.equal((await app.api('knowledge.list',{projectId:project.id})).memories.length,1);
    assert.equal((await app.api('governance.get',{employeeId:engineer.id})).budget.spentCents,2);
    const goals=(await app.api('goal.list')).goals;
    assert.equal(goals.length,2);assert.ok(goals.every(g=>g.status==='done'));
    t.diagnostic('Two verified deliveries, two captured founder replies, and two one-cent build charges in the test ledger. '+
      'The first and second real local Git review refs ended at '+v1.sha.slice(0,12)+' and '+v2.sha.slice(0,12)+'.');
});
