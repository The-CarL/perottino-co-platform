import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { createCompanyService } from '../src/company-service.mjs';
import { createLocalProjectGit } from '../src/project-git-local.mjs';
import { createDeployments } from '../src/company-deployments.mjs';
import { handler as executeBuild } from '../src/delivery-executor.mjs';
import { employmentWrites } from '../src/company-governance.mjs';
import { makeSqliteRecords } from '../src/foundation-records.mjs';
import { companyCommand } from '../src/resident.mjs';
import { runCompanyPulse,runCompanyResident } from '../src/company-worker.mjs';
import { capabilitiesFor, useCapability } from '../src/company-capabilities.mjs';
import { checkCompanyDecision } from '../src/company-decisions.mjs';
import { createDecisionServer, requestCompanyDecision } from '../src/agent.mjs';
import { once } from 'node:events';

function fixture(t,adapters = {}) {
  const records = makeSqliteRecords({ filename:':memory:' });
  t.after(() => records.close());
  const staff = new Map([['ceo',{ id:'ceo',handle:'mara',name:'Mara',role:'CEO',desiredState:'active',canHire:true }]]);
  const hires = new Map();
  const service = createCompanyService({ records,adapters,store:{ employee:id => staff.get(id),listEmployees:() => [...staff.values()] },
    async control(actor,op,input,permit) {
      assert.equal(actor,'ceo'); assert.equal(op,'employee.hire');
      if (!hires.has(input.requestId)) {
        const id = 'e-' + (hires.size + 1);
        const person = {id,handle:'kai-'+id,name:'Kai',role:input.role,desiredState:'active',managerId:actor,canHire:false};
        assert.equal(await records.transact(employmentWrites(permit,actor,op,id,input)),true);
        staff.set(id,person); hires.set(input.requestId,person);
      }
      return { employee:hires.get(input.requestId) };
    } });
  const exec = (id,op,input) => service.execute(id,op,input);
  const pulse = (id,decide,options = {}) => runCompanyPulse({ actor:staff.get(id), mode:'local',decide,
    execute:(op,input) => exec(id,op,input), ...options });
  const send = async (text, to='ceo') => {
    const { conversation } = await exec('owner','conversations.dm',{peerId:to});
    await exec('owner','messages.post',{conversationId:conversation.id,text,requestId:randomUUID()});
    return conversation;
  };
  return { pulse,exec,send,staff,hires };
}
const choice = (op,input={}) => ({op,input});

