import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient, waitUntilTableExists } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { InvokeCommand } from '@aws-sdk/client-lambda';
import { hashPassword } from '../src/auth.mjs';
import { createCloudHandler } from '../src/cloud-api.mjs';
import { createCloudStore } from '../src/cloud-store.mjs';
import { createEmailIngress } from '../src/email-ingress.mjs';
import { createCompanyMail } from '../src/company-mail.mjs';
import { createLocalMailTransport } from '../src/company-mail-outbox.mjs';
import { createCompanyService } from '../src/company-service.mjs';
import { runCompanyPulse } from '../src/company-worker.mjs';
import { makeDynamoRecords } from '../src/foundation-records.mjs';
import { createFactoryState } from '../src/factory-state.mjs';
import { createEmployeeFactory } from '../src/factory.mjs';
import { executeResidentPulse, managerTool } from '../src/resident.mjs';

const endpoint = process.env.PEROTTINO_DDB_TEST_ENDPOINT;
const account = '111111111111', region = 'us-east-1';
const clusterArn = 'arn:aws:ecs:' + region + ':' + account + ':cluster/company';
const taskDefinitionArn = 'arn:aws:ecs:' + region + ':' + account + ':task-definition/worker:1';
const topicArn = 'arn:aws:sns:' + region + ':' + account + ':company-mail';
const domain = 'company.example.test';

function simulatedEcs(clock) {
  const tasks = new Map(), launches = [], startRequests = [], stopRequests = [];
  async function send(command) {
    const input = command.input;
    assert.equal(input.cluster, clusterArn);
    switch (command.constructor.name) {
      case 'RunTaskCommand': {
        startRequests.push(input.clientToken);
        assert.equal(input.count, 1);
        assert.equal(input.launchType, 'FARGATE');
        assert.equal(input.taskDefinition, taskDefinitionArn);
        const prior = launches.find(task=>task.clientToken === input.clientToken);
        if (prior) return {tasks:[prior],failures:[]};
        const arn = 'arn:aws:ecs:' + region + ':' + account + ':task/company/' + randomUUID().replaceAll('-','');
        const task = {taskArn:arn, clusterArn, group:input.group, taskDefinitionArn, clientToken:input.clientToken,
          startedBy:input.startedBy, overrides:input.overrides, lastStatus:'RUNNING', startedAt:new Date(clock())};
        tasks.set(arn, task); launches.push(task);
        return {tasks:[task],failures:[]};
      }
      case 'ListTasksCommand':
        return {taskArns:[...tasks.values()].filter(task=>task.lastStatus === 'RUNNING'
          && (!input.startedBy || task.startedBy === input.startedBy)).map(task=>task.taskArn)};
      case 'DescribeTasksCommand':
        return {tasks:input.tasks.map(arn=>tasks.get(arn)).filter(Boolean),failures:[]};
      case 'StopTaskCommand': {
        const task = tasks.get(input.task);
        assert.ok(task);
        stopRequests.push(input.task);
        task.lastStatus = 'STOPPED';
        return {task};
      }
      default: assert.fail('Unexpected ECS call ' + command.constructor.name);
    }
  }
  return {send,launches,startRequests,stopRequests};
}

function binding(task) {
  const environment = Object.fromEntries(task.overrides.containerOverrides[0].environment.map(({name,value})=>[name,value]));
  return {agentId:environment.AGENT_ID, generation:Number(environment.EMPLOYEE_GENERATION), taskArn:task.taskArn};
}
function capability(task) {
  return task.overrides.containerOverrides[0].environment.find(entry=>entry.name === 'PEROTTINO_EMPLOYEE_CAPABILITY').value;
}
function stopped(task) {
  task.lastStatus = 'STOPPED';
  return {source:'aws.ecs',detail:{clusterArn,taskArn:task.taskArn,group:task.group,lastStatus:'STOPPED'}};
}
const tick = {source:'aws.events','detail-type':'Scheduled Event'};

