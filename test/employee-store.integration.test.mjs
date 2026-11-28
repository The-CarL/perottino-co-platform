import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient, waitUntilTableExists } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { createCloudStore } from '../src/cloud-store.mjs';

const endpoint = process.env.PEROTTINO_DDB_TEST_ENDPOINT;
if (endpoint && !/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d+\/?$/.test(endpoint))
  throw Error('Employee-store tests require a local DynamoDB endpoint.');

async function withTable(check) {
  const tableName = 'perottino-resident-test-' + randomUUID();
  const raw = new DynamoDBClient({ endpoint, region:'us-east-1', credentials:{accessKeyId:'test',secretAccessKey:'test'} });
  const client = DynamoDBDocumentClient.from(raw);
  await raw.send(new CreateTableCommand({TableName:tableName, BillingMode:'PAY_PER_REQUEST',
    AttributeDefinitions:['pk','sk'].map(AttributeName=>({AttributeName,AttributeType:'S'})),
    KeySchema:[{AttributeName:'pk',KeyType:'HASH'},{AttributeName:'sk',KeyType:'RANGE'}]}));
  try {
    await waitUntilTableExists({client:raw,maxWaitTime:20,minDelay:1,maxDelay:2},{TableName:tableName});
    await check({ tableName, client });
  } finally {
    try { await raw.send(new DeleteTableCommand({TableName:tableName})); } finally { raw.destroy(); }
  }
}

