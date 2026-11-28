import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient, waitUntilTableExists } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { createCloudStore } from '../src/cloud-store.mjs';
import { makeDynamoRecords } from '../src/foundation-records.mjs';
import { createFactoryState } from '../src/factory-state.mjs';
import { createEmployeeFactory } from '../src/factory.mjs';

const endpoint = process.env.PEROTTINO_DDB_TEST_ENDPOINT;
const stackId = 'arn:aws:cloudformation:us-east-1:111111111111:stack/test/' + randomUUID();
const config = { clusterArn:'fixture-cluster', taskDefinitionArn:'fixture-family:1', subnets:['fixture-subnet'],
  securityGroupId:'fixture-group', employeeLimit:2 };
const scheduled = { source:'aws.events', 'detail-type':'Scheduled Event' };

async function fixture(t, foundations = false, overrides = {}) {
  const url = new URL(endpoint);
  assert.ok(url.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname) && !url.username && !url.password);
  const tableName = 'factory-test-' + randomUUID();
  const raw = new DynamoDBClient({ endpoint, region:'us-east-1', credentials:{ accessKeyId:'test',secretAccessKey:'test' } });
  await raw.send(new CreateTableCommand({ TableName:tableName, BillingMode:'PAY_PER_REQUEST',
    AttributeDefinitions:['pk','sk'].map(AttributeName => ({ AttributeName, AttributeType:'S' })),
    KeySchema:[{ AttributeName:'pk',KeyType:'HASH' },{ AttributeName:'sk',KeyType:'RANGE' }] }));
  t.after(async () => { try { await raw.send(new DeleteTableCommand({ TableName:tableName })); } finally { raw.destroy(); } });
  await waitUntilTableExists({ client:raw,maxWaitTime:20,minDelay:1,maxDelay:2 },{ TableName:tableName });
  const client = DynamoDBDocumentClient.from(raw), tasks = new Map(), launches = [], responses = [];
  const clock = { time:Date.now() }, flags = { loseLaunch:false, rejectLaunch:false, afterSleep:null };
  const now = () => clock.time;
  const stateClient = {async send(command) {
    try {return await client.send(command);}
    catch (error) {
      if(flags.omitSeatReasons && command.input.TransactItems?.some(item=>item.Update?.Key?.sk==='SEATS')) delete error.CancellationReasons;
      throw error;
    }
  }};
  const state = createFactoryState({ tableName,client:stateClient }), store = createCloudStore({ tableName,client,now });
  const ecs = { async send(command) {
    const p = command.input;
    assert.equal(p.cluster, config.clusterArn);
    switch (command.constructor.name) {
      case 'RunTaskCommand': {
        launches.push(p);
        if (flags.rejectLaunch) return { tasks:[], failures:[{ reason:'CAPACITY' }] };
        let task = [...tasks.values()].find(task => task.startedBy === p.clientToken);
        if (!task) {
          task = { taskArn:'task/'+randomUUID(), lastStatus:'RUNNING',desiredStatus:'RUNNING', startedBy:p.clientToken,
            taskDefinitionArn:p.taskDefinition,group:p.group, overrides:p.overrides };
          tasks.set(task.taskArn,task);
        }
        if (flags.loseLaunch) { flags.loseLaunch=false; throw new Error('Response lost after placement'); }
        return { tasks:[task] };
      }
      case 'StopTaskCommand':
        tasks.get(p.task).desiredStatus='STOPPED'; return {};
      case 'DescribeTasksCommand':
        return { tasks:p.tasks.map(arn=>tasks.get(arn)).filter(Boolean) };
      case 'ListTasksCommand':
        return { taskArns:[...tasks.values()].filter(task => task.desiredStatus === 'RUNNING' &&
          (!p.startedBy || task.startedBy === p.startedBy)).map(task => task.taskArn) };
      default: assert.fail(command.constructor.name);
    }
  } };
  const recordsFor = (binding,version) => makeDynamoRecords({client,tableName,conditions:binding ? store.foundationGuards(binding,version) : []});
  const factory = createEmployeeFactory({ state, store, ecs, config:{...config,...overrides}, now, ...(foundations && {recordsFor}), respond:async(_,result)=>responses.push(result),
    sleep:async ms=>{ clock.time+=ms; flags.afterSleep?.(); } });
  const custom = async (RequestType, RequestId = randomUUID()) => {
    await factory.handler({ RequestType,RequestId,StackId:stackId,LogicalResourceId:'Residents',
      ResourceProperties:{ TaskDefinitionArn:config.taskDefinitionArn } });
    return responses.at(-1);
  };
  const stopped = task => {
    task.lastStatus='STOPPED'; task.desiredStatus='STOPPED';
    return factory.handler({ source:'aws.ecs',detail:{ clusterArn:config.clusterArn,group:task.group,taskArn:task.taskArn,lastStatus:'STOPPED' } });
  };
  return { clock, flags, state, store, tasks, launches, factory, custom, stopped, client, tableName };
}

