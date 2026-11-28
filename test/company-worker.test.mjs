import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createCompanyService } from '../src/company-service.mjs';
import { employmentWrites } from '../src/company-governance.mjs';
import { makeSqliteRecords } from '../src/foundation-records.mjs';
import { companyCommand } from '../src/resident.mjs';
import { runCompanyPulse,runCompanyResident } from '../src/company-worker.mjs';
import { createDecisionServer, requestCompanyDecision } from '../src/agent.mjs';
import { once } from 'node:events';

function fixture(t) {
  const records = makeSqliteRecords({ filename:':memory:' });
  t.after(() => records.close());
  const staff = new Map([['ceo',{ id:'ceo',handle:'mara',name:'Mara',role:'CEO',desiredState:'active',canHire:true }]]);
  const hires = new Map();
  const service = createCompanyService({ records,store:{ employee:id => staff.get(id),listEmployees:() => [...staff.values()] },
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
