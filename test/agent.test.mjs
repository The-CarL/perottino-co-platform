import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createServer, request as localRequest } from 'node:http';
import { createHash, createHmac } from 'node:crypto';
import { Codex } from '@openai/codex-sdk';
import { createDecisionServer, runTurn, sdkDecision } from '../src/agent.mjs';

function employee() {
  const notes = [];
  return {
    agent: { name: 'Mara', role: 'CEO' }, history: [], memories: notes,
    async remember(text) { const note = { text }; notes.push(note); return note; },
    async recall(query) { return notes.filter(note => note.text.includes(query)); },
    async browse(url) { return { url, title: 'Waste reuse', text: 'Survey results.' }; },
  };
}
const message = (worker, text) => runTurn({ ...worker, message: { id: 'm1', text } });

test('local mode saves, retrieves, browses, and explains its supported commands', async t => {
  const previous = process.env.PEROTTINO_AGENT_MODE;
  process.env.PEROTTINO_AGENT_MODE = 'local';
  t.after(() => { if (previous === undefined) delete process.env.PEROTTINO_AGENT_MODE;
    else process.env.PEROTTINO_AGENT_MODE = previous; });
  const worker = employee();
  assert.match(await message(worker, 'hello'), /Mara.*CEO.*local mode/s);
  assert.match(await message(worker, 'remember the launch is Friday'), /Remembered: the launch is Friday/);
  assert.match(await message(worker, 'recall launch'), /the launch is Friday/);
  assert.match(await message(worker, 'recall missing'), /no notes matching/);
  assert.match(await message(worker, 'recall'), /launch is Friday/);
  assert.match(await message(worker, 'browse https://example.com'), /Waste reuse.*https:\/\/example.com.*Survey/s);
  assert.match(await message(worker, 'browse'), /Which page/);
  worker.browse = async () => { throw new Error('secret internal message'); };
  assert.doesNotMatch(await message(worker, 'browse https://example.org'), /secret/);
});