test('ambiguous ECS placement reuses identical input; repeated definite failures stop consuming launches',
  {skip:!endpoint},async t=>{
    const f=await fixture(t);
    await f.custom('Create');
    const ceo=await f.store.employee('ceo'), initial=f.tasks.get(ceo.taskArn);
    await f.stopped(initial);
    f.clock.time+=600_000;
    f.flags.loseLaunch=true;
    await f.factory.handler(scheduled);
    const uncertain=f.launches.at(-1);
    f.clock.time+=600_000;
    await f.factory.handler(scheduled);
    assert.deepEqual(f.launches.at(-1),uncertain);
    assert.equal(f.tasks.size,2);
    const current=await f.store.employee('ceo');
    await f.stopped(initial);
    assert.equal((await f.store.employee('ceo')).taskArn,current.taskArn);
    await f.stopped(f.tasks.get(current.taskArn));
    f.flags.rejectLaunch=true;
    for(let i=0;i<8;i++){ f.clock.time+=1_000_000; await f.factory.handler(scheduled); }
    assert.equal((await f.state.run('ceo')).stage,'blocked');
    const attempts=f.launches.length;
    f.clock.time+=3_600_000;
    await f.factory.handler(scheduled);
    assert.equal(f.launches.length,attempts);
  });

test('a fired employee retains its compute seat until its exact ECS task stops',
  {skip:!endpoint},async t=>{
    const f=await fixture(t);
    assert.equal((await f.custom('Create')).Status,'SUCCESS');
    assert.equal((await f.state.company()).residentLimit,config.employeeLimit);
    // Upgrades can read company records created before residentLimit existed.
    await f.client.send(new UpdateCommand({TableName:f.tableName,Key:{pk:'FACTORY#CONTROL',sk:'COMPANY'},UpdateExpression:'REMOVE residentLimit'}));
    const ceo=await f.store.employee('ceo');
    const capability=f.tasks.get(ceo.taskArn).overrides.containerOverrides[0].environment
      .find(variable=>variable.name==='PEROTTINO_EMPLOYEE_CAPABILITY').value;
    const hiring = { operation:'hire',callerId:'ceo',generation:ceo.generation,taskArn:ceo.taskArn,capability,role:'Engineer',assignment:'Prepare a report' };
    assert.equal((await f.factory.manager({...hiring,capability:'invalid',requestId:'bad'})).status,403);
    const hire=await f.factory.manager({...hiring,requestId:'first'});
    assert.equal(hire.ok,true);
    assert.equal((await f.factory.manager({...hiring,requestId:'first'})).employee.id,hire.employee.id);
    const first=f.tasks.get((await f.store.employee(hire.employee.id)).taskArn);
    assert.equal((await f.factory.owner({operation:'fire',agentId:hire.employee.id,requestId:'fire'})).ok,true);
    const second=await f.factory.manager({...hiring,requestId:'replacement'});
    assert.equal(second.ok,true);
    assert.equal((await f.store.employee(second.employee.id)).taskArn,null);
    assert.equal(f.launches.length,2);
    await f.stopped(first);
    await f.factory.handler(scheduled);
    assert.ok((await f.store.employee(second.employee.id)).taskArn);
    assert.equal(f.launches.length,3);
  });

