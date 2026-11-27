// Runs inside the built images. DynamoDB Local and the synthetic service endpoints
// share an isolated loopback network. Explicit memory commands need no model.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { rootCertificates } from 'node:tls';
import { setTimeout as sleep } from 'node:timers/promises';

const phase = process.argv.at(-1);
const note = 'Include a preview URL in handoffs.';
const password = 'synthetic-image-test-verifier';
const taskArn = 'arn:aws:ecs:us-east-1:111111111111:task/resident/' + 'a'.repeat(32);
const tableName = 'ImageSmoke';
const auth = {authorization:'Basic ' + Buffer.from('owner:' + password).toString('base64')};

async function eventually(check, timeoutMs = 75_000) {
  const end = Date.now() + timeoutMs;
  let error;
  do {
    try { return await check(); } catch (err) { error = err; }
    await sleep(350);
  } while (Date.now() < end);
  throw error;
}

async function invoke(event) {
  const response = await fetch('http://127.0.0.1:8080/2015-03-31/functions/function/invocations', {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(event),
  });
  assert.equal(response.status, 200);
  const raw = await response.text();
  const value = raw ? JSON.parse(raw) : null;
  assert.ok(!value?.errorType, 'Lambda invocation failed: ' + value?.errorMessage);
  return value;
}

function gateway(path, headers, method='GET', body) {
  return invoke({version:'2.0', rawPath:path, rawQueryString:'', headers,
    requestContext:{domainName:'company.example.com', http:{sourceIp:'192.0.2.1',method}},
    body, isBase64Encoded:false});
}

async function postMessage(text, requestId) {
  const response = await gateway('/api/agents/ceo/messages', {
    ...auth, 'content-type':'application/json', 'x-requested-with':'owner-console',
  }, 'POST', JSON.stringify({text, requestId}));
  assert.equal(response.statusCode, 202, response.body);
  return JSON.parse(response.body).message.id;
}

async function messages() {
  const response = await gateway('/api/agents/ceo/messages', auth);
  assert.equal(response.statusCode, 200, response.body);
  return JSON.parse(response.body).messages;
}

async function fixtures() {
  const {hashPassword} = await import('./src/auth.mjs');
  const verifier = {username:'owner', passwordHash:await hashPassword(password)};
  createServer((req,res) => {
    if (req.url === '/v4/employee/task') {
      res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({TaskARN:taskArn})); return;
    }
    if (req.headers['x-amz-target'] !== 'secretsmanager.GetSecretValue') { res.writeHead(404).end(); return; }
    res.writeHead(200,{'Content-Type':'application/x-amz-json-1.1'}).end(JSON.stringify({SecretString:JSON.stringify(verifier)}));
  }).listen(8099,'127.0.0.1');
}

async function store() {
  const {createCloudStore} = await import('./src/cloud-store.mjs');
  return createCloudStore({tableName,resident:true});
}

async function setup() {
  const {DynamoDBClient, CreateTableCommand, ListTablesCommand} = await import('@aws-sdk/client-dynamodb');
  const db = new DynamoDBClient({maxAttempts:1});
  try {
    await eventually(() => db.send(new ListTablesCommand({})));
    await db.send(new CreateTableCommand({TableName:tableName, BillingMode:'PAY_PER_REQUEST',
      AttributeDefinitions:[{AttributeName:'pk',AttributeType:'S'},{AttributeName:'sk',AttributeType:'S'}],
      KeySchema:[{AttributeName:'pk',KeyType:'HASH'},{AttributeName:'sk',KeyType:'RANGE'}]}));
  } finally { db.destroy(); }
  const challenge = await eventually(async () => {
    const result = await gateway('/chat',{}); assert.equal(result.statusCode,401); return result;
  });
  assert.match(challenge.headers['www-authenticate'], /^Basic /);
  assert.match((await gateway('/chat',auth)).body, /Company workspace/);
  assert.match((await gateway('/chat.js',auth)).body, /messages\.post/);
  const {createFactoryState} = await import('./src/factory-state.mjs');
  await createFactoryState({tableName}).configure({stackId:'image-smoke',requestId:'image-setup',enabled:true,
    deployment:{revision:'image-v1'},employeeLimit:2,create:true});
  const dbStore = await store();
  await dbStore.ensureCEO();
  const ceo = await dbStore.employee('ceo');
  await dbStore.bindEmployeeTask({agentId:'ceo', generation:ceo.generation, taskArn});
  await dbStore.hireEmployee({callerId:'owner',name:'Image verifier',handle:'image-verifier',role:'Engineer',
    requestId:'image-create-verifier',assignment:'Verify the HTTP handoff.'});
  const directory = JSON.parse((await gateway('/api/directory',auth)).body);
  assert.equal(directory.mode,'bedrock');
  assert.ok(directory.agents.some(a=>a.id==='ceo'));
  const first = await postMessage('remember ' + note, 'image-remember');
  assert.equal(await postMessage('remember ' + note, 'image-remember'), first);
  console.log(ceo.generation);
}

async function native() {
  assert.ok(process.getuid() > 0,'Fargate employee must run as nonroot');
  const systemBundle = '/etc/ssl/certs/ca-certificates.crt';
  assert.equal(statSync(systemBundle).mode & 0o777, 0o644);
  assert.equal(readFileSync(systemBundle, 'utf8'), rootCertificates.join('\n') + '\n');
  const {chromium} = await import('playwright-core');
  assert.equal(typeof chromium.connectOverCDP,'function');
  assert.match(execFileSync('node',['node_modules/@openai/codex/bin/codex.js','--version'],{encoding:'utf8'}), /codex/);
}