test('conversation decisions survive a lost hire response and persist one delegated task until reviewed', async t => {
  const {pulse,exec,send,hires} = fixture(t);
  const dm = await send('Please investigate the sample dataset and report the number of records.');
  let plannedHires = 0;
  const plan = ctx => {
    assert.equal(ctx.kind,'message');
    if (!ctx.steps.length) return choice('goal.create',{outcome:'Count sample rows',successCriteria:'A cited public result'});
    if (ctx.steps.length === 1) {
      plannedHires++;
      return choice('employee.hire',{role:'Engineer',goalId:ctx.steps[0].result.goal.id,
        title:'Count the sample rows.',acceptance:'Cite the source and row count.'});
    }
    return choice('reply',{text:'Kai is checking the sample and will bring back a count.'});
  };
  let lost = false;
  await assert.rejects(pulse('ceo',plan,{execute:async (op,input) => {
    if (op === 'goal.create') {
      assert.equal(input.source.conversationId,dm.id);
      assert.ok(input.source.messageId.startsWith('m-'));
    }
    const value = await exec('ceo',op,input);
    if (op === 'employee.hire' && !lost) { lost = true; throw new Error('Response lost after committed hire.'); }
    return value;
  }}),/Response lost/);
  assert.equal(await pulse('ceo',plan),'worked');
  assert.equal(plannedHires,1); assert.equal(hires.size,1);
  const engineer = [...hires.values()][0];
  const roster = await exec('owner','company.overview',{});
  assert.equal(roster.goals.length,1); assert.equal(roster.tasks.length,1);
  const taskId = roster.tasks[0].id, goalId = roster.goals[0].id;
  assert.equal(roster.tasks[0].assigneeId,engineer.id);
  const {messages} = await exec('owner','messages.list',{conversationId:dm.id});
  assert.equal(messages.length,2);assert.equal(messages[1].text,'Kai is checking the sample and will bring back a count.');
  assert.equal(await pulse(engineer.id,ctx => {
    assert.equal(ctx.history,undefined); assert.equal(ctx.kind,'task');
    if (!ctx.steps.length) return choice('browse',{url:'https://example.test/sample'});
    assert.match(ctx.steps[0].result.text,/three rows/);
    return choice('task.submit',{note:'The sample contains three rows.',evidence:['https://example.test/sample','Three rows were present.']});
  },{browse:async url => ({url,title:'Sample',text:'The sample contains three rows.'})}),'worked');
  await pulse('ceo',ctx => {
    assert.equal(ctx.kind,'review'); assert.equal(ctx.task.evidence[0],'https://example.test/sample');
    return choice('task.review',{decision:'accept',note:'Count and citation match the criteria.'});
  });
  assert.equal((await exec('owner','task.get',{taskId})).task.status,'done');
  await pulse('ceo',ctx => { assert.equal(ctx.kind,'close'); assert.equal(ctx.results[0].status,'done'); return choice('goal.close'); });
  assert.equal((await exec('owner','goal.get',{goalId})).goal.status,'done');
  assert.equal(await pulse('ceo',() => assert.fail('idle inference')),'idle');
});

test('local commands use the shared runtime; private chat is absent from independent group decisions', async t => {
  const {pulse,exec,send,hires} = fixture(t);
  const dm = await send('remember Private milestone');
  await pulse('ceo'); await send('recall'); await pulse('ceo');
  const saved = await exec('owner','messages.list',{conversationId:dm.id});
  assert.equal(saved.messages.at(-1).text,'Private milestone');
  await send('hire Engineer'); await pulse('ceo');
  const kai = [...hires.values()][0];
  assert.equal(kai.role,'Engineer');
  const { conversation } = await exec('owner','conversations.group',{title:'Project',members:['ceo',kai.id],requestId:randomUUID()});
  await exec('owner','messages.post',{conversationId:conversation.id,text:'What should we measure first?',responders:['ceo'],requestId:randomUUID()});
  await pulse('ceo',ctx => {
    assert.equal(ctx.conversation.id,conversation.id); assert.deepEqual(ctx.history,[]);
    assert.equal(JSON.stringify(ctx).includes('Private milestone'),false);
    return choice('reply',{text:'I would measure the current error rate first.'});
  });
  assert.equal((await exec('owner','messages.list',{conversationId:conversation.id})).messages.at(-1).text,'I would measure the current error rate first.');
  const overview = await exec('owner','company.overview',{});
  assert.equal(overview.tasks.length,0); assert.equal(overview.goals.length,0);
  await send('Ask Kai to check the sample in this private brief.');
  let assignee;
  await pulse('ceo',ctx => ctx.steps.length ? choice('reply',{text:'Kai has the sample-checking goal.'})
    : choice('goal.create',{accountableId:kai.id,outcome:'Check the sample',successCriteria:'Referenced summary'}),{
    execute:(op,input) => {
      if (op === 'goal.create') { assignee=input.accountableId; assert.equal(input.source,undefined); }
      return exec('ceo',op,input);
    },
  });
  assert.equal(assignee,kai.id);
});

test('hosted command wraps business input with the bound identity and propagates broker revocation', async () => {
  const binding = {agentId:'ceo',generation:2,taskArn:'fixture-task'};
  const received = [];
  const execute = companyCommand(binding,{ client:{async send(command) {
    received.push(JSON.parse(command.input.Payload)); return {Payload:Buffer.from('{"ok":false,"status":403,"code":"MANAGER_DENIED"}')};
  }},InvokeCommand:class { constructor(input) { this.input=input; } },functionName:'broker',capability:'fixture' });
  await assert.rejects(execute('directory.self',{}),{code:'MANAGER_DENIED',status:403});
  const [{requestId,...event}] = received;
  assert.match(requestId,/^[\w-]{36}$/);
  assert.deepEqual(event,{operation:'company',callerId:'ceo',generation:2,taskArn:'fixture-task',capability:'fixture',
    command:{op:'directory.self',input:{}}});
});

