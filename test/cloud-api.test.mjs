import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createCloudHandler, handler } from '../src/cloud-api.mjs';
import { createStore } from '../src/store.mjs';
import { hashPassword } from '../src/auth.mjs';

const domain = 'owner.example.test';
const origin = 'https://' + domain;
const password = 'synthetic owner password for gateway tests';
const credential = { username: 'owner', passwordHash: await hashPassword(password) };
const basic = password => 'Basic ' + Buffer.from('owner:' + password).toString('base64');
const authorized = { authorization: basic(password) };

function event(rawPath, { method = 'GET', headers = {}, sourceIp = '192.0.2.50', domainName = domain, body,
  encoded = false, query = '' } = {}) {
  return { version: '2.0', routeKey: '$default', rawPath, rawQueryString: query, headers: { host: domainName, ...headers },
    requestContext: { http: { method, path: rawPath, protocol: 'HTTP/1.1', sourceIp, userAgent: 'fixture' },
      domainName, requestId: 'gateway-request-id', stage: '$default' },
    ...(body !== undefined ? { body: encoded ? Buffer.from(body).toString('base64') : body, isBase64Encoded: encoded } : {}) };
}

test('only health is public and owner authentication protects the packaged chat assets and all API paths', async () => {
  let reads = 0;
  const api = createCloudHandler({ store: { directory: async () => [{ id: 'ceo', name: 'Mara' }] },
    publicOrigin: origin, readOwner: async () => { reads++; return credential; } });
  assert.deepEqual(JSON.parse((await api(event('/healthz'))).body), { ok: true });
  assert.equal(reads, 0);
  for (const path of ['/chat', '/chat.js', '/chat.css', '/api/directory', '/unlisted']) {
    const denied = await api(event(path));
    assert.equal(denied.statusCode, 401);
    assert.match(denied.headers['www-authenticate'], /Basic realm=/);
  }
  assert.equal(reads, 0, 'anonymous requests should reach the Basic challenge without a paid secret read');
  const html = await api(event('/chat', { headers: authorized }));
  assert.equal(reads, 1);
  assert.equal(html.statusCode, 200);
  assert.equal(html.isBase64Encoded, false);
  assert.match(html.body, /id="composer"/);
  const scripts = [...html.body.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(match => match[1]);
  assert.ok(scripts.includes('/workspace.js'));
  for (const script of scripts) {
    assert.equal((await api(event(script))).statusCode, 401, script);
    const asset = await api(event(script, { headers: authorized }));
    assert.equal(asset.statusCode, 200, script);
    assert.match(asset.headers['content-type'], /^text\/javascript\b/);
    assert.ok(asset.body.length > 0, script);
  }
  assert.match(html.headers['content-security-policy'], /frame-ancestors 'none'/);
  const head = await api(event('/chat.css', { method: 'HEAD', headers: authorized }));
  assert.equal(head.statusCode, 200);
  assert.equal(head.body, '');
  assert.ok(Number(head.headers['content-length']) > 0);
  assert.deepEqual(JSON.parse((await api(event('/api/directory', { headers: authorized }))).body),
    { agents: [{ id: 'ceo', name: 'Mara' }], mode: 'bedrock' });
  assert.equal((await api(event('/chat', { headers: { ...authorized, host: 'attacker.example' } }))).statusCode, 403);
  assert.equal((await api(event('/chat', { domainName: 'attacker.example', headers: { 'x-forwarded-host': domain, ...authorized } }))).statusCode, 403);
  assert.equal((await api({ version: '1.0' })).statusCode, 403);
});

test('Gateway JSON and base64 requests follow the local message and memory contracts through an async store', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'perottino-gateway-'));
  const local = createStore(dir);
  t.after(async () => { local.close(); await rm(dir, { force: true, recursive: true }); });
  const store = Object.fromEntries(['directory', 'getAgent', 'messages', 'getMemories', 'enqueue', 'changeMemory']
    .map(method => [method, async (...args) => local[method](...args)]));
  const api = createCloudHandler({ store, readOwner: async () => credential });
  const headers = { ...authorized, 'content-type': 'application/json', origin };
  const path = '/api/agents/ceo/messages';
  const body = JSON.stringify({ text: 'remember Hand off on Friday', requestId: 'memo-1' });
  assert.equal((await api(event(path, { method: 'POST', headers: { ...headers, origin: 'https://other.test' }, body }))).statusCode, 403);
  assert.equal((await api(event(path, { method: 'POST', headers: { ...headers, 'content-type': 'text/plain' }, body }))).statusCode, 415);
  assert.equal((await api(event(path, { method: 'POST', headers, body: 'x'.repeat(100000) }))).statusCode, 413);
  const submit = () => api(event(path, { method: 'POST', headers, body, encoded: true }));
  const first = await submit();
  assert.equal(first.statusCode, 202);
  assert.deepEqual(JSON.parse((await submit()).body), JSON.parse(first.body));
  const conflicting = await api(event(path, { method: 'POST', headers, body: JSON.stringify({ text: 'other', requestId: 'memo-1' }) }));
  assert.equal(conflicting.statusCode, 409);
  const job = local.claim(30000);
  const note = { id: 'note-1', text: 'Hand off on Friday', sourceMessageId: job.message.id, createdAt: job.message.createdAt };
  local.complete(job, 'Saved', [note]);
  const memory = '/api/agents/ceo/memory';
  const edit = await api(event(memory + '/note-1', { method: 'PATCH', headers,
    body: JSON.stringify({ text: 'Hand off on Monday', requestId: 'fix-1' }) }));
  assert.equal(edit.statusCode, 200);
  const { memories } = JSON.parse((await api(event(memory, { headers: authorized }))).body);
  assert.equal(memories[0].sourceMessageId, JSON.parse(first.body).message.id);
  assert.equal(memories[0].text, 'Hand off on Monday');
  const del = event(memory + '/note-1', { method: 'DELETE', headers, body: JSON.stringify({ requestId: 'forget-1' }) });
  assert.equal((await api(del)).statusCode, 200);
  assert.equal((await api(del)).statusCode, 200);
  assert.deepEqual(JSON.parse((await api(event(memory, { headers: authorized }))).body), { memories: [] });
  assert.equal(JSON.parse((await api(event(path, { headers: authorized }))).body).messages.length, 2);
});