test('resident identity and goal lifecycle on DynamoDB Local', { skip: !endpoint }, t => withTable(async ({ tableName, client }) => {
  let time = Date.now();
  const store = createCloudStore({ tableName, client, now:()=>time, resident:true });
  const legacy = createCloudStore({ tableName, client, now:()=>time, resident:false });
  const actor = (agentId,generation,taskArn) => ({agentId,generation,taskArn});
  const ceo = actor('ceo',1,'arn:test:tasks/ceo');
  const makeHire = (name,requestId) => ({callerId:'ceo',binding:ceo,role:'Engineer',name,handle:name.toLowerCase(),requestId,assignment:'Investigate soil records',maxEmployees:2});
  const run = binding => store.claimNextWork({...binding,leaseMs:1000});
  let hire, worker, ownerMessage;
    await t.test('legacy CEO state upgrades in place and a fenced manager can hire only one report',async()=>{
      await legacy.directory();
      ownerMessage=(await legacy.enqueue('ceo','original conversation','old-message')).message;
      const setup = await Promise.all([store.ensureCEO(),store.ensureCEO()]);
      assert.ok(setup.every(e=>e.canHire && e.desiredState==='active' && e.id==='ceo'));
      assert.equal(await store.bindEmployeeTask(ceo),true);
      assert.equal(await store.bindEmployeeTask({...ceo,taskArn:'another-task'}),false);
      const results=await Promise.all([store.hireEmployee(makeHire('Bea','hire-1')),store.hireEmployee(makeHire('Bea','hire-1'))]);
      hire=results[0]; worker=actor(hire.id,1,'arn:test:tasks/engineer');
      assert.equal(results[1].id,hire.id);assert.equal(hire.managerId,'ceo');assert.equal(hire.canHire,false);
      assert.deepEqual((await store.listGoals(hire.id)).map(g=>g.text),['Investigate soil records']);
      await assert.rejects(store.hireEmployee(makeHire('Ada','hire-2')),e=>e.code==='EMPLOYEE_LIMIT');
      await assert.rejects(store.hireEmployee({...makeHire('Bea','hire-1'),role:'CEO'}),e=>e.status===409);
      assert.equal(await store.bindEmployeeTask(worker),true);
      await assert.rejects(store.hireEmployee({...makeHire('Bad','invalid'),callerId:hire.id,binding:worker}),e=>e.status===403);
      const slots = await store.employeePage({limit:1});assert.equal(slots.employees.length,1);
      assert.ok((await store.employeePage({limit:1,cursor:slots.cursor})).employees.length);
      const original=await run(ceo);assert.equal(original.job.message.id,ownerMessage.id);
      assert.equal(await store.complete(original.job,'Resumed',[]),true);
    });
    await t.test('owner interruptions precede the next goal step and peers and mail retain sender identities',async()=>{
      const step=await run(worker);
      assert.equal(step.kind,'goal');
      assert.equal((await run(worker)).state,'busy');
      const message=await store.enqueue(hire.id,'Use public records','interrupt');
      const peer=await store.sendFromResident(ceo,hire.id,'Which sources?','first-peer');
      assert.equal(peer.message.author,'employee');
      assert.equal(peer.message.senderAgentId,'ceo');
      const mail={messageId:'mail-1',from:'outside@example.org',to:'bea@example.org',subject:'public request',text:'outside text'};
      const delivery=await store.enqueueEmail(hire.id,mail);
      assert.equal(delivery.message.author,'external');
      assert.equal((await store.enqueueEmail(hire.id,mail)).turnId,delivery.turnId);
      const aliasReceipt=await store.enqueueEmail(hire.id,{...mail,to:'engineer@example.org'});
      assert.equal(aliasReceipt.conflict,false);
      assert.equal(aliasReceipt.turnId,delivery.turnId);
      assert.equal(aliasReceipt.message.email.to,'bea@example.org');
      assert.equal((await store.enqueueEmail(hire.id,{...mail,from:'different@example.org'})).conflict,true);
      assert.equal(await store.checkpointGoal(step.job,{status:'ready',checkpoint:'sources located'}),true);
      const clarification=await run(worker);assert.equal(clarification.kind,'message');assert.equal(clarification.job.message.id,message.turnId);
      assert.equal(await store.complete(clarification.job,'Using public records',[],{text:'Publish appendix',checkpoint:'draft'}),true);
      const internal=await run(worker);assert.equal(internal.job.message.author,'employee');
      assert.equal(await store.complete(internal.job,'Registry',[]),true);
      const external=await run(worker);assert.equal(external.job.message.author,'external');
      assert.equal(await store.complete(external.job,'Received external mail',[]),true);
      const goal=await run(worker);assert.equal(goal.kind,'goal');
      assert.ok(goal.job.history.some(m=>m.text==='Use public records'));
      assert.ok(!goal.job.history.some(m=>m.text==='outside text' || m.text==='Received external mail'));
      assert.equal(await store.checkpointGoal(goal.job,{status:'waiting',checkpoint:'waiting for data',nextRunAt:time+10000}),true);
      const other=await run(worker);assert.equal(other.kind,'goal');
      assert.equal(await store.checkpointGoal(other.job,{status:'done',checkpoint:'completed'}),true);
      assert.equal((await run(worker)).state,'idle');
      assert.equal(await store.recordPulse(worker,{nextPulseAt:time+1000,summary:'waiting'}),true);
      assert.equal((await store.getPulse(hire.id)).summary,'waiting');
    });
    await t.test('paused and replaced tasks cannot publish, send, hire, or advance goals',async()=>{
      time+=11000;
      const old=await run(worker);assert.equal(old.kind,'goal');
      const pause={callerId:'owner',agentId:hire.id,desiredState:'paused',requestId:'pause'};
      const paused=await store.setEmployeeState(pause);
      assert.equal(paused.generation,2);assert.equal(paused.taskGeneration,1);
      assert.equal((await run(worker)).state,'inactive');
      assert.equal(await store.checkpointGoal(old.job,{status:'done',checkpoint:'stale'}),false);
      assert.equal(await store.recordPulse(worker,{nextPulseAt:time,summary:'stale'}),false);
      await assert.rejects(store.sendFromResident(worker,'ceo','obsolete','after-stop'),e=>e.status===403);
      await store.enqueue(hire.id,'after restart','queued-paused');
      const queued=await store.assignGoal(hire.id,'a paused assignment','paused-goal');
      assert.equal(queued.conflict,false);assert.equal((await store.assignGoal(hire.id,'a paused assignment','paused-goal')).goal.id,queued.goal.id);
      const restored=await store.setEmployeeState({...pause,desiredState:'active',requestId:'resume'});
      const replacement=actor(hire.id,restored.generation,'arn:test:tasks/replacement');
      assert.equal(await store.bindEmployeeTask(replacement),false);
      assert.equal(await store.clearEmployeeTask(worker),true);assert.equal(await store.bindEmployeeTask(replacement),true);
      assert.equal(await store.clearEmployeeTask(worker),false);
      const work=await run(replacement);assert.equal(work.job.message.text,'after restart');
      assert.equal(await store.complete(work.job,'new instance',[]),true);
      const goal=await run(replacement);assert.equal(goal.kind,'goal');
      assert.equal(await store.checkpointGoal(goal.job,{status:'done',checkpoint:'new instance'}),true);
      const fire={callerId:'ceo',binding:ceo,agentId:hire.id,desiredState:'fired',requestId:'fire'};
      assert.equal((await store.setEmployeeState(fire)).desiredState,'fired');
      assert.equal((await store.setEmployeeState(fire)).desiredState,'fired');
      await assert.rejects(store.setEmployeeState({...pause,desiredState:'active',requestId:'revive'}),e=>e.code==='EMPLOYEE_FIRED');
      await assert.rejects(store.assignGoal(hire.id,'new work','after-fire'),e=>e.code==='EMPLOYEE_FIRED');
      await assert.rejects(store.enqueue(hire.id,'new mail','after-fire'),e=>e.code==='EMPLOYEE_FIRED');
      assert.equal((await store.assignGoal(hire.id,'a paused assignment','paused-goal')).goal.id,queued.goal.id);
      assert.equal((await store.listEmployees()).length,2);
      assert.equal((await store.hireEmployee(makeHire('Bea','hire-1'))).desiredState,'fired');
      await assert.rejects(store.hireEmployee(makeHire('Bea','new-bea')),e=>e.code==='EMPLOYEE_IDENTITY_TAKEN');
      assert.equal((await store.hireEmployee(makeHire('Nia','new-hire'))).desiredState,'active');
    });
    await t.test('company epoch fences an in-flight reply through pause and immediate resume',async st=>{
      const oldFlag=process.env.PEROTTINO_COMPANY_GATE, oldEpoch=process.env.PEROTTINO_COMPANY_EPOCH;
      st.after(()=>{ for (const [key,value] of [['PEROTTINO_COMPANY_GATE',oldFlag],['PEROTTINO_COMPANY_EPOCH',oldEpoch]]) {
        if (value===undefined) delete process.env[key]; else process.env[key]=value;
      } });
      const gate=(running,version,epoch)=>client.send(new PutCommand({TableName:tableName,Item:{pk:'COMPANY#GATE',sk:'STATE',running,version,epoch}}));
      process.env.PEROTTINO_COMPANY_GATE='1';process.env.PEROTTINO_COMPANY_EPOCH='1';
      await gate(true,1,1);
      const msg=await store.enqueue('ceo','epoch work','epoch-1');
      const first=await run(ceo);assert.equal(first.job.message.id,msg.turnId);
      await gate(false,2,2);
      assert.equal(await store.complete(first.job,'stale pause',[]),false);
      await gate(true,3,3);
      assert.equal(await store.complete(first.job,'stale resume',[]),false);
      assert.equal(await store.recordPulse(ceo,{nextPulseAt:time,summary:'old epoch'}),false);
      const replacement={...ceo,taskArn:'arn:test:tasks/ceo-epoch3'};
      await store.clearEmployeeTask(ceo);await store.bindEmployeeTask(replacement);
      process.env.PEROTTINO_COMPANY_EPOCH='3';
      const current=await run(replacement);
      assert.equal(await store.complete(current.job,'fresh epoch',[]),true);
      const view=await store.messagePage('ceo');
      assert.equal(view.messages.at(-1).text,'fresh epoch');
      assert.ok(view.messages.every(m=>!m.text.startsWith('stale')));
    });
    await t.test('durable goals resume, finish, or hit their bounded autonomous step limit',async()=>{
      const replacement={...ceo,taskArn:'arn:test:tasks/ceo-epoch3'};
      time+=20000;
      const g=await store.assignGoal('ceo','bounded goal','max-steps');
      for (let i=0;i<12;i++) {
        time++;
        const contenders=await Promise.all([run(replacement),run(replacement)]);
        assert.equal(contenders.filter(c=>c.state==='claimed').length,1);
        const job=contenders.find(c=>c.state==='claimed').job;
        assert.equal(job.goal.stepCount,i);
        assert.equal(await store.checkpointGoal(job,{status:'ready',checkpoint:'step '+i}),true);
      }
      assert.equal((await store.getGoal('ceo',g.goal.id)).status,'blocked');
      assert.equal((await run(replacement)).state,'idle');
    });
}));