function publicMail(to) {
  const content = 'From: Person <person@example.test>\r\nTo: ' + to + '\r\nSubject: Dataset\r\n'
    + 'Message-ID: <dataset@example.test>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nPlease check the public dataset.';
  const envelope = {notificationType:'Received',receipt:{recipients:[to],spamVerdict:{status:'PASS'},virusVerdict:{status:'PASS'},spfVerdict:{status:'PASS'}},
    mail:{messageId:'resident-integration-mail',source:'person@example.test'},content:Buffer.from(content).toString('base64')};
  return {Records:[{EventSource:'aws:sns',Sns:{TopicArn:topicArn,Message:JSON.stringify(envelope)}}]};
}

test('standalone employees process existing mailboxes, recover goals, recruit under authority and stay stopped when paused or fired',
  {skip:!endpoint,timeout:90_000}, async t => {
    const url = new URL(endpoint);
    assert.ok(url.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname)
      && !url.username && !url.password, 'Use a loopback DynamoDB Local endpoint');
    const client = new DynamoDBClient({endpoint,region,credentials:{accessKeyId:'test',secretAccessKey:'test'}});
    const tableName = 'perottino-flow-' + randomUUID();
    await client.send(new CreateTableCommand({TableName:tableName,BillingMode:'PAY_PER_REQUEST',
      AttributeDefinitions:['pk','sk'].map(AttributeName=>({AttributeName,AttributeType:'S'})),
      KeySchema:[{AttributeName:'pk',KeyType:'HASH'},{AttributeName:'sk',KeyType:'RANGE'}]}));
    t.after(async () => {
      try { await client.send(new DeleteTableCommand({TableName:tableName})); }
      finally { client.destroy(); }
    });
    await waitUntilTableExists({client,maxWaitTime:20,minDelay:1,maxDelay:2},{TableName:tableName});
    const doc = DynamoDBDocumentClient.from(client);
    let time = Date.now();
    const now = () => time;
    const freshStore = () => createCloudStore({tableName,client:doc,now,resident:true});
    const ecs = simulatedEcs(now);
    const stackResponses = [];
    const factory = createEmployeeFactory({store:freshStore(),state:createFactoryState({tableName,client:doc}),
      ecs,config:{tableName,clusterArn,taskDefinitionArn,subnets:['subnet-test'],securityGroupId:'sg-test',employeeLimit:3},
      now,respond:async (_event,payload)=>{stackResponses.push(payload);}});
    await factory.handler({RequestType:'Create',RequestId:randomUUID(),LogicalResourceId:'ResidentCompany',
      StackId:'arn:aws:cloudformation:' + region + ':' + account + ':stack/test/' + randomUUID(),
      ResourceProperties:{TaskDefinitionArn:taskDefinitionArn},ResponseURL:'https://example.test/test'});
    assert.equal(stackResponses[0].Status,'SUCCESS');
    assert.equal(ecs.launches.length,1);
    const ceoTask = ecs.launches[0];
    assert.equal(binding(ceoTask).agentId,'ceo');
    const username = 'owner', password = 'hosted-flow-test-fixture';
    const verifier = {username,passwordHash:await hashPassword(password)};
    const authorization = 'Basic ' + Buffer.from(username + ':' + password).toString('base64');
    async function api(agentId,section,body,expectedStatus) {
      const rawPath = '/api/agents/' + agentId + '/' + section, method = body ? 'POST' : 'GET';
      const handler = createCloudHandler({store:freshStore(),publicOrigin:'https://' + domain,readOwner:async()=>verifier,
        ownerControl:event=>factory.owner(event)});
      const res = await handler({version:'2.0',rawPath,rawQueryString:'',
        headers:{authorization,host:domain,origin:'https://' + domain,'content-type':'application/json'},
        requestContext:{domainName:domain,http:{method,sourceIp:'192.0.2.10'}},...(body && {body:JSON.stringify(body)})});
      if (expectedStatus) assert.equal(res.statusCode,expectedStatus,res.body);
      else assert.ok(res.statusCode >= 200 && res.statusCode < 300,res.body);
      return JSON.parse(res.body);
    }
    async function pulse(task,decide = () => assert.fail('Unexpected Bedrock call'), recruit = () => assert.fail('Unexpected hire')) {
      const environment = task.overrides.containerOverrides[0].environment;
      const epoch = environment.find(entry=>entry.name === 'PEROTTINO_COMPANY_EPOCH')?.value;
      assert.match(epoch,/^[1-9][0-9]*$/);
      // Lambda and Fargate normally have distinct environments. Mirror the actual
      // launch override for each worker while these isolated test clients share Node.
      const saved = {PEROTTINO_COMPANY_GATE:process.env.PEROTTINO_COMPANY_GATE,
        PEROTTINO_COMPANY_EPOCH:process.env.PEROTTINO_COMPANY_EPOCH};
      try {
        process.env.PEROTTINO_COMPANY_GATE = '1';
        process.env.PEROTTINO_COMPANY_EPOCH = epoch;
        time += 31_000;
        assert.equal(await executeResidentPulse({binding:binding(task),store:freshStore(),now,decide,
          browse:()=>assert.fail('Unexpected browser call'),recruit}), 'worked');
      } finally {
        for (const [key,value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
      }
    }
    const note = 'Use blue labels for the June release.';
    const remember = {text:'remember ' + note,requestId:randomUUID()};
    const first = await api('ceo','messages',remember);
    assert.deepEqual(await api('ceo','messages',remember),first);
    await pulse(ceoTask);
    await api('ceo','messages',{text:'recall blue labels',requestId:randomUUID()});
    await pulse(ceoTask);
    const history = await api('ceo','messages');
    assert.deepEqual(history.messages.map(({author,text})=>[author,text]),[
      ['owner',remember.text],['agent','Remembered: ' + note],['owner','recall blue labels'],['agent','My saved notes:\n- ' + note],
    ]);
    const memories = await api('ceo','memory');
    assert.deepEqual(memories.memories.map(({text,sourceMessageId})=>[text,sourceMessageId]),[[note,first.message.id]]);
    const records = makeDynamoRecords({tableName,client:doc});
    const mailbox = createCompanyMail({records,store:freshStore(),domain});
    const receive = createEmailIngress({mail:mailbox,store:freshStore(),domain,topicArn});
    const letter = publicMail('ceo@' + domain);
    await receive(letter);
    await receive(letter);
    // Use a fresh service just as the broker does, backed by the same hosted record format.
    // The local capture transport exercises the real outbox without calling an external service.
    const company = createCompanyService({records:makeDynamoRecords({tableName,client:doc}),store:freshStore(),
      adapters:{mail:{domain},mailTransport:records=>createLocalMailTransport({records})}});
    const {threads} = await company.execute('owner','mail.list',{employeeId:'ceo'});
    assert.equal(threads.length,1);
    const readThread = () => company.execute('owner','mail.get',{threadId:threads[0].id});
    const incoming = (await readThread()).messages;
    assert.equal(incoming.length,1,'Duplicate SES delivery must produce one durable email');
    assert.equal(incoming[0].from,'person@example.test');
    assert.equal(incoming[0].trustedOwner,false);
    let calls = 0;
    const state = await runCompanyPulse({actor:await freshStore().employee('ceo'),workerId:ceoTask.taskArn,
      mode:'local',execute:(op,input)=>company.execute('ceo',op,input),decide:context=>{
        calls++;
        assert.deepEqual(context.allowed.slice().sort(),['pass','reply']);
        assert.equal(context.message.text,'Please check the public dataset.');
        assert.equal(context.history,undefined);
        assert.equal(context.directory,undefined);
        return {op:'reply',input:{text:'Received the dataset question.'}};
      }});
    assert.equal(state,'worked');
    assert.equal(calls,1);
    const thread = await readThread();
    assert.equal(thread.messages.length,2);
    const reply = thread.messages[1];
    assert.equal(reply.status,'sent');
    assert.equal(reply.to,'person@example.test');
    assert.equal(reply.inReplyTo,'<dataset@example.test>');
    assert.equal(reply.text,'Received the dataset question.');
    assert.deepEqual((await api('ceo','messages')).messages,history.messages,
      'Private owner DMs remain separate from email correspondence');
    assert.equal(ecs.startRequests.length,1,'Chat and email must never request another task');

    // Drive recruitment from a model decision inside the resident. Only the
    // worker transport supplies authority from the launch, outside model context.
    const managerBinding = {callerId:'ceo',generation:binding(ceoTask).generation,taskArn:ceoTask.taskArn};
    const denied = await factory.manager({...managerBinding,operation:'hire',capability:'invalid',requestId:randomUUID(),
      role:'Engineer',assignment:'Check the public dataset.'});
    assert.equal(denied.ok,false);
    await api('ceo','messages',{text:'Take ownership of the public dataset application and staff the work.',requestId:randomUUID()});
    await pulse(ceoTask,()=>({action:'goal',value:'Staff the public dataset application.'}));
    let hire, hired;
    const recruit = managerTool(binding(ceoTask),{capability:capability(ceoTask),functionName:'fixture-manager',InvokeCommand,
      client:{send:async command=>{
        assert.equal(command.input.FunctionName,'fixture-manager');
        hire = JSON.parse(Buffer.from(command.input.Payload).toString('utf8'));
        hired = await factory.manager(hire);
        return {Payload:Buffer.from(JSON.stringify(hired))};
      }}});

    await pulse(ceoTask,()=>({action:'hire',target:'Engineer',value:'Maintain the public dataset application.'}),recruit);
    await pulse(ceoTask,()=>assert.fail('A persisted hiring action must execute without replanning'),recruit);
    assert.equal(hired?.ok,true,JSON.stringify(hired));
    assert.equal((await factory.manager(hire)).ok,true);
    assert.equal(ecs.startRequests.length,2);
    const engineer = ecs.launches[1], engineerId = binding(engineer).agentId;
    assert.notEqual(engineerId,'ceo');
    assert.equal((await freshStore().employee(engineerId)).managerId,'ceo');
    assert.equal((await freshStore().employee(engineerId)).canHire,false);
    assert.notEqual(capability(engineer),capability(ceoTask));
    const nextHire = {...hire,...binding(engineer),callerId:engineerId,capability:capability(engineer),requestId:randomUUID()};
    assert.equal((await factory.manager(nextHire)).ok,false,'An individual contributor cannot recruit');
    assert.equal(ecs.startRequests.length,2);

    await pulse(engineer,()=>({action:'work',value:'The dataset schema has been verified.'}));
    const [goal] = await freshStore().listGoals(engineerId);
    assert.match(JSON.stringify(goal),/dataset schema has been verified/);
    const crash = stopped(engineer);
    await factory.handler(crash);
    time += 11 * 60_000;
    await factory.handler(tick);
    assert.equal(ecs.startRequests.length,3);
    const replacement = ecs.launches[2];
    assert.equal(binding(replacement).agentId,engineerId);
    assert.notEqual(replacement.taskArn,engineer.taskArn);
    await factory.handler(crash);
    await pulse(replacement,context=>{
      assert.match(JSON.stringify(context),/dataset schema has been verified/);
      return {action:'finish',value:'Published a verified dataset handoff.'};
    });
    assert.equal((await freshStore().listGoals(engineerId))[0].status,'done');
    await api(engineerId,'lifecycle/pause',{requestId:randomUUID()});
    assert.ok(ecs.stopRequests.includes(replacement.taskArn),'Pausing an active employee must call ECS StopTask');
    assert.equal(replacement.lastStatus,'STOPPED');
    await api(engineerId,'messages',{text:'An update for when you return.',requestId:randomUUID()},202);
    await factory.handler(stopped(replacement));
    time += 11 * 60_000;
    await factory.handler(tick);
    assert.equal(ecs.startRequests.length,3,'A paused employee must stay stopped');
    await api(engineerId,'lifecycle/resume',{requestId:randomUUID()});
    assert.equal(ecs.startRequests.length,4,'Resuming starts one fresh task');
    const resumed = ecs.launches[3];
    assert.equal(resumed.lastStatus,'RUNNING');
    assert.equal(binding(resumed).agentId,engineerId);
    await api(engineerId,'lifecycle/fire',{requestId:randomUUID()});
    assert.ok(ecs.stopRequests.includes(resumed.taskArn),'Firing an active employee must call ECS StopTask');
    assert.equal(resumed.lastStatus,'STOPPED');
    await factory.handler(stopped(resumed));
    await api(engineerId,'messages',{text:'A final request',requestId:randomUUID()},409);
    await factory.handler(crash);
    await factory.handler(tick);
    assert.equal((await freshStore().employee(engineerId)).desiredState,'fired');
    assert.equal(ecs.startRequests.length,4,'A fired employee must stay stopped');
  });