test('isolated company sidecar authenticates and validates the company decision protocol', async t => {
  const settings = ['PEROTTINO_BEDROCK_WORKER_TOKEN','PEROTTINO_BEDROCK_WORKER_SOCKET','PEROTTINO_BEDROCK_WORKER_URL'];
  const previous = settings.map(key => process.env[key]);
  t.after(() => settings.forEach((key,i) => {
    if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i];
  }));
  delete process.env.PEROTTINO_BEDROCK_WORKER_SOCKET;
  process.env.PEROTTINO_BEDROCK_WORKER_TOKEN = randomUUID();
  const server = createDecisionServer(() => assert.fail('Legacy decision route invoked'), ctx =>
    choice('reply',{text:'I received ' + ctx.message.text}));
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  process.env.PEROTTINO_BEDROCK_WORKER_URL = 'http://127.0.0.1:' + server.address().port;
  const context = {kind:'message',agent:{id:'ceo'},message:{text:'the brief'},allowed:['reply']};
  assert.deepEqual(await requestCompanyDecision(context),choice('reply',{text:'I received the brief'}));
  process.env.PEROTTINO_BEDROCK_WORKER_TOKEN = randomUUID();
  await assert.rejects(requestCompanyDecision(context),/worker could not complete/);
});

test('hosted resident tolerates an unpublished binding only at startup and exits on subsequent revocation', async () => {
  let time = 10_000, polls = 0;
  const waits = [];
  await runCompanyResident({ actor:{id:'ceo'},workerId:'fixture',signal:new AbortController().signal,
    now:() => time,wait:async ms => { waits.push(ms); time += ms; },execute:async op => {
      if (op === 'worker.heartbeat') return {active:true};
      assert.equal(op,'worker.poll');
      if (++polls === 2) return {readyTasks:[],unplanned:[],reviews:[],closable:[]};
      throw Object.assign(new Error('Revoked'),{status:403,code:'MANAGER_DENIED'});
    } });
  assert.equal(polls,3); assert.deepEqual(waits,[2000,30000]);
});

test('a held planning page and a task claimed by another worker do not hide the next available item', async t => {
  const {pulse,exec} = fixture(t);
  const g = (await exec('owner','goal.create',{accountableId:'ceo',outcome:'Find the available work',
    successCriteria:'A first task exists',requestId:randomUUID()})).goal;
  const pages = [];
  const state = await pulse('ceo',ctx => {
    assert.equal(ctx.goal.id,g.id); return choice('task.create',{goalId:g.id,assigneeId:'ceo',title:'Trace work',acceptance:'A record'});
  }, {execute:async (op,input) => {
    if (op === 'worker.poll') {
      pages.push(input);
      if (!input.continuation) return {unplanned:[{id:'held'}],readyTasks:[{id:'taken'}],next:{plan:'page-2'}};
      return {unplanned:[g]};
    }
    if (op === 'task.claim' && input.taskId === 'taken') throw Object.assign(new Error('Already claimed'),{status:409});
    if (op === 'journal.get' && pages.length === 1 && !pages[0].testedHold) {
      pages[0].testedHold = true;return {entry:{steps:[],failures:0,retryAt:Date.now()+60_000}};
    }
    return exec('ceo',op,input);
  }});
  assert.equal(state,'worked'); assert.equal(pages.length,2); assert.deepEqual(pages[1].after,{plan:'page-2'});
});

