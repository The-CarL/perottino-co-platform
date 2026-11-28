import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import {once} from 'node:events';
import {createServer,request as localRequest} from 'node:http';
import test from 'node:test';
import {Codex} from '@openai/codex-sdk';
import {sdkDecision} from '../src/agent.mjs';
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
      model: body.model, schema: body.text?.format?.schema, effort:body.reasoning?.effort, tools: body.tools };
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
    {metered:true,requestUpstream:upstream,settings:{modelId:process.env.PEROTTINO_BEDROCK_MODEL||'us.openai.gpt-6-sol',reasoningEffort:'high'},
      schema:{type:'object',properties:{action:{type:'string'},value:{type:'string'}},required:['action','value'],additionalProperties:false},
      instructions:'Return the specified response.',validate:v=>v}), reply);
  const region = process.env.AWS_REGION || 'us-east-1';
  assert.equal(new URL(loopback).hostname, '127.0.0.1');
  await assert.rejects(fetch(loopback, { signal: AbortSignal.timeout(1000) }), /fetch failed/);
  assert.equal(wireOptions.hostname, 'bedrock-runtime.' + region + '.amazonaws.com');
  assert.equal(request.method, 'POST');
  assert.equal(request.path, '/openai/v1/responses');
  validateSignature(request.incoming, request.payload, region);
  assert.equal(request.model, process.env.PEROTTINO_BEDROCK_MODEL || 'us.openai.gpt-6-sol');
  assert.deepEqual(request.schema.required, ['action', 'value']);
  assert.deepEqual(request.tools, []);assert.equal(request.effort,'high');
});