test('stack shutdown waits for confirmed stops and rejects old creation events after deletion',
  {skip:!endpoint},async t=>{
    const f=await fixture(t), createId=randomUUID();
    assert.equal((await f.custom('Create',createId)).Status,'SUCCESS');
    const ceo=await f.store.employee('ceo'), task=f.tasks.get(ceo.taskArn);
    let waits=0;
    f.flags.afterSleep=()=>{
      if (++waits===2) task.lastStatus='STOPPED';
    };
    assert.equal((await f.custom('Delete')).Status,'SUCCESS');
    assert.equal(waits,2);
    assert.equal((await f.store.employee('ceo')).taskArn,null);
    assert.equal((await f.state.company()).enabled,false);
    await f.custom('Create',createId);
    assert.equal((await f.custom('Create')).Status,'FAILED');
    await f.factory.handler(scheduled);
    assert.equal(f.launches.length,1);
    const fresh=await fixture(t);
    assert.equal((await fresh.custom('Delete')).Status,'SUCCESS');
    assert.equal((await fresh.custom('Create')).Status,'FAILED');
    assert.equal(fresh.launches.length,0);
  });

test('a manager from before a company pause cannot hire after a rapid resume, even while its task is still bound',
  {skip:!endpoint},async t=>{
    const f=await fixture(t);
    assert.equal((await f.custom('Create')).Status,'SUCCESS');
    const ceo=await f.store.employee('ceo'), run=await f.state.run('ceo');
    await f.state.suspend('pause',true);
    await f.state.suspend('resume',false);
    assert.equal((await f.store.employee('ceo')).taskArn,ceo.taskArn);
    const response=await f.factory.manager({operation:'hire',callerId:'ceo',taskArn:ceo.taskArn,generation:ceo.generation,
      capability:run.capability,requestId:'old-manager',role:'Engineer'});
    assert.equal(response.status,403);
    assert.equal((await f.store.listEmployees()).length,1);
  });

test('bound IC can consume and submit work through the broker and has no administrative authority',{skip:!endpoint},async t=>{
  const f=await fixture(t,true);
  assert.equal((await f.custom('Create')).Status,'SUCCESS');
  const owner = (op,input={}) => f.factory.owner({operation:'company',command:{op,input},requestId:randomUUID()});
  const created = await owner('employee.hire',{role:'Engineer',requestId:'engineer'});
  assert.equal(created.ok,true);
  const employee = await f.store.employee(created.result.employee.id);
  const run=await f.state.run(employee.id);
  const invoke = (op,input={}) => f.factory.manager({operation:'company',callerId:employee.id,taskArn:employee.taskArn,
    generation:employee.generation,capability:run.capability,requestId:randomUUID(),command:{op,input}});
  assert.equal((await invoke('directory.self')).result.employee.id,employee.id);
  assert.equal((await invoke('admin.conversations')).status,403);
  assert.equal((await invoke('employee.hire',{role:'QA',requestId:'no-authority'})).status,403);
  assert.equal((await invoke('directory',{callerId:'ceo'})).status,400);
  const goal = await owner('goal.create',{accountableId:'ceo',outcome:'Compute the sample',successCriteria:'Show sum',requestId:'sample'});
  const task = await owner('task.create',{goalId:goal.result.goal.id,assigneeId:employee.id,title:'Add 2 and 3',acceptance:'Show operands and sum',requestId:'sum'});
  const taskId = task.result.task.id;
  assert.equal((await invoke('worker.poll',{workerId:'resident-fixture'})).result.readyTasks[0].id,taskId);
  const {claimToken} = (await invoke('task.claim',{taskId,requestId:'claim'})).result;
  assert.ok(claimToken);
  assert.equal((await invoke('task.submit',{taskId,claimToken,evidence:['2+3=5'],requestId:'submit'})).result.task.status,'submitted');
  assert.equal((await invoke('worker.heartbeat',{nextPulseAt:Date.now()+10000,summary:'worked'})).result.active,true);
  assert.match((await owner('company.overview')).result.agents.find(a=>a.id===employee.id).lastPulseAt,/Z$/);
  assert.equal((await owner('employee.pause',{agentId:employee.id,requestId:'pause-employee'})).ok,true);
  assert.equal((await invoke('directory.self')).code,'MANAGER_DENIED');
});