test('a manager resumes a blocked task and its assignee sees the authenticated clarification on the next pulse',async t=>{
  const {exec,pulse,send,staff}=fixture(t);
  staff.set('ada',{id:'ada',name:'Ada',role:'Engineer',managerId:'ceo',desiredState:'active'});
  const {goal}=await exec('owner','goal.create',{requestId:randomUUID(),accountableId:'ceo',outcome:'Demo',successCriteria:'Working app'});
  const {task}=await exec('ceo','task.create',{requestId:randomUUID(),goalId:goal.id,assigneeId:'ada',title:'Implement',acceptance:'Inspect existing files'});
  await pulse('ada',()=>choice('task.block',{note:'No prior handoff.'}));
  await send('Clarify the original task and resume it.');
  await pulse('ceo',ctx=>ctx.steps.length ? choice('reply',{text:'Resumed the task.'}) :
    choice('task.resume',{taskId:task.id,clarification:'The project is new. Submit the first files.'}));
  await pulse('ada',ctx=>{
    assert.equal(ctx.task.id,task.id);
    assert.equal(ctx.task.acceptance,'Inspect existing files');
    assert.equal(ctx.task.progress,'No prior handoff.');
    assert.equal(ctx.task.clarification.by,'ceo');
    assert.equal(ctx.task.clarification.text,'The project is new. Submit the first files.');
    return choice('task.submit',{note:'Completed the first tree.',evidence:['Example delivery']});
  });
  assert.equal((await exec('owner','task.get',{taskId:task.id})).task.status,'submitted');
});

test('an engineer recovers the existing DM receipt after changes and the reviewer verifies it without resending',async t=>{
  const {pulse,exec,staff}=fixture(t);
  staff.set('ada',{id:'ada',handle:'ada',name:'Ada',role:'Engineer',managerId:'ceo',desiredState:'active'});
  const {goal}=await exec('owner','goal.create',{accountableId:'ceo',outcome:'Verify a handoff',successCriteria:'Verify the existing submission',requestId:'receipt-goal'});
  const {task}=await exec('ceo','task.create',{goalId:goal.id,assigneeId:'ada',title:'Confirm by DM',acceptance:'Send a private marker to Mara.',requestId:'receipt-task'});
  const expectedText='Private handoff marker';
  await pulse('ada',ctx=>ctx.steps.length
    ? choice('task.submit',{note:'Sent the confirmation.',evidence:['Reported a DM.']})
    : choice('dm.send',{peerId:'ceo',text:expectedText,requestReply:false}));
  await pulse('ceo',()=>choice('task.review',{decision:'changes',note:'Supply the original message reference.'}));
  let original;
  await pulse('ada',ctx=>{
    if(!ctx.steps.length)return choice('messages.receipts',{peerId:'ceo',expectedText});
    const result=ctx.steps[0].result;
    assert.equal(result.receipts.length,1);
    const [receipt]=result.receipts;
    assert.equal(receipt.textMatches,true);
    assert.equal(receipt.senderId,'ada');
    assert.equal(receipt.text,undefined);
    original={conversationId:result.conversationId,messageId:receipt.messageId};
    return choice('task.submit',{note:'Verified the posted confirmation.',evidence:[receipt.messageId]});
  });
  await pulse('ceo',ctx=>{
    if(!ctx.steps.length)return choice('messages.receipts',{...original,expectedText});
    assert.equal(ctx.steps[0].result.receipts[0].textMatches,true);
    return choice('task.review',{decision:'accept',note:'Verified the cited receipt.'});
  });
  assert.equal((await exec('owner','task.get',{taskId:task.id})).task.status,'done');
  await assert.rejects(exec('owner','messages.receipts',original),{status:404});
  assert.equal((await exec('ada','messages.list',{conversationId:original.conversationId})).messages.length,1);
});