test('the default headcount includes the CEO, admits employee 100 and rejects employee 101',
  {skip:!endpoint}, t => withTable(async ({ tableName, client }) => {
    const inheritedLimit = process.env.PEROTTINO_EMPLOYEE_LIMIT;
    delete process.env.PEROTTINO_EMPLOYEE_LIMIT;
    t.after(() => {
      if (inheritedLimit === undefined) delete process.env.PEROTTINO_EMPLOYEE_LIMIT;
      else process.env.PEROTTINO_EMPLOYEE_LIMIT = inheritedLimit;
    });
    const store = createCloudStore({tableName,client,resident:true});
    const ceo = await store.ensureCEO();
    const binding = {agentId:ceo.id,generation:ceo.generation,taskArn:'arn:test:tasks/headcount-ceo'};
    assert.equal(await store.bindEmployeeTask(binding),true);

    function hire(number) {
      return store.hireEmployee({callerId:'ceo',binding,role:'Analyst',name:'Analyst ' + number,
        handle:'analyst-' + number,requestId:'hire-' + number});
    }
    await hire(1);
    process.env.PEROTTINO_EMPLOYEE_LIMIT = '2';
    await assert.rejects(hire(2),{code:'EMPLOYEE_LIMIT'});
    delete process.env.PEROTTINO_EMPLOYEE_LIMIT;

    for (let number = 2; number <= 98; number++) await hire(number);
    assert.equal((await store.listEmployees()).length,99);

    const contenders = await Promise.allSettled([hire(99),hire(100)]);
    assert.equal(contenders.filter(result=>result.status === 'fulfilled').length,1);
    const rejected = contenders.filter(result=>result.status === 'rejected');
    assert.equal(rejected.length,1);
    assert.equal(rejected[0].reason.code,'EMPLOYEE_LIMIT');
    await assert.rejects(hire(101),{code:'EMPLOYEE_LIMIT'});

    const roster = await store.listEmployees();
    assert.equal(roster.length,100);
    assert.equal(roster.filter(employee=>employee.id === ceo.id).length,1);
    assert.equal(roster.filter(employee=>employee.managerId === ceo.id).length,99);
  }));