test('a 100-person roster defers excess Fargate residents and preserves their work until a confirmed stop',
  {skip:!endpoint}, async t=>{
    const f=await fixture(t,true,{employeeLimit:100,residentLimit:3});
    assert.equal((await f.custom('Create')).Status,'SUCCESS');
    const owner=async (op,input={})=>{
      const response=await f.factory.owner({operation:'company',requestId:randomUUID(),command:{op,input}});
      assert.equal(response.ok,true,op+' '+JSON.stringify(response));
      return response.result;
    };
    const hire=async key=>(await owner('employee.hire',{role:'Engineer',requestId:key})).employee;
    await hire('initial-engineer');
    const competitors=await Promise.all([hire('competing-a'),hire('competing-b')]);
    const roster=(await owner('directory')).agents;
    assert.equal(roster.length,4);
    assert.equal(f.launches.length,3);
    const waiter=roster.find(person=>person.runtimeStatus==='Waiting for a Fargate task');
    assert.ok(competitors.some(person=>person.id===waiter.id));
    assert.equal((await f.store.employee(waiter.id)).taskArn,null);
    assert.equal(await f.state.run(waiter.id),undefined);
    assert.deepEqual(await f.state.waiters(12),[{id:waiter.id,generation:1}]);
    assert.equal((await f.state.company()).residentLimit,3);

    await assert.rejects(f.state.configure({stackId,requestId:randomUUID(),enabled:true,employeeLimit:100,residentLimit:2}),
      /Release occupied Fargate slots/);
    assert.equal((await f.state.company()).residentLimit,3);
    const {conversation}=await owner('conversations.dm',{peerId:waiter.id});
    const {message}=await owner('messages.post',{conversationId:conversation.id,text:'Check this when a seat opens.',requestId:'held-dm'});
    for(let i=0;i<2;i++)await f.factory.handler(scheduled);
    assert.equal(f.launches.length,3);
    const denied=await f.factory.manager({operation:'company',callerId:waiter.id,generation:1,taskArn:'unbound',
      capability:'unbound',requestId:randomUUID(),command:{op:'budget.model.begin',input:{}}});
    assert.equal(denied.code,'MANAGER_DENIED');
    assert.equal((await owner('governance.get',{employeeId:waiter.id})).budget.spentCents,0);

    const incumbent=roster.find(person=>person.id!=='ceo'&&person.id!==waiter.id);
    const oldTask=f.tasks.get((await f.store.employee(incumbent.id)).taskArn);
    await owner('employee.pause',{agentId:incumbent.id,requestId:'free-one-slot'});
    await f.factory.handler(scheduled);
    assert.equal(f.launches.length,3,'A stop request alone cannot release a seat.');
    await f.stopped(oldTask);
    assert.equal(f.launches.length,4,'The released seat admits a waiter directly from the STOPPED event.');
    const run=await f.state.run(waiter.id), newEmployee=await f.store.employee(waiter.id);
    assert.ok(run.arn);
    assert.equal(newEmployee.taskArn,run.arn);
    await f.factory.handler(scheduled);
    assert.equal(f.launches.length,4);
    assert.deepEqual(await f.state.waiters(12),[]);
    assert.equal(f.launches.filter(p=>p.group==='employee-'+waiter.id).length,1);
    const work=await f.factory.manager({operation:'company',callerId:waiter.id,generation:newEmployee.generation,
      taskArn:run.arn,capability:run.capability,requestId:randomUUID(),command:{op:'worker.poll',input:{workerId:run.arn}}});
    assert.equal(work.result.inbox.message.id,message.id);
    f.flags.omitSeatReasons=true;
    const next=await hire('fifth-person');
    assert.equal((await f.store.employee(next.id)).taskArn,null);
    assert.equal((await owner('directory')).agents.length,5);
    assert.equal((await f.store.employee(incumbent.id)).desiredState,'paused');
    assert.deepEqual(await f.state.waiters(12),[{id:next.id,generation:1}]);
    await owner('employee.pause',{agentId:waiter.id,requestId:'free-another-seat'});
    await f.stopped(f.tasks.get(run.arn));
    assert.ok((await f.store.employee(next.id)).taskArn);
    assert.deepEqual(await f.state.waiters(12),[]);
    const last=await hire('queued-and-paused');
    await owner('employee.pause',{agentId:last.id,requestId:'pause-waiter'});
    assert.deepEqual(await f.state.waiters(12),[]);
    assert.equal(f.launches.length,5);
  });