test('project review tools bind the peer assignment and the submitted work to their respective task IDs',async () => {
  const agent = {id:'peer',managerId:'ceo'};
  const target = {projectId:'p-'+'1'.repeat(32),taskId:'implementation',commitSha:'a'.repeat(40)};
  const note = {decision:'approve',note:'Verified the filter tests against the shipped module.'};
  const actions = [
    choice('project.review',{...target,...note}),
    choice('project.merge',target),
  ];
  for (const action of actions) {
    assert.deepEqual(checkCompanyDecision(action),action);
    assert.throws(() => checkCompanyDecision(choice(action.op,{...action.input,reviewTaskId:'forged'})));

    for (const kind of ['plan','close','mail','message']) {
      assert.ok(!capabilitiesFor({kind,agent,trustedOwner:true,message:{senderId:'owner'}}).includes(action.op));
    }
    const calls = [];
    const call = async (op,input) => { calls.push({op,input}); return {}; };
    const assigned = {ctx:{kind:'task',agent},unit:{task:{id:'peer-review'}},call};
    assert.ok(capabilitiesFor(assigned.ctx).includes(action.op));
    await useCapability(action.op,action.input,assigned);
    assert.deepEqual(calls.pop(),choice(action.op,{...action.input,reviewTaskId:'peer-review'}));

    const designated = {ctx:{kind:'review',agent},unit:{task:{id:target.taskId}},call};
    assert.ok(capabilitiesFor(designated.ctx).includes(action.op));
    const wrongTask = await useCapability(action.op,{...action.input,taskId:'other'},designated);
    assert.ok(wrongTask.error);
    assert.equal(calls.length,0);
    await useCapability(action.op,action.input,designated);
    assert.deepEqual(calls.pop(),action);
  }
  assert.throws(() => checkCompanyDecision(choice('project.review',{...target,...note,decision:'accept'})));
});

test('a peer resident reviews the shipped source and merges a passing project revision through its assigned task',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'resident-peer-review-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const repo=join(directory,'projects.git');
  const {pulse,exec,staff}=fixture(t,{git:createLocalProjectGit({directory:repo}),
    deployments:args=>createDeployments({...args,origin:'http://localhost',execute:executeBuild})});
  for (const [id,role] of [['author','Engineer'],['peer','Reviewer']]) {
    staff.set(id,{id,handle:id,name:id,role,managerId:'ceo',desiredState:'active'});
  }
  await exec('owner','policy.set',{totalBudgetCents:10,maxAllocationCents:10,maxDirectReports:4,allowCeoPromotions:true,requestId:'policy'});
  await exec('owner','budget.allocate',{employeeId:'author',amountCents:2,requestId:'allocate'});
  const {goal}=await exec('owner','goal.create',{accountableId:'ceo',outcome:'Greeting app',successCriteria:'Independently reviewed app on main',requestId:'goal'});
  const assign=async (id,title)=> (await exec('ceo','task.create',{goalId:goal.id,assigneeId:id,title,acceptance:title,requestId:'assign-'+id})).task;
  const authorTask=await assign('author','Publish the tested app');
  const reviewTask=await assign('peer','Inspect and merge the passing revision');
  const files=[
    {path:'public/index.html',content:'<p>Hello</p>'},
    {path:'public/app.mjs',content:'export const greeting="Hello";'},
    {path:'test/app.test.mjs',content:"import test from 'node:test'; import assert from 'node:assert/strict'; import {greeting} from '../public/app.mjs'; test('greeting',()=>assert.strictEqual(greeting,'Hello'));"},
  ];
  let target;
  await pulse('author',({steps})=>{
    if (!steps.length) return choice('project.create',{name:'Greeting'});
    const projectId=steps[0].result.project.id;
    if (steps.length===1) return choice('project.commit',{projectId,files});
    target={projectId,taskId:authorTask.id,commitSha:steps[1].result.handoff.sha};
    if (steps.length===2) return choice('delivery.build',{projectId,commitSha:target.commitSha});
    assert.equal(steps[2].result.status,'passed');
    return choice('task.submit',{note:'One test passed',evidence:[target.commitSha]});
  });
  let merged;
  await pulse('peer',({task,steps})=>{
    assert.equal(task.id,reviewTask.id);
    if (!steps.length) return choice('project.snapshot',{...target,path:'public/app.mjs'});
    if (steps.length===1) {
      assert.equal(steps[0].result.content,files[1].content);
      return choice('delivery.status',target);
    }
    if (steps.length===2) {
      assert.equal(steps[1].result.build.testsPassed,1);
      return choice('project.review',{...target,decision:'approve',note:'Verified the implementation and passing build.'});
    }
    if (steps.length===3) {
      const {review} = steps[2].result;
      assert.equal(review.reviewerId,'peer');
      assert.equal(review.publicationStatus,'published');
      assert.equal(review.publication.sha,target.commitSha);
      return choice('project.merge',target);
    }
    merged=steps[3].result.merge;
    assert.equal(merged.status,'merged');
    if (steps.length===4) return choice('project.review.status',target);
    assert.equal(steps[4].result.merge.mergeSha,merged.mergeSha);
    return choice('task.submit',{note:'Merged the approved revision',evidence:[merged.mergeSha]});
  });
  const git=(...args)=>promisify(execFile)('git',['--git-dir',repo,...args]).then(r=>r.stdout.trim());
  assert.equal(await git('rev-parse','main'),merged.mergeSha);
  assert.equal(await git('show','main:apps/'+target.projectId+'/public/app.mjs'),files[1].content);
  assert.equal((await exec('owner','task.get',{taskId:reviewTask.id})).task.status,'submitted');
});

