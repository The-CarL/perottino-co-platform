// Runs inside the two release images. The test network contains only loopback.
// Only the broker fixture receives a table name and a reachable DynamoDB endpoint.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

const ownerArn = 'arn:aws:lambda:us-east-1:111111111111:function:test-owner';
const managerArn = 'arn:aws:lambda:us-east-1:111111111111:function:test-manager';
const taskArn = 'arn:aws:ecs:us-east-1:111111111111:task/resident/' + 'a'.repeat(32);
const capability = 'b'.repeat(64);
const password = 'synthetic-company-image-verifier';
const answer = 'Packaged broker verified this employee reply.';

async function eventually(check, timeoutMs = 65_000) {
  const end = Date.now() + timeoutMs;
  let error;
  do {
    try { return await check(); } catch (caught) { error = caught; }
    await sleep(250);
  } while (Date.now() < end);
  throw error;
}

async function broker() {
  const { DynamoDBClient, CreateTableCommand } = await import('@aws-sdk/client-dynamodb');
  const { createCloudStore } = await import('./src/cloud-store.mjs');
  const { createFactoryState } = await import('./src/factory-state.mjs');
  const { hashPassword } = await import('./src/auth.mjs');
  const factory = await import('./src/factory.mjs');
  const tableName = process.env.PEROTTINO_STATE_TABLE;
  const client = new DynamoDBClient({});
  await client.send(new CreateTableCommand({ TableName: tableName, BillingMode:'PAY_PER_REQUEST',
    AttributeDefinitions:[{AttributeName:'pk',AttributeType:'S'},{AttributeName:'sk',AttributeType:'S'}],
    KeySchema:[{AttributeName:'pk',KeyType:'HASH'},{AttributeName:'sk',KeyType:'RANGE'}] }));
  client.destroy();
  const state = createFactoryState({tableName}), store = createCloudStore({tableName,resident:true});
  const company = await state.configure({ stackId:'company-image',requestId:'setup',enabled:true,create:true,
    employeeLimit:2,deployment:{revision:'image'} });
  await store.ensureCEO();
  const { generation } = await store.employee('ceo');
  await store.bindEmployeeTask({agentId:'ceo',taskArn,generation});
  const lock = await state.lock('ceo',Date.now());
  assert.ok(await state.reserve('ceo',lock.lease,{ arn:taskArn,generation,capability,stage:'started',
    revision:'image',epoch:company.epoch },company,false));
  await state.unlock('ceo',lock.lease,false);
  const verifier = {username:'owner',passwordHash:await hashPassword(password)};
  const segments = [];
  function traceResult() {
    const work = segments.find(s => s.annotations.operation === 'work.process');
    const [link] = work?.metadata.perottino.links ?? [];
    return { count:segments.length,
      producer: Boolean(link && segments.some(s => s.name === 'factory' && s.id === link.span_id && s.trace_id === link.trace_id)),
      consumer: Boolean(work && segments.some(s => s.name === 'factory' && s.trace_id === work.trace_id && s.parent_id)),
      privateText: [answer,'Reply to the packaged smoke.',capability,password].some(value => JSON.stringify(segments).includes(value)) };
  }
  createServer(async (req,res) => {
    let data, status = 200;
    try {
      if (req.url === '/test-telemetry') data = traceResult();
      else if (req.url === '/TraceSegments') {
        assert.match(req.headers.authorization ?? '', /\/xray\/aws4_request/);
        const chunks = [];
        for await (const bytes of req) chunks.push(bytes);
        const packet = JSON.parse(Buffer.concat(chunks));
        assert.ok(packet.TraceSegmentDocuments.length <= 25);
        segments.push(...packet.TraceSegmentDocuments.map(JSON.parse));
        data = {UnprocessedTraceSegments:[]};
      }
      else if (req.url === '/test-pulse') data = { at: (await store.getPulse('ceo'))?.at ?? null };
      else if (req.url === '/v4/employee/task') data = {TaskARN:taskArn};
      else if (req.headers['x-amz-target'] === 'secretsmanager.GetSecretValue') data = {SecretString: JSON.stringify(verifier)};
      else {
        const match = /^\/2015-03-31\/functions\/([^/]+)\/invocations$/.exec(req.url);
        const name = match && decodeURIComponent(match[1]);
        assert.ok([ownerArn,managerArn].includes(name));
        assert.match(req.headers.authorization ?? '', /^AWS4-HMAC-SHA256 /);
        const chunks = [];
        for await (const bytes of req) chunks.push(bytes);
        const event = JSON.parse(Buffer.concat(chunks));
        data = await (name === ownerArn ? factory.owner(event) : factory.manager(event));
      }
    } catch { status = 500; data = { error:'Broker fixture failed' }; }
    res.writeHead(status,{'content-type':'application/json'}).end(JSON.stringify(data));
  }).listen(8098,'127.0.0.1');
}