async function secondMessage() {
  await eventually(async () => {
    const rows = await messages();
    assert.deepEqual(rows.map(row=>row.author), ['owner','agent']);
    assert.equal(rows[1].text, 'Remembered: ' + note);
  });
  await postMessage('recall preview', 'image-recall');
}

async function verify() {
  const rows = await eventually(async () => {
    const history = await messages();
    assert.deepEqual(history.map(row=>row.author), ['owner','agent','owner','agent']);
    assert.match(history[3].text, /Include a preview URL in handoffs/);
    return history;
  });
  const memory = JSON.parse((await gateway('/api/agents/ceo/memory',auth)).body);
  assert.equal(memory.memories.length,1);
  assert.equal(memory.memories[0].text,note);
  assert.equal(memory.memories[0].sourceMessageId,rows[0].id);
  const dbStore = await store();
  assert.equal((await dbStore.employee('ceo')).taskArn, taskArn);
  const pulse = await dbStore.getPulse('ceo');
  assert.equal(pulse.generation,(await dbStore.employee('ceo')).generation);
}

async function pause() {
  const dbStore = await store();
  await dbStore.setEmployeeState({callerId:'owner', agentId:'ceo', desiredState:'paused', requestId:'image-pause'});
}

async function goals() {
  // A second resident in this image uses the production pulse and DynamoDB store.
  // Only the model response is supplied here. The helper can inspect both checkpoints.
  const {runResident} = await import('./src/resident.mjs');
  const {createCloudStore} = await import('./src/cloud-store.mjs');
  const startedAt = Date.now();
  let time = startedAt;
  const now = () => time;
  const db = createCloudStore({tableName,resident:true,now});
  const employee = (await db.listEmployees()).find(row=>row.handle === 'image-verifier');
  assert.ok(employee);
  const binding = {agentId:employee.id,generation:employee.generation,taskArn:taskArn.replace(/a{32}$/,'b'.repeat(32))};
  assert.equal(await db.bindEmployeeTask(binding),true);
  const controller = new AbortController();
  let decisions = 0, nextAssigned = false;
  await runResident({binding,store:db,now,signal:controller.signal,
    decide:async context=>{
      decisions++;
      if (context.goal.text === 'Verify the updated preview.') return {action:'finish',value:'The update is ready.'};
      if (!context.goal.progress.length) return {action:'work',value:'HTTP preview verified.'};
      assert.deepEqual(context.goal.progress,['HTTP preview verified.']);
      return {action:'finish',value:'The preview is ready.'};
    },
    wait:async ()=>{
      // Observe the worker between actual pulses, then add the next assignment after it finishes.
      const rows = await db.listGoals(employee.id);
      if (decisions === 1) assert.match(rows[0].checkpoint,/HTTP preview verified/);
      if (!nextAssigned && rows[0].status === 'done') {
        await db.assignGoal(employee.id,'Verify the updated preview.','second-image-goal');
        nextAssigned = true;
      } else if (rows.length === 2 && rows.every(row=>row.status === 'done')) controller.abort();
      time += 31_000;
      if (time > startedAt + 6 * 31_000) throw new Error('Resident did not complete both goals');
    }});
  assert.equal(decisions,3);
  const completed = await db.listGoals(employee.id);
  assert.equal(completed.length,2);
  assert.ok(completed.every(goal=>goal.status === 'done'));
}

async function factory() {
  // Replay a stale ARN from before the CEO's pause. A new launch is unnecessary.
  await eventually(() => invoke({source:'aws.ecs',detail:{clusterArn:'arn:aws:ecs:us-east-1:111111111111:cluster/resident',
    group:'employee-ceo',lastStatus:'STOPPED',taskArn:taskArn.replace(/a{32}$/,'e'.repeat(32))}}));
}
async function owner() {
  const response = await eventually(() => invoke({operation:'unknown',requestId:'test-invalid-operation',agentId:'ceo'}));
  assert.equal(response.ok,false);
}
async function manager() {
  const response = await eventually(() => invoke({operation:'hire',callerId:'ceo',taskArn,generation:1,
    capability:'invalid',requestId:'test-invalid-hire',role:'Engineer',assignment:'Check a public dataset.'}));
  assert.equal(response.ok,false);
}
async function mail() {
  const topicArn = 'arn:aws:sns:us-east-1:111111111111:test-mail';
  const to = 'ceo@company.example.com';
  const rawMessage = 'From: reader@example.test\r\nTo: ' + to + '\r\nSubject: Follow-up\r\n\r\nHello Mara.';
  const payload = {notificationType:'Received',mail:{messageId:'image-follow-up',source:'reader@example.test'},
    receipt:{recipients:[to],spamVerdict:{status:'PASS'},virusVerdict:{status:'PASS'}},content:Buffer.from(rawMessage).toString('base64')};
  const event = {Records:[{EventSource:'aws:sns',Sns:{TopicArn:topicArn,Message:JSON.stringify(payload)}}]};
  assert.deepEqual(await eventually(() => invoke(event)),{delivered:1,ignored:0});
}
const phases = {fixtures, setup, native, secondMessage, verify, pause, goals, factory, owner, manager, mail};
if (!Object.hasOwn(phases, phase)) throw new Error('Unknown image smoke phase');
await phases[phase]();