for (const legacy of [false,true]) test(`a submitted review resumes six confirmed decisions after ${legacy?'a legacy retry limit':'a normal pulse'}`,async t=>{
  const {pulse,exec,staff}=fixture(t);
  staff.set('ada',{id:'ada',name:'Ada',role:'Engineer',managerId:'ceo',desiredState:'active'});
  const {goal}=await exec('owner','goal.create',{requestId:'goal',accountableId:'ceo',outcome:'Deliver an app',successCriteria:'Inspect the submission'});
  const {task}=await exec('ceo','task.create',{requestId:'task',goalId:goal.id,assigneeId:'ada',title:'Build the app',acceptance:'Source and tests'});
  const sha='1'.repeat(40), target={projectId:'example',taskId:task.id,commitSha:sha};
  await pulse('ada',()=>choice('task.submit',{note:'Submitted',evidence:[sha]}));
  const codeDecision=legacy?'changes':'approve', taskDecision=legacy?'changes':'accept';
  const ops=[], files=['index.html','app.js','app.test.js','README.md'];
  let journalId;
  const issuedMerges=new Set();
  const execute=async (op,input)=>{
    if (op==='journal.get' && !journalId) journalId=input.id;
    if (op==='project.snapshot') {
      ops.push(op); return {commitSha:sha,files:files.map(path=>({path,content:'source body '+path}))};
    }
    if (op==='delivery.status') {ops.push(op);return {build:{...target,status:'passed',testsPassed:2}};}
    if (op==='project.merge') {
      ops.push(op);
      if (!issuedMerges.has(input.requestId)) {
        issuedMerges.add(input.requestId);throw new Error('Response lost after merge');
      }
      return {merge:{...target,sha,status:'merged',mergeSha:'2'.repeat(40)}};
    }
    if (op==='project.review') {
      ops.push(op);
      return {review:{...target,reviewerId:'ceo',decision:codeDecision,note:'Reviewed the exact head.',publicationStatus:'published',
        publication:{id:42,sha,prNumber:5,state:'COMMENTED',url:null}}};
    }
    return exec('ceo',op,input);
  };
  const prepare=({steps})=>{
    if(steps.length<4)return choice('project.snapshot',{...target,path:files[steps.length]});
    if(steps.length===4)return choice('delivery.status',target);
    assert.equal(steps.length,5);
    return choice('project.review',{...target,decision:codeDecision,note:'Reviewed the exact head.'});
  };
  assert.equal(await pulse('ceo',prepare,{execute}),'worked');
  if(legacy) {
    for(let n=0;n<3;n++)await exec('ceo','journal.fail',{id:journalId,attemptId:'legacy-'+n,kind:'review',workId:task.id});
    assert.equal((await exec('ceo','journal.get',{id:journalId})).entry.failures,3);
  }
  const finish=({task:submitted,steps})=>{
    assert.equal(submitted.id,task.id);
    assert.deepEqual(steps.slice(0,6).map(s=>s.op),[...files.map(()=>'project.snapshot'),'delivery.status','project.review']);
    assert.equal(steps[0].input.path,files[0]);
    assert.equal(JSON.stringify(steps).includes('source body'),false);
    assert.equal(steps[4].result.build.testsPassed,2);
    assert.equal(steps[5].result.review.decision,codeDecision);
    assert.equal(steps[5].result.review.commitSha,sha);
    assert.equal(steps[5].result.review.publication.state,'COMMENTED');
    if (!legacy) {
      if(steps.length===6)return choice('project.merge',target);
      assert.equal(steps[6].result.merge.sha,sha);
    }
    return choice('task.review',{decision:taskDecision,note:'Evaluated the recorded result'});
  };
  if (!legacy) await assert.rejects(pulse('ceo',finish,{execute}),/Response lost after merge/);
  assert.equal(await pulse('ceo',finish,{execute,now:()=>Date.now()+300_000}),'worked');
  assert.equal(issuedMerges.size,legacy?0:1);
  assert.equal((await exec('owner','task.get',{taskId:task.id})).task.status,legacy?'ready':'done');
  assert.equal(ops.filter(op=>op==='project.review').length,1);
});