async function api(op,input) {
  const event = {version:'2.0',rawPath:'/api/company/'+op,rawQueryString:'',
    headers:{authorization:'Basic '+Buffer.from('owner:'+password).toString('base64'),
      'content-type':'application/json','x-requested-with':'owner-console'},
    requestContext:{domainName:'company.example.com',http:{sourceIp:'192.0.2.1',method:'POST'}},
    body:JSON.stringify(input),isBase64Encoded:false};
  const r = await fetch('http://127.0.0.1:8080/2015-03-31/functions/function/invocations',
    {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(event)});
  const body = await r.json();
  assert.equal(body.statusCode,200,'Packaged API company command failed: '+op+' '+body.statusCode+' '+body.body);
  return JSON.parse(body.body);
}

async function apply() {
  assert.equal(process.env.PEROTTINO_STATE_TABLE,undefined);
  const { runCompanyPulse } = await import('./src/company-worker.mjs');
  const { companyCommand, readBinding } = await import('./src/resident.mjs');
  const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');
  const binding = await readBinding();
  const client = new LambdaClient({});
  try {
    const execute = companyCommand(binding, { client, InvokeCommand, functionName:managerArn, capability });
    const state = await runCompanyPulse({actor:{id:'ceo'},workerId:taskArn,execute,
      decide:async() => ({op:'reply',input:{text:answer}})});
    assert.equal(state,'worked');
    const { flushTelemetry } = await import('./src/telemetry.mjs');
    await flushTelemetry();
  } finally { client.destroy(); }
}

const phase = process.argv.at(-1);
if (phase === 'broker') await broker();
else if (phase === 'heartbeat') await eventually(async () => {
  const r = await fetch('http://127.0.0.1:8098/test-pulse');
  assert.ok((await r.json()).at);
  const counts = await (await fetch('http://127.0.0.1:8098/test-telemetry')).json();
  assert.equal(counts.count,0,'An idle employee emitted traces while polling or heartbeating');
});
else if (phase === 'apply') await apply();
else {
  assert.equal(process.env.PEROTTINO_STATE_TABLE,undefined);
  const {conversation} = await eventually(() => api('conversations.dm',{peerId:'ceo'}));
  if (phase === 'enqueue') await api('messages.post',{conversationId:conversation.id,text:'Reply to the packaged smoke.',requestId:'packaged-company-owner'});
  else if (phase === 'verify') {
    const {messages} = await api('messages.list',{conversationId:conversation.id});
    assert.ok(messages.some(m=>m.senderId==='ceo' && m.text===answer));
    const stats = await (await fetch('http://127.0.0.1:8098/test-telemetry')).json();
    assert.equal(stats.privateText,false,'Private input escaped into a trace');
    assert.ok(stats.producer,'Worker span must link to the broker that persisted its message');
    assert.ok(stats.consumer,'Worker actions must propagate their active trace back to the broker');
  } else throw new Error('Unknown company image probe');
}