test('owner rotation refreshes the verifier and read failures fail closed without revealing provider details', async () => {
  let clock = 1;
  let current = credential;
  let reads = 0;
  const api = createCloudHandler({ store: { directory: async () => [] }, publicOrigin: origin,
    now: () => clock, readOwner: async () => {
      reads++;
      if (!current) throw new Error('sensitive provider information');
      return current;
    } });
  const login = (pass = password) => api(event('/api/directory', { headers: { authorization: basic(pass) } }));
  assert.equal((await login()).statusCode, 200);
  const next = 'changed synthetic password for gateway test';
  current = { username: 'owner', passwordHash: await hashPassword(next) };
  assert.equal((await login()).statusCode, 200);
  assert.equal(reads, 1);
  clock += 30_001;
  assert.equal((await login()).statusCode, 401);
  assert.equal((await login(next)).statusCode, 200);
  clock += 30_001;
  current = null;
  const unavailable = await login(next);
  assert.equal(unavailable.statusCode, 503);
  assert.doesNotMatch(unavailable.body, /sensitive/);
  assert.equal((await api(event('/healthz'))).statusCode, 200);
});

test('hosted reads return a single cursor page and resolve older sources directly without replaying history', async () => {
  const root = '/api/agents/ceo';
  const turnCursor = 'TURN#0000000000000003';
  const memoCursor = 'NOTE#example';
  const current = { id: 'newer', author: 'owner', text: 'This week', createdAt: '2026-11-26' };
  const earlier = { id: 'earlier', author: 'owner', text: 'Original source', createdAt: '2026-11-20' };
  const read = [];
  const store = {
    getAgent: async id => id === 'ceo' && { id: 'ceo' },
    async messagePage(id, cursor) {
      read.push(['messages', id, cursor]);
      if (cursor && cursor !== turnCursor) throw new RangeError();
      return cursor ? { messages: [earlier], status: 'idle' } : { messages: [current], status: 'idle', nextCursor: turnCursor };
    },
    async memoryPage(id, cursor) {
      read.push(['memory', id, cursor]);
      return cursor ? { memories: [] } : { memories: [{ id: 'm', sourceMessageId: 'earlier' }], nextCursor: memoCursor };
    },
    async messageSource(id, source) { read.push(['source', id, source]); return source === 'earlier' ? earlier : null; },
  };
  const handle = createCloudHandler({ store, readOwner: async () => credential });
  const get = (route, query) => handle(event(root + route, { query, headers: authorized }));
  const recent = JSON.parse((await get('/messages')).body);
  assert.deepEqual(recent.messages, [current]);
  assert.deepEqual(JSON.parse((await get('/messages', 'cursor=' + encodeURIComponent(recent.nextCursor))).body).messages, [earlier]);
  const notes = JSON.parse((await get('/memory')).body);
  assert.deepEqual(JSON.parse((await get('/memory', 'cursor=' + encodeURIComponent(notes.nextCursor))).body).memories, []);
  assert.deepEqual(JSON.parse((await get('/messages/' + notes.memories[0].sourceMessageId)).body), { message: earlier });
  assert.deepEqual(read, [['messages','ceo',undefined], ['messages','ceo',turnCursor], ['memory','ceo',undefined],
    ['memory','ceo',memoCursor], ['source','ceo','earlier']]);
  assert.equal((await get('/messages/missing')).statusCode, 404);
  assert.equal((await get('/messages', 'cursor=bogus')).statusCode, 400);
  assert.equal((await get('/memory', 'cursor=a&cursor=b')).statusCode, 400);
});