test('Bedrock transport authenticates and handles only validated scoped tool requests', async t => {
  const vars = ['PEROTTINO_AGENT_MODE', 'PEROTTINO_BEDROCK_WORKER_TOKEN', 'PEROTTINO_BEDROCK_WORKER_URL'];
  const previous = new Map(vars.map(key => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  process.env.PEROTTINO_AGENT_MODE = 'bedrock';
  process.env.PEROTTINO_BEDROCK_WORKER_TOKEN = 'x'.repeat(48);
  let calls = 0;
  const backend = createDecisionServer(async ctx => {
    calls++;
    if (ctx.message === 'invalid') return { action: 'exec', value: 'ignored' };
    if (!ctx.observations.length) return { action: 'remember', value: 'The draft is ready.' };
    assert.equal(ctx.observations[0].result, 'Remembered: The draft is ready.');
    return { action: 'reply', value: 'I saved the draft status.' };
  });
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  t.after(() => new Promise(resolve => backend.close(resolve)));
  const origin = 'http://127.0.0.1:' + backend.address().port;
  process.env.PEROTTINO_BEDROCK_WORKER_URL = origin;
  assert.equal((await fetch(origin + '/decision', { method: 'POST' })).status, 401);
  const worker = employee();
  assert.equal(await message(worker, 'Keep track of our draft'), 'I saved the draft status.');
  assert.deepEqual(worker.memories, [{ text: 'The draft is ready.' }]);
  assert.equal(calls, 2);
  await assert.rejects(message(worker, 'invalid'), /Bedrock worker/);
});

test('SDK worker restricts tool access to this run and excludes other job and application credentials', async () => {
  const ThreadStub = class {
    constructor(options) {
      assert.equal(options.config.default_permissions, 'decision');
      assert.equal(options.config.project_doc_max_bytes, 0);
      assert.deepEqual(options.config.permissions.decision.network, { enabled: false });
      assert.deepEqual(options.configOverrides, [
        'permissions.decision.filesystem={":root"="deny",":workspace_roots"="read"}',
      ]);
      assert.equal(options.config.model_provider, 'amazon-bedrock-runtime');
      assert.equal(options.env.PEROTTINO_BEDROCK_WORKER_TOKEN, undefined);
      assert.equal(options.env.OWNER_PASSWORD_HASH, undefined);
      assert.equal(options.env.OPENAI_API_KEY, undefined);
    }
    startThread(options) {
      // Legacy --sandbox or workspace-write network overrides can displace the named profile.
      assert.equal(options.sandboxMode, undefined);
      assert.equal(options.networkAccessEnabled, undefined);
      assert.equal(options.approvalPolicy, 'never');
      return { run: async () => ({ finalResponse: '{"action":"reply","value":"ready"}' }) };
    }
  };
  assert.deepEqual(await sdkDecision({ message: 'hello' }, undefined, ThreadStub),
    { action: 'reply', value: 'ready' });
});

const fixtureKey = 'AKIAXXXXXXXXXXXXXXXX';
const fixtureSecret = 'offline-fixture';
const fixtureToken = 'offline-session-token';

// Reconstruct the AWS signature at the receiving end. The native CLI signs
// the canonical regional host even though its immediate TCP peer is loopback.
function validateSignature(request, payload, region) {
  const credentials = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, *SignedHeaders=([^,]+), *Signature=([a-f0-9]{64})$/.exec(request.headers.authorization || '');
  assert.ok(credentials, 'Expected a complete native SigV4 authorization');
  const [, key, date, signedRegion, service, names, signature] = credentials;
  const hostname = 'bedrock-runtime.' + region + '.amazonaws.com';
  assert.equal(key, fixtureKey);
  assert.equal(signedRegion, region);
  assert.equal(service, 'bedrock');
  assert.equal(request.headers.host, hostname);
  assert.ok(names.split(';').includes('host'));
  assert.equal(request.headers['x-amz-security-token'], fixtureToken);
  const headers = names.split(';').map(name => name + ':' + request.headers[name].trim().replace(/\s+/g, ' ')).join('\n') + '\n';
  const sha = value => createHash('sha256').update(value).digest('hex');
  const canonical = [request.method, request.url, '', headers, names, sha(payload)].join('\n');
  const scope = [date, region, service, 'aws4_request'].join('/');
  const stringToSign = ['AWS4-HMAC-SHA256', request.headers['x-amz-date'], scope, sha(canonical)].join('\n');
  let signingKey = Buffer.from('AWS4' + fixtureSecret);
  for (const part of [date, region, service, 'aws4_request']) {
    signingKey = createHmac('sha256', signingKey).update(part).digest();
  }
  assert.equal(createHmac('sha256', signingKey).update(stringToSign).digest('hex'), signature);
}

test('the resident relay preserves the native Bedrock signature, zero-tool schema, and streamed reply', { timeout: 60_000 }, async t => {
  const reply = { action: 'reply', value: 'Offline fixture reply.' };
  const item = { type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: JSON.stringify(reply), annotations: [] }] };
  let request;
  const endpoint = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = Buffer.concat(chunks);
    const body = JSON.parse(payload);
    request = { incoming: req, payload, path: req.url, method: req.method,
      model: body.model, schema: body.text?.format?.schema, tools: body.tools };
    const response = { id: 'resp_fixture', object: 'response', model: body.model, status: 'completed', output: [item],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
    const events = [
      { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
      { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: JSON.stringify(reply) },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response },
    ];
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(events.map((event, i) => 'event: ' + event.type + '\ndata: ' +
      JSON.stringify({ ...event, sequence_number: i }) + '\n\n').join(''));
  });
  endpoint.listen(0, '127.0.0.1');
  await once(endpoint, 'listening');
  t.after(() => { endpoint.closeAllConnections(); return new Promise(resolve => endpoint.close(resolve)); });
  // The injected upstream transport delivers the relay's untouched HTTPS request
  // to the offline fixture. The app configures the native provider and its Host.
  let wireOptions, loopback;
  const upstream = (options, receive) => {
    wireOptions = options;
    return localRequest({ ...options, protocol: 'http:', hostname: '127.0.0.1', port: endpoint.address().port,
      agent: false }, receive);
  };
  class OfflineBedrock extends Codex {
    constructor(options) {
      loopback = options.config.model_providers['amazon-bedrock-runtime'].base_url;
      for (const key of Object.keys(options.env)) if (key.startsWith('AWS_CONTAINER_')) delete options.env[key];
      options.env.AWS_ACCESS_KEY_ID = fixtureKey;
      options.env.AWS_SECRET_ACCESS_KEY = fixtureSecret;
      options.env.AWS_SESSION_TOKEN = fixtureToken;
      options.env.AWS_EC2_METADATA_DISABLED = 'true';
      super(options);
    }
  }
  assert.deepEqual(await sdkDecision({ message: 'Return the fixture reply.' }, AbortSignal.timeout(45_000), OfflineBedrock,
    undefined, upstream), reply);
  const region = process.env.AWS_REGION || 'us-east-1';
  assert.equal(new URL(loopback).hostname, '127.0.0.1');
  await assert.rejects(fetch(loopback, { signal: AbortSignal.timeout(1000) }), /fetch failed/);
  assert.equal(wireOptions.hostname, 'bedrock-runtime.' + region + '.amazonaws.com');
  assert.equal(request.method, 'POST');
  assert.equal(request.path, '/openai/v1/responses');
  validateSignature(request.incoming, request.payload, region);
  assert.equal(request.model, process.env.PEROTTINO_BEDROCK_MODEL || 'us.openai.gpt-6-sol');
  assert.deepEqual(request.schema.required, ['action', 'value']);
  assert.deepEqual(request.tools, []);
});
