// Executed in built images alongside a network-isolated DynamoDB Local database.
// The Secrets Manager wire response is a test fixture. An explicit owner command needs no inference.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

const phase = process.argv.at(-1);
const note = 'Include a preview URL in handoffs.';
const password = 'synthetic-image-test-verifier';
async function eventually(check) {
  let error;
  for (let i=0; i<80; i++) {
    try { return await check(); } catch (err) { error = err; }
    await sleep(250);
  }
  throw error;
}
async function invoke(event) {
  const response = await fetch('http://127.0.0.1:8080/2015-03-31/functions/function/invocations',
    {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(event)});
  assert.equal(response.status,200);
  const raw = await response.text();
  const value = raw ? JSON.parse(raw) : null;
  assert.ok(!value?.errorType,'Lambda invocation failed: ' + value?.errorMessage);
  return value;
}
const auth = {authorization:'Basic ' + Buffer.from('owner:' + password).toString('base64')};
function gateway(path, headers, method='GET', body) {
  return invoke({version:'2.0',rawPath:path,rawQueryString:'',headers,
    requestContext:{domainName:'company.example.com',http:{sourceIp:'192.0.2.1',method}},body,isBase64Encoded:false});
}
async function secretFixture() {
  const {hashPassword} = await import('./src/auth.mjs');
  const verifier = {username:'owner',passwordHash:await hashPassword(password)};
  createServer((req,res) => {
    if (req.headers['x-amz-target'] !== 'secretsmanager.GetSecretValue') { res.writeHead(400).end(); return; }
    res.writeHead(200,{'Content-Type':'application/x-amz-json-1.1'}).end(JSON.stringify({SecretString:JSON.stringify(verifier)}));
  }).listen(8099,'127.0.0.1');
}
async function setup() {
  const {DynamoDBClient,CreateTableCommand,ListTablesCommand,QueryCommand} = await import('@aws-sdk/client-dynamodb');
  const db = new DynamoDBClient({maxAttempts:1});
  await eventually(() => db.send(new ListTablesCommand({})));
  await db.send(new CreateTableCommand({TableName:'ImageSmoke',BillingMode:'PAY_PER_REQUEST',
    AttributeDefinitions:[{AttributeName:'pk',AttributeType:'S'},{AttributeName:'sk',AttributeType:'S'}],
    KeySchema:[{AttributeName:'pk',KeyType:'HASH'},{AttributeName:'sk',KeyType:'RANGE'}]}));
  const challenge = await eventually(async () => {
    const result = await gateway('/chat',{}); assert.equal(result.statusCode,401); return result;
  });
  assert.match(challenge.headers['www-authenticate'],/^Basic /);
  assert.match((await gateway('/chat',auth)).body,/Company chat/);
  assert.match((await gateway('/chat.js',auth)).body,/getElementById/);
  const directory = JSON.parse((await gateway('/api/directory',auth)).body);
  assert.equal(directory.mode,'bedrock');
  assert.ok(directory.agents.some(a=>a.id==='ceo'));
  const response = await gateway('/api/agents/ceo/messages',{...auth,'content-type':'application/json','x-requested-with':'owner-console'},
    'POST',JSON.stringify({text:'remember ' + note,requestId:'image-smoke-request'}));
  assert.equal(response.statusCode,202);
  const turnId = JSON.parse(response.body).message.id;
  const page = await db.send(new QueryCommand({TableName:'ImageSmoke',ConsistentRead:true,
    KeyConditionExpression:'pk = :agent AND begins_with(sk, :pending)',
    ExpressionAttributeValues:{':agent':{S:'AGENT#ceo'},':pending':{S:'PENDING#'}}}));
  assert.equal(page.Count,1);
  assert.equal(page.Items[0].jobId.S,turnId);
  console.log(JSON.stringify({turnId,marker:page.Items[0]}));
  db.destroy();
}
async function employee() {
  assert.ok(process.getuid() > 0,'Fargate job must run as nonroot');
  const {chromium} = await import('playwright-core');
  assert.equal(typeof chromium.connectOverCDP,'function');
  const {execFileSync} = await import('node:child_process');
  assert.match(execFileSync('node',['node_modules/@openai/codex/bin/codex.js','--version'],{encoding:'utf8'}), /codex/);
}
async function recover() {
  const messages = JSON.parse((await gateway('/api/agents/ceo/messages',auth)).body);
  assert.equal(messages.status,'idle');
  assert.deepEqual(messages.messages.map(m=>m.author),['owner','agent']);
  assert.match(messages.messages[1].text,/Remembered: Include a preview URL in handoffs/);
  const memory = JSON.parse((await gateway('/api/agents/ceo/memory',auth)).body);
  assert.equal(memory.memories.length,1);
  assert.equal(memory.memories[0].text,note);
  assert.equal(memory.memories[0].sourceMessageId,messages.messages[0].id);
}
async function dispatch() {
  let observed;
  const fixture = createServer(async (req,res) => {
    if (req.headers['x-amz-target'] !== 'AWSStepFunctions.StartExecution') { res.writeHead(400).end(); return; }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    observed = JSON.parse(Buffer.concat(chunks));
    res.writeHead(200,{'Content-Type':'application/x-amz-json-1.0'}).end(JSON.stringify({
      executionArn:'arn:aws:states:us-east-1:111111111111:execution:ImageSmoke:run',startDate:0
    }));
  });
  await new Promise(ready=>fixture.listen(8100,'127.0.0.1',ready));
  try {
    const event = {Records:[{eventSource:'aws:dynamodb',eventName:'INSERT',
      dynamodb:{SequenceNumber:'1',NewImage:JSON.parse(process.env.IMAGE_SMOKE_MARKER)}}]};
    assert.deepEqual(await eventually(()=>invoke(event)),{batchItemFailures:[]});
    assert.deepEqual(JSON.parse(observed.input),{agentId:'ceo',jobId:process.env.TURN_ID});
    assert.equal(observed.name,'turn-' + process.env.TURN_ID);
  } finally { await new Promise(done=>fixture.close(done)); }
}
if (phase === 'secret-fixture') await secretFixture();
else if (phase === 'api') await setup();
else if (phase === 'employee') await employee();
else if (phase === 'recover') await recover();
else if (phase === 'handler') await dispatch();
else if (phase === 'admit') assert.equal((await eventually(()=>invoke({agentId:'ceo',jobId:process.env.TURN_ID}))).status,'done');
else if (phase === 'terminal') await eventually(()=>invoke({agentId:'ceo',jobId:process.env.TURN_ID}));
else throw new Error('Unknown image smoke phase');