test('a response exceeding the synchronous Lambda envelope gets a bounded error', async () => {
  const store = { directory: async () => [{ name: '\\'.repeat(1_600_000) }] };
  const handle = createCloudHandler({ store, readOwner: async () => credential });
  const response = await handle(event('/api/directory', { headers: authorized }));
  assert.equal(response.statusCode, 502);
  assert.ok(response.body.length < 100);
});

test('authentication limits use the gateway source IP and discard caller forwarding headers', async () => {
  const api = createCloudHandler({ store: {}, readOwner: async () => credential });
  const wrong = { authorization: basic('wrong'), 'x-forwarded-proto': 'https', 'x-forwarded-for': '192.0.2.200' };
  for (let i = 0; i < 10; i++) {
    assert.equal((await api(event('/chat', { headers: { ...wrong, 'x-forwarded-for': '192.0.2.' + i } }))).statusCode, 401);
  }
  assert.equal((await api(event('/chat', { headers: wrong }))).statusCode, 429);
  assert.equal((await api(event('/chat', { headers: wrong, sourceIp: '192.0.2.100' }))).statusCode, 401);
});

test('production entry point loads the real adapter and fetches only the configured current owner secret', async t => {
  const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  const { DynamoDBDocumentClient } = await import('@aws-sdk/lib-dynamodb');
  const secret = 'arn:aws:secretsmanager:us-east-1:111111111111:secret:fixture-owner-abcdef';
  for (const [key, value] of Object.entries({ AWS_REGION: 'us-east-1', PUBLIC_ORIGIN: origin,
    PEROTTINO_STATE_TABLE: 'fixture-state', PEROTTINO_OWNER_SECRET_ARN: secret })) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  const get = t.mock.method(SecretsManagerClient.prototype, 'send', async command => {
    assert.ok(command instanceof GetSecretValueCommand);
    assert.deepEqual(command.input, { SecretId: secret, VersionStage: 'AWSCURRENT' });
    return { SecretString: JSON.stringify(credential) };
  });
  const db = t.mock.method(DynamoDBDocumentClient.prototype, 'send', () => { throw new Error('Unexpected table operation'); });
  assert.equal((await handler(event('/healthz'))).statusCode, 200);
  assert.equal(get.mock.callCount(), 0);
  assert.equal((await handler(event('/chat', { headers: authorized }))).statusCode, 200);
  assert.equal(get.mock.callCount(), 1);
  assert.equal(db.mock.callCount(), 0);
});

test('only the authenticated owner can send bounded lifecycle commands and assign goals', async () => {
  const calls = [];
  const person = { id:'ceo',name:'Mara',handle:'mara',role:'CEO',canHire:true,
    desiredState:'active',generation:2,taskGeneration:2,taskArn:'private-task-identifier',privateToken:'secret-test-value' };
  const goal = { id:'goal-1',text:'Inspect release',status:'ready',stepCount:0,checkpoint:'',privateLease:'do not expose'};
  const api = createCloudHandler({publicOrigin:origin, readOwner:async () => credential,
    ownerControl:async action => {
      calls.push(action);
      return action.operation === 'fire' ? {ok:false,status:409,code:'EMPLOYEE_STATE'} : {ok:true,employee:person};
    },
    store:{ getAgent:async id => id === person.id ? person : null, employee:async () => person,
      listGoals:async () => [goal], assignGoal:async () => ({goal,conflict:false}) }});
  const endpoint = name => '/api/agents/ceo/' + name;
  const body = JSON.stringify({requestId:'action-1',agentId:'other',actor:'admin',operation:'fire'});
  const request = (name, headers, content = body) => api(event(endpoint(name),{method:'POST',headers,body:content}));
  const headers = {...authorized,origin,'content-type':'application/json'};
  assert.equal((await request('lifecycle/pause',{origin,'content-type':'application/json'})).statusCode,401);
  assert.equal((await request('lifecycle/pause',{...headers,origin:'https://other.test'})).statusCode,403);
  assert.equal((await request('lifecycle/hire',headers)).statusCode,404);
  assert.equal((await request('goals',{...headers,origin:'https://other.test'})).statusCode,403);
  assert.deepEqual(calls,[]);
  const result = await request('lifecycle/pause',headers);
  assert.equal(result.statusCode,200);
  assert.deepEqual(calls,[{operation:'pause',agentId:'ceo',requestId:'action-1'}]);
  assert.doesNotMatch(result.body,/private-task|privateToken|secret-test-value/);
  const profile = await api(event(endpoint('employee'),{headers:authorized}));
  assert.equal(JSON.parse(profile.body).employee.runtimeStatus,'Task registered');
  assert.doesNotMatch(profile.body,/private-task|privateToken|privateLease/);
  const assignment = await request('goals',headers,JSON.stringify({requestId:'goal-1',text:'Inspect release'}));
  assert.equal(assignment.statusCode,202);
  assert.equal(JSON.parse(assignment.body).goal.id, goal.id);
  assert.equal((await request('lifecycle/fire',headers)).statusCode,409);
});