test('review decisions stay bounded across pulses and later changes require the current submission',async t=>{
  const {pulse,exec,staff}=fixture(t);
  staff.set('ada',{id:'ada',name:'Ada',role:'Engineer',managerId:'ceo',desiredState:'active'});
  const {goal}=await exec('owner','goal.create',{requestId:'goal',accountableId:'ceo',outcome:'A reviewed report',successCriteria:'Independent evidence'});
  const {task}=await exec('ceo','task.create',{requestId:'task',goalId:goal.id,assigneeId:'ada',title:'Submit a report',acceptance:'A source'});
  const submit=()=>pulse('ada',()=>choice('task.submit',{note:'Report',evidence:['A source']}));
  await submit();
  const options={now:()=>Date.now()+300_000,browse:async url=>({url,title:'Evidence',text:'Source body'}),execute:async(op,input)=>{
    const data=await exec('ceo',op,input);
    if (op==='worker.poll') data.runtimeSettings={version:1,settings:{maxSteps:2}};
    return data;
  }};
  let count=0;
  const decide=ctx=>{
    assert.equal(ctx.reviewDecisionsRemaining,18-count);
    assert.equal(ctx.remainingDecisions,2-count%2);
    count++;
    return choice('browse',{url:'https://example.test/evidence'});
  };
  for (let pulseNo=1;pulseNo<9;pulseNo++) {
    assert.equal(await pulse('ceo',decide,options),'worked');assert.equal(count,pulseNo*2);
  }
  for(let n=0;n<3;n++) await assert.rejects(pulse('ceo',decide,options),/step limit/);
  assert.equal(await pulse('ceo',()=>assert.fail('spent review must be idle'),options),'idle');
  assert.equal(count,18);
  const {task:submitted}=await exec('owner','task.get',{taskId:task.id});
  assert.equal(submitted.status,'submitted');
  await exec('owner','task.review',{taskId:task.id,decision:'changes',note:'Revise the report',requestId:'changes'});
  await submit();
  await assert.rejects(exec('ceo','task.review',{taskId:task.id,decision:'accept',note:'Old report',ifWorkStep:submitted.workStep,requestId:'stale'}),{status:409});
  assert.equal(await pulse('ceo',ctx=>{
    assert.deepEqual(ctx.steps,[]);assert.equal(ctx.task.workStep,submitted.workStep+2);
    return choice('task.review',{decision:'accept',note:'Revised report passes'});
  }),'worked');
});
